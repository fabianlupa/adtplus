/**
 * Last-resort ADT REST client (docs/decisions/002-rest-fallbacks.md). Only for rows
 * docs/known-issues.md lists as REST fallback: package create/edit/validate/
 * delete and transport release. Every capability result built on it carries
 * `via: "rest-fallback"`.
 *
 * One instance is one SAP security session: a cookie jar, a CSRF token, and
 * (for `onprem`) Basic credentials sent on every request. Stateful work
 * (lock → op → unlock) runs serialized through `stateful()`, because the lock
 * handle lives in the server-side session the jar points at and the daemon
 * handles requests concurrently.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type RestAuth =
  | { kind: 'basic'; user: string; password: string }
  /** Session cookie only, minted from a redeemed reentrance ticket (`cloud-erp`). */
  | { kind: 'cookie' };

export interface RawAdtOptions {
  /** API host base URL, e.g. https://my000000-api.s4hana.cloud.sap */
  baseUrl: string;
  client: string;
  /** Sent as `sap-language` on every request: without it SAP answers in the user's default language. */
  language?: string;
  auth: RestAuth;
}

export interface RawAdtResponse {
  status: number;
  headers: Headers;
  body: string;
}

export interface RequestOptions {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  /** Send X-sap-adt-sessiontype: stateful (lock/PUT/DELETE/unlock). */
  stateful?: boolean;
  /** `sap-language` for this request instead of the session's logon language. */
  language?: string;
  /** A POST that changes nothing on SAP (a validation, a lock, a query): not a write for `trackWrites`. */
  changesNothing?: boolean;
  /** Backend requests this one stands for in the rate limit: an OData `$batch` counts each operation. Default 1. */
  units?: number;
  /** Time for SAP's whole answer, headers and body, from the moment the request is sent. Default the call's (`withTimeout`), else `REST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * A REST request's time for SAP's whole answer. Without one only undici's defaults (300 s each for
 * headers and body) end a hanging request, which holds a rate-limit slot all the while. One limit
 * covers the whole request: its CSRF fetch, the request, and its retry after a CSRF rejection.
 * adt+'s longest commands take under a minute. A system sets its own with `restTimeout`.
 */
export const REST_TIMEOUT_MS = 120_000;

/** A request that may change something on SAP: anything but a read. */
const isMutating = (method: string) => method !== 'GET' && method !== 'HEAD';

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

/**
 * SAP didn't answer a REST request in time and it was given up. Not a `RawAdtError`: SAP didn't
 * say how it went. `status` is set when the status line came and the body didn't.
 */
export class RawAdtTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
    readonly status?: number,
    /** SAP has likely stopped answering (`withTimeout`): a loop over objects ends the call. */
    readonly endsLoop = false,
  ) {
    const head = status === undefined
      ? `${method} ${path} got no answer from SAP within ${duration(timeoutMs)}`
      : `${method} ${path} answered HTTP ${status}, but the rest of the answer didn't come within ${duration(timeoutMs)}`;
    super(
      `${head} and was given up` +
        (status === undefined && isMutating(method) ? '; whether SAP did it is unknown, so read the current state before trying again' : '') +
        (endsLoop ? '; no request of this command got an answer during this wait or the one just before it, so SAP has likely stopped answering' : ''),
    );
    this.name = 'RawAdtTimeoutError';
  }

  /** The request was a write SAP may have done: no answer, or a 2xx one whose body didn't come. */
  get mayHaveWritten(): boolean {
    return isMutating(this.method) && (this.status === undefined || (this.status >= 200 && this.status < 300));
  }
}

/** A timeout that ends a loop over objects as a throttle does (`RawAdtTimeoutError.endsLoop`). */
export const endsLoop = (err: unknown): boolean => err instanceof RawAdtTimeoutError && err.endsLoop;

/** One request's time limit, shared by every fetch it makes (CSRF token, the request, its retry). */
interface Deadline {
  signal: AbortSignal;
  timeoutMs: number;
  /** When the request began (`Date.now()`). */
  started: number;
  /** Stops the timer once the answer is read. */
  clear(): void;
}

function deadline(timeoutMs: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, timeoutMs, started: Date.now(), clear: () => clearTimeout(timer) };
}

/**
 * `fetch` under `limit`, the body read too. `onResponse` sees the response before its body is
 * read. A timeout throws `RawAdtTimeoutError`, with the status when the status line had come.
 */
async function fetchText(
  url: string,
  init: RequestInit & { method?: string },
  limit: Deadline,
  onResponse?: (res: Response) => void,
): Promise<{ res: Response; body: string }> {
  let status: number | undefined;
  try {
    const res = await fetch(url, { ...init, signal: limit.signal });
    status = res.status;
    answered();
    onResponse?.(res);
    return { res, body: await res.text() };
  } catch (err) {
    if (limit.signal.aborted) {
      throw new RawAdtTimeoutError(init.method ?? 'GET', new URL(url).pathname, limit.timeoutMs, status, status === undefined && quietTimeout(limit.started));
    }
    throw err;
  }
}

