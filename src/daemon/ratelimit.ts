import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-system rate limit on adt+'s calls to SAP: each SDK method call (`raw.lsp`
 * included) and each REST request (docs/decisions/005-api-policy-scope.md,
 * footprint). The budget counts estimated backend requests ("units",
 * docs/decisions/008-budget-in-backend-requests.md): a REST request is one, an
 * SDK call weighs what the probes traced for its method (`unitsOf`). adt-ls
 * reports no count of its own.
 *
 * - **Concurrency:** at most `concurrency` calls in flight; the rest wait in
 *   FIFO order. A call made inside another one (adt-ls's logon callback
 *   minting a ticket over REST) takes no second slot, so it cannot deadlock.
 * - **Budget:** units of the calls started in the last 60 s. Checked only
 *   when a command is admitted: an admitted command always finishes, and what
 *   it overshoots delays the next admission instead of leaving a write half
 *   done.
 * - **Cooldown:** a 429 or 503 from SAP stops everything, admissions and calls
 *   mid-command alike, until its `Retry-After` (30 s without one). Nothing is
 *   retried here.
 *
 * A refusal throws `ThrottledError`, which the daemon reports as
 * `{ok: false, throttled: true, retryAfterMs}` and never queues.
 *
 * **Bulk lane** (ADR-008): a mirror command runs inside `bulk`, and every call
 * it makes, adt-ls or REST, takes a slot of that lane instead: at most
 * `BulkCaps` calls in flight per channel, no budget, its units outside the
 * interactive window. The cooldown stops both lanes.
 */

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_PER_MINUTE = 600;
const WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 30_000;
/** Bulk calls in flight per system: `mirror.concurrency`'s default and ceiling (ADR-008). */
export const DEFAULT_BULK_CONCURRENCY = 3;
export const MAX_BULK_CONCURRENCY = 5;
/** adt-ls runs one call at a time per session: more bulk calls than this only queue (ADR-008). */
const MAX_BULK_ADT = 3;
/** Waiting calls allowed per concurrency slot before new commands are refused. */
const QUEUE_PER_SLOT = 4;
/**
 * An adt-ls error carries SAP's HTTP status only in its text, e.g. "failed:
 * HTTP/1.1 500 Internal Server Error". Best effort, not seen live for 429/503;
 * a bare number is not enough, since messages carry line numbers too.
 */
const OVERLOAD_TEXT = /\bHTTP(?:\/[\d.]+)?\s+(?:429|503)\b|Too Many Requests|Service Unavailable/i;

/** What an SDK method weighs when no probe has traced it (ADR-008). */
export const DEFAULT_UNITS = 3;
const ACTIVATE_UNITS_PER_OBJECT = 3;

/** Traced backend requests per SDK call, `<namespace>.<method>` (ADR-008). */
const METHOD_UNITS = new Map<string, number>([
  ['repository.abapStat', 0],
  ['repository.search', 1],
  ['repository.getLsUri', 1],
  ['repository.readDirectory', 1],
  ['lifecycle.resolveAffUri', 2],
  ['repository.readFile', 2],
  ['source.read', 2],
  ['lifecycle.update', 6],
  ['repository.writeFile', 6],
  ['lifecycle.create', 6],
]);

/** The same for `raw.lsp`, by LSP method. */
const LSP_UNITS = new Map<string, number>([
  ['adtLs/fileSystem/abapStat', 0],
  ['adtLs/fileSystem/getPackageName', 0],
  ['adtLs/fileSystem/getObjectName', 0],
  ['adtLs/fileSystem/stat', 1],
]);

/** Estimated backend requests of one SDK call: `adt.<namespace>.<method>(...args)`. */
export function unitsOf(namespace: PropertyKey, method: PropertyKey, args: unknown[]): number {
  if (namespace === 'raw' && method === 'lsp') {
    const lspMethod = args[0];
    if (lspMethod === 'adtLs/activation/activate') {
      const uris = (args[1] as { fileUris?: unknown } | undefined)?.fileUris;
      return ACTIVATE_UNITS_PER_OBJECT * (Array.isArray(uris) ? Math.max(1, uris.length) : 1);
    }
    return typeof lspMethod === 'string' ? (LSP_UNITS.get(lspMethod) ?? DEFAULT_UNITS) : DEFAULT_UNITS;
  }
  // The active read switches the served version and back: not traced.
  if (namespace === 'source' && method === 'read' && (args[0] as { version?: unknown } | undefined)?.version === 'active') {
    return DEFAULT_UNITS;
  }
  return METHOD_UNITS.get(`${String(namespace)}.${String(method)}`) ?? DEFAULT_UNITS;
}

