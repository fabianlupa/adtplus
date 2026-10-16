import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createAdtLs,
  custom,
  interactive,
  type AdtLsClient,
  type LogonHandlerRegistrar,
} from '@arc-mcp/adt-ls';
import { RawAdtClient, RawAdtError, trackWrites } from '../backends/rawadt.js';
import { probeNativeSupport, type NativeSupport } from './capabilities.js';
import type { Destination } from './destinations.js';
import { readKeychainSecret } from './keychain.js';
import { captureReentranceTicket, defaultReentranceUrl, redeemReentranceTicket } from './reentrance.js';

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', [url], (err) => (err ? reject(err) : resolve()));
  });
}

export type LogonKind = 'basic' | 'interactive';

export interface SessionInfo {
  system: string;
  destination: string;
  logonKind: LogonKind;
  connectedAt: string;
  lastUsedAt: string;
  /** adt-ls's own version from initialize, e.g. `1.1.2.202608131517`. */
  adtLsVersion?: string;
}

export interface SessionHandle {
  adt: AdtLsClient;
  info: SessionInfo;
  /** Filled lazily by SessionManager.nativeSupport(). */
  native?: NativeSupport;
}

export interface RestSessionInfo {
  system: string;
  kind: 'basic' | 'reentrance';
  connectedAt: string;
}

/**
 * Handed to providers so an interactive adt-ls logon can ride on the REST
 * session instead of opening its own browser window.
 */
export interface ConnectContext {
  rest(): Promise<RawAdtClient>;
  relogonRest(): Promise<RawAdtClient>;
}

export interface SessionProvider {
  readonly kind: LogonKind;
  connect(system: string, destination: Destination, ctx?: ConnectContext): Promise<AdtLsClient>;
}

function extractLogonUrl(params: unknown): string | undefined {
  return JSON.stringify(params).match(/https?:[^"\\]*reentranceticket[^"\\]*/i)?.[0];
}

/** TLS verification failures, where naming `extraCaCerts` is the useful hint. */
const CERT_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
]);

/**
 * Node's `fetch` reports every transport failure as a bare "fetch failed" and
 * hides the reason on `.cause`, so unwrap it — a logon that died on TLS must
 * say so.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as (Error & { code?: string }) | undefined;
  if (!cause?.code) return err.message;
  const hint = CERT_ERROR_CODES.has(cause.code)
    ? ' — this process does not trust the system\'s CA; check "extraCaCerts" in systems.json'
    : '';
  return `${err.message} (${cause.code}: ${cause.message})${hint}`;
}

/**
 * A logon handler runs detached from the connect promise: it answers adt-ls
 * synchronously and does its HTTP work in the background. If that work fails
 * and nobody says so, adt-ls simply waits for a ticket that will never arrive
 * and reports a generic "Waiting for user logon timed out" three minutes
 * later. Racing `connect()` against this gate turns that into the real cause,
 * immediately.
 */
interface LogonGate {
  readonly failed: Promise<never>;
  fail(context: string, cause: unknown): void;
}

function logonGate(): LogonGate {
  let reject!: (err: Error) => void;
  const failed = new Promise<never>((_resolve, rej) => {
    reject = rej;
  });
  // A failure arriving after connect() already won the race must not surface
  // as an unhandled rejection.
  failed.catch(() => undefined);
  return {
    failed,
    fail: (context, cause) => reject(new Error(`${context}: ${describeError(cause)}`, { cause })),
  };
}

/**
 * `onprem`: headless Basic-auth reentrance logon. Exactly one password attempt
 * per connect call (ADR-001 finding 3): a failed logon must not be retried
 * automatically, since it counts against the account's lock counter. The
 * SDK's `basic()` has no such guard and only logs a failed ticket GET, so
 * this stays a `custom()` handler. It appends `sap-client` itself, as
 * `basic()` has since 0.6.1: without it the ticket GET authenticates against
 * the default client and 401s (finding 1).
 */
export class AdtLsBasicProvider implements SessionProvider {
  readonly kind = 'basic' as const;