/** `fn` under a fresh deadline of `timeoutMs`, its timer cleared afterwards. */
async function within<T>(timeoutMs: number, fn: (limit: Deadline) => Promise<T>): Promise<T> {
  const limit = deadline(timeoutMs);
  try {
    return await fn(limit);
  } finally {
    limit.clear();
  }
}

/** Runs each request under a rate limit and sees each response (daemon/ratelimit.ts). */
export interface RequestLimit {
  run<T>(fn: () => Promise<T>, units?: number): Promise<T>;
  observe(status: number, retryAfter: string | null): void;
}

/**
 * `sap-language` and `sap-client` come from the session (`url()` sets them last): one in the
 * caller's query or path would be overwritten, or sent twice in another case. Refused before
 * anything is sent.
 */
function assertNoSessionParams(path: string, query: Record<string, string> = {}): void {
  const keys = [...Object.keys(query), ...new URLSearchParams(path.split('?')[1] ?? '').keys()].map((k) => k.toLowerCase());
  if (keys.includes('sap-language')) throw new Error(`"sap-language" isn't a query parameter: pass RequestOptions.language (${path})`);
  if (keys.includes('sap-client')) throw new Error(`"sap-client" isn't a query parameter: it is the session's client (${path})`);
}

/** An ADT REST call that came back ≥ 400, with SAP's exception parsed out. */
export class RawAdtError extends Error {
  constructor(
    readonly status: number,
    readonly exceptionType: string | undefined,
    readonly sapMessage: string | undefined,
    context: string,
  ) {
    super(
      `${context} failed (HTTP ${status}${exceptionType ? ` ${exceptionType}` : ''})` +
        (sapMessage ? `: ${sapMessage}` : ''),
    );
    this.name = 'RawAdtError';
  }

  get isAuthFailure(): boolean {
    return this.status === 401;
  }
}