export interface RateLimitConfig {
  concurrency?: number;
  perMinute?: number;
}

/** Which way a call reaches SAP: through adt-ls, or a REST request of adt+'s own. */
export type Channel = 'adt' | 'rest';

/** The bulk lane's calls in flight per channel (ADR-008). */
export type BulkCaps = Record<Channel, number>;

/** `mirror.concurrency` as the bulk lane's caps: REST in full, adt-ls at most `MAX_BULK_ADT`. */
export function bulkCaps(concurrency: number = DEFAULT_BULK_CONCURRENCY): BulkCaps {
  const rest = Math.max(1, Math.min(concurrency, MAX_BULK_CONCURRENCY));
  return { rest, adt: Math.min(rest, MAX_BULK_ADT) };
}

/** At most `size` holders at once; the rest wait in FIFO order. */
class Slots {
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  constructor(private size: number) {}

  /** A new size: a larger one lets waiters in now, a smaller one takes effect as holders leave. */
  resize(size: number): void {
    this.size = size;
    while (this.active < this.size && this.waiting.length > 0) {
      this.active += 1;
      this.waiting.shift()!();
    }
  }

  get queued(): number {
    return this.waiting.length;
  }

  async take(): Promise<void> {
    if (this.active < this.size) {
      this.active += 1;
      return;
    }
    // The releasing holder hands its slot over, so `active` stays as it is.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    // Shrunk below the holders: this slot goes, nobody takes it over.
    const next = this.active > this.size ? undefined : this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}

export class ThrottledError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = 'ThrottledError';
  }
}