  async connect(system: string, destination: Destination): Promise<AdtLsClient> {
    if (!destination.user || !destination.keychainService) {
      throw new Error(`adt+ system "${system}": basic auth needs "user" and "keychainService"`);
    }
    const user = destination.user;
    const password = await readKeychainSecret(destination.keychainService);
    const client = destination.client;

    let tried = false;
    const gate = logonGate();
    const auth = custom((driver: LogonHandlerRegistrar) => {
      driver.setRequestHandler('adtLs/destinations/requestBrowserBasedLogon', (params) => {
        const logonUrl = extractLogonUrl(params);
        if (!logonUrl || tried) return false;
        tried = true;
        const url = new URL(logonUrl);
        url.searchParams.set('sap-client', client);
        const basicAuth = Buffer.from(`${user}:${password}`).toString('base64');
        void (async () => {
          const res = await fetch(url, {
            redirect: 'manual',
            headers: { Authorization: `Basic ${basicAuth}` },
          });
          const location = res.headers.get('location');
          if (!location) {
            throw new Error(
              res.status === 401
                ? `user "${user}" was rejected by client ${client} (HTTP 401). Not retried: ` +
                  're-sending a rejected password counts against the account lock counter ' +
                  '(ADR-001 finding 3)'
                : `reentrance-ticket request returned HTTP ${res.status} with no redirect`,
            );
          }
          await fetch(location.replace('localhost', '127.0.0.1'), { redirect: 'manual' });
        })().catch((err: unknown) => gate.fail(`adt+ ${system}: Basic reentrance logon failed`, err));
        return true;
      });
    });

    return Promise.race([
      createAdtLs({
        connection: {
          systemUrl: destination.systemUrl,
          client,
          language: logonLanguage(destination),
          extraCaCerts: destination.extraCaCerts,
        },
        auth,
        destinationId: `adtplus_${system}`,
        keepAlive: true,
      }),
      gate.failed,
    ]);
  }
}

/**
 * `cloud-erp` (and any interactive system): SSO via a single browser window.
 *
 * With a ConnectContext (the SessionManager always passes one), the browser
 * logon goes to adt+'s REST session, and adt-ls's own logon URL is then
 * redeemed headlessly with that session's cookie — one window for both
 * sessions, verified live on `cloud-erp`. If the REST
 * session can no longer mint a ticket, it re-logs on once (one window).
 * Without a context this falls back to the SDK's plain interactive logon.
 * `open` is macOS-only, matching this dev machine.
 */
export class AdtLsInteractiveProvider implements SessionProvider {
  readonly kind = 'interactive' as const;

  async connect(system: string, destination: Destination, ctx?: ConnectContext): Promise<AdtLsClient> {
    const gate = logonGate();
    const auth = ctx
      ? custom((driver: LogonHandlerRegistrar) => {
          driver.setRequestHandler('adtLs/destinations/requestBrowserBasedLogon', (params) => {
            const logonUrl = extractLogonUrl(params);
            if (!logonUrl) return false;
            void (async () => {
              let location = await (await ctx.rest()).mintReentranceRedirect(logonUrl);
              if (!location) location = await (await ctx.relogonRest()).mintReentranceRedirect(logonUrl);
              if (!location) throw new Error('REST session could not mint an adt-ls reentrance ticket');
              await fetch(location.replace('localhost', '127.0.0.1'), { redirect: 'manual' });
            })().catch((err: unknown) =>
              gate.fail(`adt+ ${system}: adt-ls logon via REST session failed`, err),
            );
            return true;
          });
        })
      : interactive({
          user: destination.user,
          openUrl: (url: string) => openBrowser(url),
        });

    return Promise.race([
      createAdtLs({
        connection: {
          systemUrl: destination.systemUrl,
          client: destination.client,
          language: logonLanguage(destination),
          extraCaCerts: destination.extraCaCerts,
        },
        auth,
        destinationId: `adtplus_${system}`,
        keepAlive: true,
      }),
      gate.failed,
    ]);
  }
}

/**
 * The logon language of both sessions: adt-ls's (the SDK's own default is EN) and REST's, which
 * without one answers in the user's default language and creates packages with that master
 * language.
 */
export function logonLanguage(destination: Pick<Destination, 'language'>): string {
  return (destination.language ?? 'EN').toUpperCase();
}

export function createSessionProvider(destination: Destination): SessionProvider {
  if (destination.auth === 'basic') return new AdtLsBasicProvider();
  return new AdtLsInteractiveProvider();
}

/**
 * Open the REST-fallback session for a system (ADR-001 `RestBasic` /
 * `RestReentrance`). Basic is lazy — no network until the first call, and
 * the rejected-password rule still holds: RawAdtClient never retries a 401.
 * Reentrance opens one browser window.
 */
export async function connectRest(destination: Destination): Promise<RawAdtClient> {
  if (destination.auth === 'basic') {
    if (!destination.user || !destination.keychainService) {
      throw new Error(`adt+ system "${destination.id}": basic auth needs "user" and "keychainService"`);
    }
    const password = await readKeychainSecret(destination.keychainService);
    return new RawAdtClient({
      baseUrl: destination.systemUrl,
      client: destination.client,
      language: logonLanguage(destination),
      auth: { kind: 'basic', user: destination.user, password },
    });
  }
  const ticket = await captureReentranceTicket({
    reentranceUrl: destination.reentranceUrl ?? defaultReentranceUrl(destination.systemUrl),
    openUrl: openBrowser,
  });
  return redeemReentranceTicket(destination.systemUrl, destination.client, ticket, logonLanguage(destination));
}