/** Pull `type id` and the (localized) message out of an `exc:exception` body. */
export function parseAdtException(body: string): { type?: string; message?: string } {
  const type = body.match(/<type id="([^"]*)"/)?.[1];
  const message =
    body.match(/<localizedMessage[^>]*>([\s\S]*?)<\/localizedMessage>/)?.[1] ??
    body.match(/<message[^>]*>([\s\S]*?)<\/message>/)?.[1];
  return { type, message: message === undefined ? undefined : decodeXml(message.trim()) };
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`);
}

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Start tags of element `name`; SAP leaves `>` unescaped in attribute values, so quoted values are skipped whole. */
export function startTags(name: string): RegExp {
  return new RegExp(`<${name}\\b(?:[^>"]|"[^"]*")*>`, 'g');
}

/** Attribute `name` (with its prefix) of one start tag, decoded; undefined when it has none. */
export function xmlAttr(tag: string, name: string): string | undefined {
  const value = tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

/** The rate limit of the call a request runs in (`withLimit`). */
const limits = new AsyncLocalStorage<RequestLimit>();

/**
 * Run `fn` with every `request` it makes under `limit`. Scoped to the call, not the client: one
 * REST session serves commands under different limits at once (projects with their own
 * `rateLimit`), and each must count against its own. Logon and discovery calls stay outside it.
 */
export function withLimit<T>(limit: RequestLimit, fn: () => Promise<T>): Promise<T> {
  return limits.run(limit, fn);
}

/**
 * Run `fn` outside any REST call's limit and write log. For what outlives the call, such as an
 * adt-ls session it opens: that session's logon callbacks would otherwise count against the
 * call's limit and mark its finished log.
 */
export function outsideRestCall<T>(fn: () => Promise<T>): Promise<T> {
  return limits.exit(() => writeLogs.exit(() => timeouts.exit(fn)));
}

/**
 * A command's REST requests (`withTimeout`): their time limit, and whether SAP still answers. A
 * timeout is "quiet" when no request of the command got an answer (a status line) while it waited.
 */
interface TimeoutScope {
  timeoutMs?: number;
  /** When a request of the command last got an answer; none yet: -Infinity. */
  lastAnswer: number;
  /** When the last quiet timeout came, unless an answer came after it. */
  lastQuiet?: number;
}

/**
 * Time between one request of a loop giving up and the next one starting (the catch, a note, a
 * saved index): a quiet timeout within it of a request's start follows on from that request.
 */
const QUIET_GAP_MS = 5_000;

const timeouts = new AsyncLocalStorage<TimeoutScope>();

/**
 * Run `fn`, a daemon command, with every `request` it makes limited to `timeoutMs` (the system's
 * `restTimeout`; a request's own `timeoutMs` wins, none means `REST_TIMEOUT_MS`). Scoped to the
 * command, as `withLimit` is to a call: one REST session serves commands whose project configs may
 * set different limits.
 *
 * The scope also tells a stuck object from SAP not answering. A quiet timeout ends a loop over
 * objects (`endsLoop`) when another quiet one came while it waited or just before it started: SAP
 * then answered nothing for two waits in a row, one after another (a sequential loop) or at once
 * (requests in flight together). An answer to any request in between, or a quiet timeout long
 * before (an object far back in a pull), says that object hangs, not SAP. adt-ls calls don't count:
 * only REST answers do.
 */
export function withTimeout<T>(timeoutMs: number | undefined, fn: () => Promise<T>): Promise<T> {
  return timeouts.run({ timeoutMs, lastAnswer: -Infinity }, fn);
}

/** A request of the command got an answer: SAP still answers. */
function answered(): void {
  const scope = timeouts.getStore();
  if (scope) {
    scope.lastAnswer = Date.now();
    scope.lastQuiet = undefined;
  }
}

/** A request begun at `started` timed out: true when SAP has likely stopped answering (see `withTimeout`). */
function quietTimeout(started: number): boolean {
  const scope = timeouts.getStore();
  // An answer in the same millisecond the request began counts as one during its wait.
  if (!scope || scope.lastAnswer >= started) return false;
  const ends = scope.lastQuiet !== undefined && scope.lastQuiet >= started - QUIET_GAP_MS;
  scope.lastQuiet = Date.now();
  return ends;
}

/** Each enclosing `trackWrites` call's log; a nested one is marked too. */
const writeLogs = new AsyncLocalStorage<Array<{ wrote: boolean }>>();

/**
 * Run `fn` and report whether any write it sent was done on SAP (a non-GET request answered with
 * 2xx, unless it says it changes nothing; a redirect, such as to a logon page, did nothing). The session manager re-runs a call after a 401 only when nothing was
 * written: re-running a create → read-back would create twice.
 */
export async function trackWrites<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T; wrote: boolean } | { ok: false; error: unknown; wrote: boolean }> {
  const log = { wrote: false };
  try {
    const value = await writeLogs.run([...(writeLogs.getStore() ?? []), log], fn);
    return { ok: true, value, wrote: log.wrote };
  } catch (error) {
    return { ok: false, error, wrote: log.wrote };
  }
}

/** Record a write that reached SAP in every enclosing `trackWrites`. */
export function markWrite(): void {
  for (const log of writeLogs.getStore() ?? []) log.wrote = true;
}

export class RawAdtClient {
  private readonly cookies = new Map<string, string>();
  private csrfToken: string | undefined;
  private statefulQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: RawAdtOptions) {}

  get authKind(): RestAuth['kind'] {
    return this.opts.auth.kind;
  }

  /** The session's logon language (`sap-language`), if one is set. */
  get language(): string | undefined {
    return this.opts.language;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** Seed the jar from a redeem response (see core/reentrance.ts). */
  absorbCookies(headers: Headers): void {
    for (const raw of headers.getSetCookie()) {
      const pair = raw.split(';')[0]!;
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair);
    }
  }

  setCsrfToken(token: string | undefined): void {
    this.csrfToken = token && token !== 'Required' && token !== 'Fetch' ? token : undefined;
  }

  cookieHeader(): string {
    return [...this.cookies.values()].join('; ');
  }

  private url(path: string, query: Record<string, string> = {}, language = this.opts.language): string {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set('sap-client', this.opts.client);
    if (language) url.searchParams.set('sap-language', language);
    return url.toString();
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'X-sap-client': this.opts.client };
    const { auth } = this.opts;
    if (auth.kind === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
    }
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  /**
   * One request, no auth retry: a 401 surfaces as RawAdtError with
   * `isAuthFailure` (`onprem` must never re-send a rejected password — ADR-001
   * finding 3; `cloud-erp` re-logon is the session manager's call, not ours).
   * Only a CSRF rejection (403 + `x-csrf-token: Required`) is retried once
   * with a fresh token.
   */
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<RawAdtResponse> {
    assertNoSessionParams(path, opts.query);
    const limit = limits.getStore();
    if (!limit) return this.send(method, path, opts);
    return limit.run(async () => {
      const res = await this.send(method, path, opts);
      limit.observe(res.status, res.headers.get('retry-after'));
      return res;
    }, opts.units ?? 1);
  }

  private send(method: string, path: string, opts: RequestOptions): Promise<RawAdtResponse> {
    const mutating = isMutating(method);
    const counts = mutating && !opts.changesNothing;
    return within(opts.timeoutMs ?? timeouts.getStore()?.timeoutMs ?? REST_TIMEOUT_MS, async (limit) => {
      const send = async (): Promise<{ res: Response; body: string }> => {
        // Token first: fetching it can set the session cookie this request must carry.
        const csrf = mutating ? await this.csrf(limit) : undefined;
        const headers: Record<string, string> = { Accept: '*/*', ...this.baseHeaders(), ...opts.headers };
        if (opts.stateful) headers['X-sap-adt-sessiontype'] = 'stateful';
        if (csrf) headers['X-CSRF-Token'] = csrf;
        try {
          // A 2xx status line says the write was done, even if its body never comes.
          const answer = await fetchText(this.url(path, opts.query, opts.language), { method, headers, body: opts.body, redirect: 'manual' }, limit, (res) => {
            this.absorbCookies(res.headers);
            if (counts && res.status >= 200 && res.status < 300) markWrite();
          });
          return answer;
        } catch (err) {
          // A write that may have been done counts as one: the session manager must not send it again.
          if (counts && err instanceof RawAdtTimeoutError && err.mayHaveWritten) markWrite();
          throw err;
        }
      };

      let answer = await send();
      if (mutating && answer.res.status === 403 && answer.res.headers.get('x-csrf-token')?.toLowerCase() === 'required') {
        this.csrfToken = undefined;
        answer = await send();
      }
      return { status: answer.res.status, headers: answer.res.headers, body: answer.body };
    });
  }

  /** `request` that throws RawAdtError on ≥ 400. */
  async expectOk(method: string, path: string, context: string, opts: RequestOptions = {}): Promise<RawAdtResponse> {
    const res = await this.request(method, path, opts);
    if (res.status >= 400) {
      const { type, message } = parseAdtException(res.body);
      throw new RawAdtError(res.status, type, message ?? res.body.slice(0, 300), context);
    }
    return res;
  }

  /** The session's CSRF token, fetched under `limit` (the request's deadline) when there's none yet. */
  async csrf(limit?: Deadline): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const fetchToken = (l: Deadline) =>
      fetchText(
        this.url('/sap/bc/adt/core/discovery'),
        { headers: { ...this.baseHeaders(), 'X-CSRF-Token': 'Fetch', Accept: 'application/atomsvc+xml' }, redirect: 'manual' },
        l,
      );
    const { res } = await (limit ? fetchToken(limit) : within(REST_TIMEOUT_MS, fetchToken));
    this.absorbCookies(res.headers);
    if (res.status >= 400) throw new RawAdtError(res.status, undefined, undefined, 'CSRF token fetch');
    this.setCsrfToken(res.headers.get('x-csrf-token') ?? undefined);
    if (!this.csrfToken) throw new RawAdtError(res.status, undefined, 'no usable x-csrf-token', 'CSRF token fetch');
    return this.csrfToken;
  }

  /**
   * Run a lock → op → unlock sequence alone on this session, then end its
   * server-side stateful context. Reusing the context is not safe: on `onprem` a
   * package PUT + UNLOCK still left the package enqueued in that context,
   * so a later DELETE in the same session failed with "Paket … ist bereits
   * gesperrt" while the same DELETE in a fresh context worked. A failure in
   * one sequence doesn't poison the queue for the next.
   */
  stateful<T>(fn: () => Promise<T>): Promise<T> {
    const sequence = async () => {
      try {
        return await fn();
      } finally {
        await this.endStatefulContext();
      }
    };
    const run = this.statefulQueue.then(sequence, sequence);
    this.statefulQueue = run.catch(() => undefined);
    return run;
  }

  /** Close the ADT stateful session (`sessiontype: stateless`) and forget its context cookie. */
  private async endStatefulContext(): Promise<void> {
    if (!this.cookies.has('sap-contextid')) return;
    await within(REST_TIMEOUT_MS, (limit) =>
      fetchText(
        this.url('/sap/bc/adt/core/discovery'),
        { headers: { ...this.baseHeaders(), 'X-sap-adt-sessiontype': 'stateless', Accept: 'application/atomsvc+xml' }, redirect: 'manual' },
        limit,
      ),
    ).catch(() => undefined);
    this.cookies.delete('sap-contextid');
  }

  /**
   * Ask the server for a fresh reentrance ticket using this session's
   * cookie, without a browser: the logon URL answers 307 → `redirect-url`
   * with `reentrance-ticket=` when the session is valid (verified live on
   * `cloud-erp`). Returns the redirect Location, or undefined
   * when the session is no longer good enough to mint one.
   */
  async mintReentranceRedirect(logonUrl: string): Promise<string | undefined> {
    const { res } = await within(REST_TIMEOUT_MS, (limit) => fetchText(logonUrl, { redirect: 'manual', headers: this.baseHeaders() }, limit));
    const location = res.headers.get('location') ?? undefined;
    return location && /[?&]reentrance-ticket=/.test(location) ? location : undefined;
  }
}