/** `Retry-After` as seconds or an HTTP date → milliseconds from `now`, else undefined. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export class RateLimiter {
  readonly concurrency: number;
  readonly perMinute: number;
  private readonly now: () => number;
  private readonly inCall = new AsyncLocalStorage<true>();
  /** The bulk command's caps, while one runs (`bulk`). */
  private readonly inBulk = new AsyncLocalStorage<BulkCaps>();
  /** Calls started in the window, oldest first, with their units; `inWindow` is their sum. */
  private readonly started: Array<{ at: number; units: number }> = [];
  private inWindow = 0;
  private readonly slots: Slots;
  /** The bulk lane's slots per channel, sized by the latest bulk command's caps. */
  private readonly bulkSlots = new Map<Channel, Slots>();
  private cooldownUntil = 0;

  constructor(
    private readonly system: string,
    config: RateLimitConfig = {},
    now: () => number = Date.now,
  ) {
    this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
    this.perMinute = config.perMinute ?? DEFAULT_PER_MINUTE;
    this.now = now;
    this.slots = new Slots(this.concurrency);
  }

  private prune(): void {
    const cutoff = this.now() - WINDOW_MS;
    while (this.started.length > 0 && this.started[0]!.at <= cutoff) this.inWindow -= this.started.shift()!.units;
  }

  /** When the units in the window drop below `limit`, as calls age out. */
  private freesAt(limit: number): number {
    let remaining = this.inWindow;
    for (const { at, units } of this.started) {
      remaining -= units;
      if (remaining < limit) return at + WINDOW_MS;
    }
    return this.now();
  }

  private assertNoCooldown(): void {
    const left = this.cooldownUntil - this.now();
    if (left > 0) {
      throw new ThrottledError(
        `adt+ system "${this.system}": throttled — SAP asked adt+ to back off; retry in ${Math.ceil(left / 1000)} s`,
        left,
      );
    }
  }

  /** Refuse a new command now (throws `ThrottledError`) rather than queue it. */
  admit(): void {
    this.assertNoCooldown();
    this.prune();
    if (this.inWindow >= this.perMinute) {
      // With overshoot the window can hold more than the budget: wait until it is below again.
      const left = Math.max(1, this.freesAt(this.perMinute) - this.now());
      throw new ThrottledError(
        `adt+ system "${this.system}": throttled — ${this.inWindow} requests (estimated) in the last minute ` +
          `(budget ${this.perMinute}); retry in ${Math.ceil(left / 1000)} s`,
        left,
      );
    }
    if (this.slots.queued >= this.concurrency * QUEUE_PER_SLOT) {
      throw new ThrottledError(
        `adt+ system "${this.system}": throttled — ${this.slots.queued} calls already waiting; retry shortly`,
        1000,
      );
    }
  }

  /** Run a bulk command (ADR-008): every call `fn` makes runs in the bulk lane under `caps`. */
  bulk<T>(caps: BulkCaps, fn: () => Promise<T>): Promise<T> {
    return this.inBulk.run(caps, fn);
  }

  /**
   * Run `fn` outside any bulk command. For what outlives the command, such as the adt-ls
   * session it may open: a callback of that session (the logon's ticket minted over REST) would
   * otherwise run in the bulk lane for the session's life.
   */
  outsideBulk<T>(fn: () => Promise<T>): Promise<T> {
    return this.inBulk.exit(fn);
  }

  /** Record a SAP response that asks adt+ to back off. */
  observe(status: number, retryAfter?: string | null): void {
    if (status !== 429 && status !== 503) return;
    const ms = parseRetryAfter(retryAfter, this.now()) ?? DEFAULT_COOLDOWN_MS;
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + ms);
  }

  private observeError(err: unknown): void {
    const status = (err as { status?: unknown })?.status;
    if (typeof status === 'number') return this.observe(status);
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(OVERLOAD_TEXT);
    if (match) this.observe(/503|unavailable/i.test(match[0]) ? 503 : 429);
  }

  private bulkSlotsFor(channel: Channel, caps: BulkCaps): Slots {
    let slots = this.bulkSlots.get(channel);
    if (!slots) this.bulkSlots.set(channel, (slots = new Slots(caps[channel])));
    else slots.resize(caps[channel]);
    return slots;
  }

  /**
   * Run one call to SAP under the limit; it weighs `units` estimated backend requests. Inside
   * `bulk` it takes a slot of the bulk lane's `channel` and isn't counted in the window.
   */
  async run<T>(fn: () => Promise<T>, units = 1, channel: Channel = 'rest'): Promise<T> {
    this.assertNoCooldown();
    const nested = this.inCall.getStore() === true;
    const caps = this.inBulk.getStore();
    const slots = caps ? this.bulkSlotsFor(channel, caps) : this.slots;
    if (!nested) await slots.take();
    try {
      // A cooldown may have started while this call waited for its slot.
      this.assertNoCooldown();
      if (units > 0 && !caps) {
        this.started.push({ at: this.now(), units });
        this.inWindow += units;
      }
      return await this.inCall.run(true, fn);
    } catch (err) {
      if (!(err instanceof ThrottledError)) this.observeError(err);
      throw err;
    } finally {
      if (!nested) slots.release();
    }
  }
}

/**
 * The SDK client with every namespaced method (`adt.lifecycle.create`,
 * `adt.raw.lsp`, …) run through `limiter`, weighed by `unitsOf`. Top-level methods (`health`,
 * `dispose`) stay as they are: they don't reach SAP.
 */
export function limitAdt<T extends object>(adt: T, limiter: RateLimiter): T {
  const namespaces = new Map<PropertyKey, unknown>();
  return new Proxy(adt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (!value || typeof value !== 'object') return value;
      if (!namespaces.has(prop)) {
        namespaces.set(
          prop,
          new Proxy(value, {
            get(ns, key) {
              const member = Reflect.get(ns, key, ns);
              return typeof member === 'function'
                ? (...args: unknown[]) => limiter.run(() => member.apply(ns, args), unitsOf(prop, key, args), 'adt')
                : member;
            },
          }),
        );
      }
      return namespaces.get(prop);
    },
  });
}