interface ManagedEntry {
  handle: SessionHandle | null;
  connecting: Promise<SessionHandle> | null;
}

interface RestEntry {
  client: RawAdtClient | null;
  info: RestSessionInfo | null;
  connecting: Promise<RawAdtClient> | null;
}

/**
 * The fields that decide which SAP session a destination gets: where it
 * connects, as whom, and trusting which CAs. Policy fields (allowlist, gates,
 * rate limit, vfsMount) don't, so a project config that only changes those
 * shares the session (docs/decisions/006-layered-config.md).
 */
export function connectionHash(destination: Destination): string {
  const { kind, auth, client, systemUrl, reentranceUrl, user, keychainService, extraCaCerts } = destination;
  return createHash('sha256')
    .update(JSON.stringify([kind, auth, client, systemUrl, reentranceUrl ?? null, user ?? null, keychainService ?? null, extraCaCerts, logonLanguage(destination)]))
    .digest('hex');
}

/** Added to a 401 that `withRest` doesn't retry because the call had written already. */
const NOT_REPEATED =
  ' — the REST session expired after this call had already written to SAP, so it was not repeated; check what it changed before running it again';

/**
 * Owns at most one live adt-ls session per connection for this process,
 * under a session key: the system id for the first connection seen under
 * that id, `<id>@<hash>` for another one (two customers' "dev", or a project
 * config that changes a connection field). Concurrent `get()` calls for the
 * same key share one in-flight connect. This is the object the daemon holds
 * for its lifetime (ADR-001).
 */
export class SessionManager {
  private readonly entries = new Map<string, ManagedEntry>();
  private readonly restEntries = new Map<string, RestEntry>();
  private readonly destinations = new Map<string, Destination>();
  private readonly keysByConnection = new Map<string, string>();

  constructor(
    destinations: Record<string, Destination> = {},
    private readonly providerFactory: (d: Destination) => SessionProvider = createSessionProvider,
    private readonly restFactory: (d: Destination) => Promise<RawAdtClient> = connectRest,
  ) {
    for (const [key, destination] of Object.entries(destinations)) {
      this.destinations.set(key, destination);
      this.keysByConnection.set(`${destination.id}\0${connectionHash(destination)}`, key);
    }
  }

  /** The session key for this destination, registering it on first sight. */
  register(destination: Destination): string {
    const hash = connectionHash(destination);
    const connection = `${destination.id}\0${hash}`;
    const known = this.keysByConnection.get(connection);
    if (known) return known;
    const key = this.destinations.has(destination.id) ? `${destination.id}@${hash.slice(0, 8)}` : destination.id;
    this.destinations.set(key, destination);
    this.keysByConnection.set(connection, key);
    return key;
  }

  private destination(key: string): Destination {
    const destination = this.destinations.get(key);
    if (!destination) throw new Error(`Unknown adt+ system "${key}"`);
    return destination;
  }

  /** Cached REST-fallback session state for one key, without connecting. */
  restStatus(key: string): RestSessionInfo | null {
    return this.restEntries.get(key)?.info ?? null;
  }

  /** Cached native-support probe result for one key, without connecting or probing. */
  nativeStatus(key: string): NativeSupport | null {
    return this.entries.get(key)?.handle?.native ?? null;
  }

  /** Cached REST-fallback session state, without connecting. */
  restStatusAll(): Record<string, RestSessionInfo | null> {
    return Object.fromEntries([...this.destinations.keys()].map((key) => [key, this.restStatus(key)]));
  }

  /** Cached native-support probe results, without connecting or probing. */
  nativeStatusAll(): Record<string, NativeSupport | null> {
    return Object.fromEntries([...this.destinations.keys()].map((key) => [key, this.nativeStatus(key)]));
  }

  /** Probe once per adt-ls session and cache it on the handle. */
  async nativeSupport(system: string): Promise<NativeSupport> {
    const handle = await this.get(system);
    handle.native ??= await probeNativeSupport(handle.adt);
    return handle.native;
  }

  /** Establish (or reuse) the REST-fallback session for `system`. */
  async getRest(system: string): Promise<RawAdtClient> {
    const destination = this.destination(system);
    const entry = this.restEntries.get(system) ?? { client: null, info: null, connecting: null };
    this.restEntries.set(system, entry);

    if (entry.client) return entry.client;
    if (entry.connecting) return entry.connecting;

    entry.connecting = (async () => {
      const client = await this.restFactory(destination);
      entry.client = client;
      entry.info = {
        system: destination.id,
        kind: client.authKind === 'basic' ? 'basic' : 'reentrance',
        connectedAt: new Date().toISOString(),
      };
      entry.connecting = null;
      return client;
    })();

    try {
      return await entry.connecting;
    } catch (err) {
      entry.connecting = null;
      throw err;
    }
  }

  /**
   * Drop the REST session and log on again. Only for reentrance sessions:
   * a basic session re-sending a rejected password would count against
   * the account's lock counter (ADR-001 finding 3).
   */
  async relogonRest(system: string): Promise<RawAdtClient> {
    const entry = this.restEntries.get(system);
    if (entry?.connecting) return entry.connecting;
    if (entry?.client?.authKind === 'basic') {
      throw new Error(`adt+ system "${system}": basic REST session is never re-logged on automatically`);
    }
    this.restEntries.delete(system);
    return this.getRest(system);
  }

  /**
   * Run a REST-fallback call. A 401 on a reentrance session means the session expired, so it
   * re-logs on (one browser window) and runs `fn` once more, but only when none of `fn`'s writes
   * had reached SAP yet: a create whose read-back got the 401 must not create again. Anything
   * else propagates.
   */
  async withRest<T>(system: string, fn: (rest: RawAdtClient) => Promise<T>): Promise<T> {
    const rest = await this.getRest(system);
    const run = await trackWrites(() => fn(rest));
    if (run.ok) return run.value;
    const err = run.error;
    if (!(err instanceof RawAdtError) || !err.isAuthFailure || rest.authKind === 'basic') throw err;
    if (run.wrote) {
      // The next call gets the 401 at its first request and re-logs on then. An outer withRest
      // sees the same error after an inner one said so.
      if (!err.message.endsWith(NOT_REPEATED)) err.message += NOT_REPEATED;
      throw err;
    }
    return fn(await this.relogonRest(system));
  }

  /** Report cached session state without connecting. */
  status(system: string): SessionInfo | null {
    return this.entries.get(system)?.handle?.info ?? null;
  }

  statusAll(): Record<string, SessionInfo | null> {
    return Object.fromEntries([...this.destinations.keys()].map((key) => [key, this.status(key)]));
  }

  /** Establish (or reuse) a session for `system`, a session key from the constructor or `register`. */
  async get(system: string): Promise<SessionHandle> {
    const destination = this.destination(system);

    const entry = this.entries.get(system) ?? { handle: null, connecting: null };
    this.entries.set(system, entry);

    if (entry.handle) {
      entry.handle.info.lastUsedAt = new Date().toISOString();
      return entry.handle;
    }
    if (entry.connecting) return entry.connecting;

    const provider = this.providerFactory(destination);
    const ctx: ConnectContext = {
      rest: () => this.getRest(system),
      relogonRest: () => this.relogonRest(system),
    };
    entry.connecting = (async () => {
      const adt = await provider.connect(destination.id, destination, ctx);
      const health = adt.health();
      const now = new Date().toISOString();
      const handle: SessionHandle = {
        adt,
        info: {
          system: destination.id,
          destination: health.destination,
          logonKind: provider.kind,
          connectedAt: now,
          lastUsedAt: now,
          ...(health.adtLsVersion ? { adtLsVersion: health.adtLsVersion } : {}),
        },
      };
      entry.handle = handle;
      entry.connecting = null;
      return handle;
    })();

    try {
      return await entry.connecting;
    } catch (err) {
      entry.connecting = null;
      throw err;
    }
  }

  /**
   * Dispose adt-ls sessions idle for longer than `maxIdleMs`. REST sessions
   * are only a cookie jar and stay cached: on `cloud-erp` a live one lets the next
   * adt-ls connect log on without a browser window, and an expired one is
   * re-logged on by withRest / the logon handler.
   */
  async disposeIdle(maxIdleMs: number): Promise<void> {
    const now = Date.now();
    for (const [system, entry] of this.entries) {
      if (!entry.handle) continue;
      const idleMs = now - Date.parse(entry.handle.info.lastUsedAt);
      if (idleMs > maxIdleMs) {
        await entry.handle.adt.dispose();
        this.entries.delete(system);
      }
    }
  }

  /** Dispose every live session (daemon shutdown). */
  async disposeAll(): Promise<void> {
    for (const [system, entry] of this.entries) {
      if (entry.handle) await entry.handle.adt.dispose();
      this.entries.delete(system);
    }
    this.restEntries.clear();
  }
}
