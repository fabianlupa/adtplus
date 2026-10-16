import { mkdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import * as navigateCapability from '../capabilities/navigate.js';
import * as checkrunCapability from '../capabilities/checkrun.js';
import { DATA_ELEMENT } from '../capabilities/dataelement.js';
import { DOMAIN } from '../capabilities/domain.js';
import { activateRest } from '../capabilities/rest-activation.js';
import * as formObjectCapability from '../capabilities/rest-form-object.js';
import * as messageClassCapability from '../capabilities/messageclass.js';
import * as objectCapability from '../capabilities/object.js';
import { assertConfirmed, assertObjectWritable, assertPublishServiceAllowed, assertRuntimeLogsAllowed, assertRunAllowed, assertTranslationsAllowed } from '../capabilities/policy.js';
import * as packageCapability from '../capabilities/package.js';
import * as propertiesCapability from '../capabilities/properties.js';
import * as qualityCapability from '../capabilities/quality.js';
import * as rapCapability from '../capabilities/rap.js';
import * as runCapability from '../capabilities/run.js';
import * as dataPreviewCapability from '../capabilities/datapreview.js';
import * as dumpsCapability from '../capabilities/dumps.js';
import * as formatCapability from '../capabilities/format.js';
import * as runtimeLogsCapability from '../capabilities/runtime-logs.js';
import * as transportCapability from '../capabilities/transport.js';
import * as transportDiffCapability from '../capabilities/transport-diff.js';
import * as translationsCapability from '../capabilities/translations.js';
import * as translationUpdateCapability from '../capabilities/translation-update.js';
import { resolveObject } from '../core/resolve.js';
import * as versionsCapability from '../capabilities/versions.js';
import * as mirrorPull from '../mirror/pull.js';
import { check as mirrorCheck } from '../mirror/check.js';
import { activateMirror } from '../mirror/activate.js';
import { newObject as mirrorNew } from '../mirror/new.js';
import { push as mirrorPush, type PushDeps } from '../mirror/push.js';
import { mirrorReadNote, mirrorRefusal } from '../mirror/held.js';
import { status as mirrorStatus } from '../mirror/status.js';
import { changes as mirrorChanges } from '../mirror/changes.js';
import { componentPackages } from '../mirror/component.js';
import { historyVersions, releasedRequests } from '../mirror/history.js';
import { walk } from '../mirror/walk.js';
import { readActiveIncludes } from '../core/active-source.js';
import { adtLsInfo, adtLsWarnings } from '../core/adtls-version.js';
import { installExtraCaCerts } from '../core/cacerts.js';
import { combineConfigs, type Destination, type LoadedConfig } from '../core/destinations.js';
import { lookupPackageChain } from '../core/placement.js';
import { createCallLog, resolveCallLog, type CallLogTarget } from './calllog.js';
import { createConfigResolver, staticResolver, type ConfigResolver } from './config.js';
import { denyRefusal, parseDenyList } from './deny.js';
import { currentIdentity, sameIdentity, type DaemonIdentity } from './identity.js';
import { ObjectLocks, objectKey } from './objectlock.js';
import { RateLimiter, ThrottledError, bulkCaps, limitAdt } from './ratelimit.js';
import { measureClock, type ClockRead } from '../core/clock.js';
import type { ObjectRef } from '@arc-mcp/adt-ls';
import { outsideRestCall, withLimit, withTimeout, type RawAdtClient } from '../backends/rawadt.js';
import type { ServiceCheck } from '../backends/odata-ui.js';
import { objectPlacement } from '../core/placement.js';
import type { NativeSupport } from '../core/capabilities.js';
import { isReadOnlyEnv, readOnlyRefusal } from './readonly.js';
import { SessionManager, logonLanguage } from '../core/session.js';
import {
  resolveSocketPath,
  type CheckTargets,
  type DaemonProgress,
  type DaemonRequest,
  type DaemonResponse,
  type NavigateLocator,
  type StatusResponse,
} from './protocol.js';

/** The types a batch check takes from a package: those with source the checks read. */
const CHECKABLE_TYPES = new Set(['CLAS', 'INTF', 'PROG', 'FUGR', 'DDLS', 'DCLS', 'DDLX', 'BDEF', 'SRVD', 'TABL']);

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;

/** A client's list of strings, anything else in it dropped; undefined when it sent no array. */
function stringsOf(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((o): o is string => typeof o === 'string') : undefined;
}

/** `{ [key]: list }` for a list the client sent, else nothing: spread into a call's input. */
function listField<K extends string>(key: K, v: unknown): { [P in K]?: string[] } {
  const list = stringsOf(v);
  return (list ? { [key]: list } : {}) as { [P in K]?: string[] };
}

export interface DaemonServerOptions {
  sessionManager: SessionManager;
  /** Resolves each request's systems from the user config and the client's
   * project configs (ADR-006). Defaults to a fixed `destinations`. */
  config?: ConfigResolver;
  /** A fixed set of systems when no `config` is given. Defaults to {} — fine
   * for tests that don't exercise commands on a system. */
  destinations?: Record<string, Destination>;
  socketPath?: string;
  /** Call log file and detail. Defaults to what ADTPLUS_LOG says (unset: metadata to the
   * default file); `null` means no log at all. */
  callLog?: CallLogTarget | null;
  /** Refuse every command but a read. Defaults to what ADTPLUS_READONLY says. */
  readOnly?: boolean;
  /** Command patterns to refuse. Defaults to what ADTPLUS_DENY says. */
  deny?: string[];
  idleTimeoutMs?: number;
  checkIntervalMs?: number;
  /** Testing seam: replaces Date.now(). */
  now?: () => number;
  /** Called when the daemon decides it's idle. Defaults to disposing
   * sessions, closing the socket, and exiting the process. */
  onIdleShutdown?: () => void | Promise<void>;
  /** What this daemon was started from. Defaults to the identity of the disk right now. */
  identity?: DaemonIdentity;
  /** Called once a daemon retired by `shutdown` has served its last open
   * connection. Defaults to disposing sessions and exiting the process. */
  onRetired?: () => void | Promise<void>;
  /** Testing seam: replaces the SDK's adt-ls discovery. */
  resolveAdtLsPath?: () => string;
}

export interface DaemonServer {
  readonly server: Server;
  readonly socketPath: string;
  /** Handle one already-framed request (exported for direct unit testing); progress, when asked for, to `onProgress`. */
  handleRequest(req: DaemonRequest, onProgress?: (p: DaemonProgress) => void): Promise<DaemonResponse>;
  /** Force an idle check now (exported for direct unit testing). */
  checkIdle(): Promise<boolean>;
  close(): Promise<void>;
}

/** How often a progress line goes out at most; a new stage or the last step goes out at once. */
const PROGRESS_MS = 250;

/** Progress lines on a client's connection, before its answer (`ProgressLine`). */
function progressWriter(socket: Socket): (p: DaemonProgress) => void {
  let last: { at: number; stage: string } | undefined;
  return (p) => {
    const at = Date.now();
    if (last && last.stage === p.stage && p.done < p.total && at - last.at < PROGRESS_MS) return;
    last = { at, stage: p.stage };
    if (!socket.destroyed) socket.write(`${JSON.stringify({ progress: p })}\n`);
  };
}

/** A form-based type served through `rest-form-object.ts`: its kind and its AFF JSON (properties.ts). */
interface RestForm<T extends formObjectCapability.FormObject> {
  kind: formObjectCapability.FormObjectKind<T>;
  /** What names the object in a delete's result: `domain`. */
  deleteKey: string;
  properties: (object: T) => Record<string, unknown>;
  create: (properties: Record<string, unknown> | undefined) => formObjectCapability.FormObjectContent<T>;
  update: (properties: Record<string, unknown>) => (current: T) => T;
}

const restForm = <T extends formObjectCapability.FormObject>(form: RestForm<T>) => form as unknown as RestForm<formObjectCapability.FormObject>;

/** One route per command for all of them; a type more is an entry here. */
const REST_FORMS = [
  restForm({
    kind: DOMAIN,
    deleteKey: 'domain',
    properties: propertiesCapability.domainProperties,
    create: propertiesCapability.domainCreate,
    update: propertiesCapability.domainUpdate,
  }),
  restForm({
    kind: DATA_ELEMENT,
    deleteKey: 'dataElement',
    properties: propertiesCapability.dataElementProperties,
    create: propertiesCapability.dataElementCreate,
    update: propertiesCapability.dataElementUpdate,
  }),
];

/** The REST form type of `objectType`, by the same rule as `formType`: every command routes alike. */
function restFormOf(objectType: string | undefined): RestForm<formObjectCapability.FormObject> | undefined {
  const type = objectType === undefined ? undefined : propertiesCapability.formType(objectType);
  return type && REST_FORMS.find((f) => f.kind.type === type);
}

/** A read or write of one as `object read` answers a form-based object: its `properties` (AFF JSON). */
function formObjectResult(
  form: RestForm<formObjectCapability.FormObject>,
  objectType: string,
  r: { object: formObjectCapability.FormObject; transport?: string | null; via: 'rest-fallback'; nativeAvailable: boolean | null },
): Record<string, unknown> {
  const o = r.object;
  return {
    name: o.name,
    objectType,
    package: o.package,
    version: o.version,
    properties: form.properties(o),
    ...(r.transport !== undefined ? { transport: r.transport } : {}),
    via: r.via,
    nativeAvailable: r.nativeAvailable,
  };
}

/** With no symbol and no full position, point at the object itself: its own name is the class/view-level symbol. */
function locatorOf(req: NavigateLocator & { ref: { name: string } }): NavigateLocator {
  const hasPosition = req.line !== undefined && req.character !== undefined;
  return {
    symbol: req.symbol ?? (hasPosition ? undefined : req.ref.name),
    line: req.line,
    character: req.character,
  };
}

export function createDaemonServer(opts: DaemonServerOptions): DaemonServer {
  const socketPath = opts.socketPath ?? resolveSocketPath();
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const { sessionManager } = opts;
  const resolver = opts.config ?? staticResolver(opts.destinations ?? {});
  const identity = opts.identity ?? currentIdentity();
  let retiring = false;

  let lastActivityAt = now();
  /** Requests running now: the daemon is never idle while one runs (a 35-minute pull was cut off, G5b). */
  let inFlight = 0;
  const callLog = createCallLog(opts.callLog === undefined ? resolveCallLog(process.env.ADTPLUS_LOG) : (opts.callLog ?? undefined));
  const readOnly = opts.readOnly ?? isReadOnlyEnv(process.env.ADTPLUS_READONLY);
  const deny = opts.deny ?? parseDenyList(process.env.ADTPLUS_DENY);

  /** What a command on one system runs with: its merged destination and its session key. */
  interface SystemContext {
    system: string;
    destination: Destination;
    /** SessionManager key: one per connection (session.ts connectionHash). */
    key: string;
    /** Project configs this system was merged from, for the call log. */
    projectFiles: string[];
  }

  /** One config per workspace folder, combined (core/destinations.ts combineConfigs). One at a time: each may show a dialog. */
  async function resolveSets(sets: string[][], system?: string): Promise<LoadedConfig> {
    const configs: LoadedConfig[] = [];
    for (const set of sets) configs.push(await resolver.resolve(set, system));
    return combineConfigs(configs);
  }

  /** Resolve `system` for a client's project configs; may show the approval dialog. */
  async function systemContext(system: string, sets: string[][]): Promise<SystemContext> {
    const config = await resolveSets(sets, system);
    const destination = config.destinations[system];
    if (!destination) {
      const reason = config.refused[system];
      throw new Error(reason ? `adt+ system "${system}" refused: ${reason}` : `Unknown adt+ system "${system}"`);
    }
    return { system, destination, key: sessionManager.register(destination), projectFiles: projectFilesOf(config, system) };
  }

  function projectFilesOf(config: LoadedConfig, system: string): string[] {
    const projects = new Set(config.layers.filter((l) => l.kind === 'project').map((l) => l.path));
    return [...new Set(Object.values(config.sources[system] ?? {}))].filter((f) => projects.has(f));
  }

  /**
   * Every repotree URI in a response, results and error texts alike, re-rooted onto the
   * system's `vfsMount`, so whatever adt+ hands out opens in VS Code like `resolve`'s URI.
   */
  function toVfs<T>(ctx: SystemContext, value: T): T {
    if (typeof value === 'string') return objectCapability.toVfsUri(value, `adtplus_${ctx.system}`, ctx.destination.vfsMount);
    if (Array.isArray(value)) return value.map((v) => toVfs(ctx, v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toVfs(ctx, v)])) as T;
    }
    return value;
  }

  const objectLocks = new ObjectLocks();

  const limiters = new Map<string, RateLimiter>();
  /**
   * The rate limiter (`ratelimit.ts`) of this connection and limit: systems that
   * share a session share its budget, unless a project config sets another limit.
   */
  function limiterFor(ctx: SystemContext): RateLimiter {
    const key = `${ctx.key}\0${JSON.stringify(ctx.destination.rateLimit ?? {})}`;
    let limiter = limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter(ctx.system, ctx.destination.rateLimit, now);
      limiters.set(key, limiter);
    }
    return limiter;
  }

  /** The system's adt-ls session, every SDK call counted against its rate limit. */
  async function session(ctx: SystemContext) {
    const limiter = limiterFor(ctx);
    // A session a bulk command opens serves every later command: it must not carry the bulk lane.
    const handle = await limiter.outsideBulk(() => outsideRestCall(() => sessionManager.get(ctx.key)));
    return { ...handle, adt: limitAdt(handle.adt, limiter) };
  }

  /** The bulk lane's caps on this system (ADR-008), from `mirror.concurrency`. */
  const capsOf = (ctx: SystemContext) => bulkCaps(ctx.destination.mirror?.concurrency);

  /** The system's `restTimeout` in ms; unset: the REST client's default. */
  function restTimeoutMs(ctx: SystemContext): number | undefined {
    return ctx.destination.restTimeout === undefined ? undefined : ctx.destination.restTimeout * 1000;
  }

  /** `sessionManager.withRest`, every REST request counted against the system's rate limit (its `restTimeout`: `handleOne`). */
  function withRest<T>(ctx: SystemContext, fn: (rest: RawAdtClient) => Promise<T>): Promise<T> {
    return sessionManager.withRest(ctx.key, (rest) => withLimit(limiterFor(ctx), () => fn(rest)));
  }

  /**
   * The system's clock (ADR-016), measured on the first call that reports a time. Kept an hour
   * when both scales measured, 5 minutes when one didn't for a reason that would repeat (a
   * refusal, no time in the answer), not at all after a passing failure (network, 5xx, a logon):
   * the next call measures again. Concurrent calls share one measurement; the rate limit's refusal
   * ends the call as any other request's would.
   */
  const clocks = new Map<string, { read: ClockRead; until: number } | { pending: Promise<ClockRead> }>();
  const CLOCK_TTL_MS = 60 * 60_000;
  const CLOCK_RETRY_MS = 5 * 60_000;
  async function clockOf(ctx: SystemContext): Promise<ClockRead> {
    const hit = clocks.get(ctx.key);
    if (hit && 'pending' in hit) return hit.pending;
    if (hit && Date.now() < hit.until) return hit.read;
    // Its own timeout scope: shared by concurrent calls, its timeouts are none of the starting call's.
    const pending = withTimeout(restTimeoutMs(ctx), () => withRest(ctx, (rest) => measureClock(rest, (err) => err instanceof ThrottledError))).then(({ clock, settled }) => {
      const whole = clock.localOffsetMinutes !== undefined && clock.feedOffsetMinutes !== undefined;
      if (whole || settled) clocks.set(ctx.key, { read: clock, until: Date.now() + (whole ? CLOCK_TTL_MS : CLOCK_RETRY_MS) });
      else clocks.delete(ctx.key);
      return clock;
    });
    clocks.set(ctx.key, { pending });
    try {
      return await pending;
    } catch (err) {
      clocks.delete(ctx.key);
      throw err;
    }
  }

  /** Per session key: the translation pairs adt+ left uploaded, not published (`translation-update.ts` `ownUploads`). */
  const translationUploads = new Map<string, Map<string, translationUpdateCapability.OwnUpload>>();
  function ownUploadsOf(ctx: SystemContext): Map<string, translationUpdateCapability.OwnUpload> {
    let uploads = translationUploads.get(ctx.key);
    if (!uploads) translationUploads.set(ctx.key, (uploads = new Map()));
    return uploads;
  }

  /** The last OData UI service check per session key (ADR-019 §6), for `system status`. */
  const serviceChecks = new Map<string, ServiceCheck>();

  /** The system's native-support probe, or undefined when it failed: only reported (ADR-002). */
  function nativeSupportOf(ctx: SystemContext): Promise<NativeSupport | undefined> {
    return Promise.resolve()
      .then(() => sessionManager.nativeSupport(ctx.key))
      .catch(() => undefined);
  }

  /** The project config paths a client sent, one list per workspace folder; anything malformed counts as none. */
  function projectSetsOf(req: DaemonRequest): string[][] {
    const strings = (v: unknown): string[] => stringsOf(v) ?? [];
    if (Array.isArray(req.projectConfigSets) && req.projectConfigSets.length > 0) return req.projectConfigSets.map(strings);
    return [strings(req.projectConfigs)];
  }

  /**
   * Commands the rate limit never refuses at the start: they don't call SAP, they
   * are the logon, or they run in the bulk lane (`BULK_CMDS`).
   */
  const UNLIMITED_CMDS = new Set<DaemonRequest['cmd']>([
    'ping',
    'shutdown',
    'system.status',
    'system.connect',
    'mirror.init',
    'mirror.pull',
    'mirror.changes',
    'swc.packages',
    'history.versions',
    'history.released',
    'mirror.check',
    'mirror.new',
    'mirror.push',
    'mirror.activate',
  ]);

  /** Commands whose calls run in the rate limit's bulk lane (ADR-008): the mirror's, the git helper's too. */
  const BULK_CMDS = new Set<DaemonRequest['cmd']>([
    'mirror.init',
    'mirror.pull',
    'mirror.changes',
    'swc.packages',
    'history.versions',
    'history.released',
    'mirror.push',
    'mirror.activate',
  ]);

  /**
   * The commands a mirror write runs underneath. `ADTPLUS_DENY` is checked against each of
   * them, not only against `mirror.push` (ADR-007 "Push" 2), before anything is written.
   */
  function mirrorWriteCmds(req: DaemonRequest): DaemonRequest['cmd'][] {
    if (req.cmd === 'mirror.activate') return ['object.activate'];
    if (req.cmd !== 'mirror.push' || req.dryRun) return [];
    return [
      'object.update',
      ...(req.activate === false ? [] : (['object.activate'] as const)),
      ...(req.transport ? (['transport.assign'] as const) : []),
    ];
  }

  /** What a mirror write runs with: the engine's deps, the gate's destination, and a call-log line per write. */
  async function pushDeps(ctx: SystemContext, req: DaemonRequest, patterns: string[], onProgress?: (p: DaemonProgress) => void): Promise<PushDeps> {
    const base = await mirrorDeps(ctx);
    return {
      ...base,
      ...(onProgress ? { progress: onProgress } : {}),
      destination: ctx.destination,
      // `object.create` only once the plan has new objects: a push of existing ones never creates.
      refusal: (cmd) => denyRefusal(cmd, patterns),
      recordsChanges: async (pkg) => (await withRest(ctx, (rest) => packageCapability.readPackageDefinition(rest, pkg)))?.recordChanges,
      logWrite: (cmd, params, error, ms) => {
        const at = now() - ms;
        callLog?.record(
          { cmd, system: ctx.system, client: req.client, ...params } as unknown as DaemonRequest,
          error === undefined ? { ok: true, result: null } : { ok: false, error },
          at,
          ms,
          ctx.projectFiles,
        );
      },
    };
  }

  /** What the mirror engine runs with on this system. */
  async function mirrorDeps(ctx: SystemContext): Promise<mirrorPull.MirrorDeps> {
    const handle = await session(ctx);
    return {
      adt: handle.adt,
      concurrency: capsOf(ctx).adt,
      // Shared: a concurrent `navigate.whereUsed` flips the served version only under an exclusive hold.
      hold: (ref, fn) => objectLocks.shared([objectKey(ctx.key, ref)], fn),
      adtLsVersion: handle.info.adtLsVersion,
      withRest: (fn) => withRest(ctx, fn),
    };
  }

  /**
   * The object keys a command holds shared (`objectlock.ts`). `navigate.whereUsed`
   * and `object.read` hold none: they take their object exclusively for an active
   * read themselves, and hold it shared for the rest.
   */
  function sharedKeys(req: DaemonRequest, ctx: SystemContext): string[] {
    if (req.cmd === 'navigate.whereUsed' || req.cmd === 'object.read') return [];
    if (req.cmd === 'object.deleteMessages') {
      return [objectKey(ctx.key, { name: req.name, objectType: 'MSAG/N' })];
    }
    const refs = 'refs' in req && Array.isArray(req.refs) ? req.refs : 'ref' in req && req.ref ? [req.ref] : [];
    return refs.map((ref) => objectKey(ctx.key, ref));
  }

  /**
   * A check's objects (`CheckTargets`): `single` for one `ref`, else the batch's
   * objects, a package's walked from the repotree. A package's objects take their
   * shared locks here, since `sharedKeys` can't know them before the walk.
   */
  async function checkTargets(
    ctx: SystemContext,
    req: CheckTargets,
  ): Promise<{ single: ObjectRef } | { batch: ObjectRef[]; hold: <T>(fn: () => Promise<T>) => Promise<T> }> {
    const given = [req.ref, req.refs, req.package].filter((t) => t !== undefined).length;
    if (given !== 1) throw new Error('give exactly one of "ref" (name + objectType), "refs" or "package"');
    if (req.ref) return { single: req.ref };
    if (req.refs) return { batch: req.refs, hold: (fn) => fn() };
    const { adt } = await session(ctx);
    // The walk counts every object; only the checkable ones count against the batch size.
    const maxObjects = ctx.destination.mirror?.maxObjects ?? mirrorPull.DEFAULT_MAX_OBJECTS;
    const walked = await walk(adt, [{ name: req.package!, subpackages: req.subpackages ?? false }], {
      maxObjects,
      concurrency: limiterFor(ctx).concurrency,
    });
    if (walked.missing.length > 0) throw new Error(`package ${req.package} not found on ${ctx.system}`);
    const refs = walked.objects.filter((o) => CHECKABLE_TYPES.has(o.type)).map((o) => ({ name: o.name, objectType: o.type }));
    if (walked.exceeded || refs.length > qualityCapability.MAX_BATCH_OBJECTS) {
      throw new Error(
        `package ${req.package} has ${walked.exceeded ? `over ${maxObjects} objects` : `${refs.length} objects to check`}; ` +
          `one call checks at most ${qualityCapability.MAX_BATCH_OBJECTS}. Pass "refs" in several calls, or a subpackage`,
      );
    }
    if (refs.length === 0) throw new Error(`package ${req.package} has no objects to check`);
    const keys = refs.map((ref) => objectKey(ctx.key, ref));
    return { batch: refs, hold: (fn) => objectLocks.shared(keys, fn) };
  }

  /** Every session runs the same binary, so any live session's version stands for all. */
  function currentAdtLs(sessions: Record<string, { adtLsVersion?: string } | null>) {
    const sessionVersion = Object.values(sessions).find((info) => info?.adtLsVersion)?.adtLsVersion;
    return adtLsInfo({ sessionVersion, resolvePath: opts.resolveAdtLsPath });
  }

  async function dispatch(req: DaemonRequest, context: SystemContext | undefined, onProgress?: (p: DaemonProgress) => void): Promise<DaemonResponse> {
    // Set for every command that names a system; the others don't read it.
    const ctx = context as SystemContext;
    switch (req.cmd) {
      case 'ping':
        return { ok: true, pong: true, identity, pid: process.pid };
      case 'shutdown':
        if (sameIdentity(identity, req.unless)) return { ok: true, shuttingDown: false };
        retire();
        return { ok: true, shuttingDown: true };
      case 'system.status': {
        // The systems this client sees; never asks for an approval.
        const sessions: StatusResponse['sessions'] = {};
        const restSessions: StatusResponse['restSessions'] = {};
        const native: StatusResponse['native'] = {};
        const clockStatus: StatusResponse['clocks'] = {};
        const serviceCheckStatus: NonNullable<StatusResponse['serviceChecks']> = {};
        let config: StatusResponse['config'];
        try {
          const loaded = await resolveSets(projectSetsOf(req));
          for (const [system, destination] of Object.entries(loaded.destinations)) {
            const key = sessionManager.register(destination);
            sessions[system] = sessionManager.status(key);
            restSessions[system] = sessionManager.restStatus(key);
            native[system] = sessionManager.nativeStatus(key);
            const known = clocks.get(key);
            clockStatus[system] = known && 'read' in known ? known.read : null;
            serviceCheckStatus[system] = serviceChecks.get(key) ?? null;
          }
          config = {
            files: loaded.layers.map((l) => ({ path: l.path, kind: l.kind, trusted: l.trusted })),
            refused: loaded.refused,
            projectFiles: Object.fromEntries(Object.keys(loaded.destinations).map((id) => [id, projectFilesOf(loaded, id)])),
          };
        } catch (err) {
          config = { files: [], refused: {}, projectFiles: {}, error: err instanceof Error ? err.message : String(err) };
        }
        const adtLs = currentAdtLs(sessions);
        const warnings = adtLsWarnings(adtLs);
        return {
          ok: true,
          readOnly,
          ...(deny.length > 0 ? { deny } : {}),
          sessions,
          clocks: clockStatus,
          serviceChecks: serviceCheckStatus,
          config,
          restSessions,
          native,
          adtLs,
          ...(warnings.length > 0 ? { warnings } : {}),
          uptimeMs: now() - startedAt,
          pid: process.pid,
          identity,
        };
      }
      case 'system.connect': {
        const handle = await sessionManager.get(ctx.key);
        const warnings = adtLsWarnings(currentAdtLs({ [req.system]: handle.info }));
        return { ok: true, session: handle.info, ...(warnings.length > 0 ? { warnings } : {}) };
      }

      case 'transport.list': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await transportCapability.list(adt, { query: req.query, limit: req.maxResults }),
        };
      }
      case 'transport.find': {
        const { adt } = await session(ctx);
        const input = { objectName: req.ref.name, objectType: req.ref.objectType, developmentPackage: req.package, isCreation: req.isCreation };
        return { ok: true, result: await transportCapability.find(adt, input) };
      }
      case 'transport.check': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await transportCapability.check(adt, {
            ...req.ref,
            operation: req.operation,
            transportLayer: req.transportLayer,
            recordChanges: req.recordChanges,
          }),
        };
      }
      case 'transport.read': {
        await session(ctx);
        const [support, clock] = await Promise.all([nativeSupportOf(ctx), clockOf(ctx)]);
        const native = support?.transportContents ?? null;
        return { ok: true, result: await withRest(ctx, (rest) => transportDiffCapability.read(rest, req.transport, native, clock)) };
      }
      case 'transport.diff': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await transportDiffCapability.diff(
            { adt, withRest: (fn) => withRest(ctx, fn) },
            { transport: req.transport, cursor: req.cursor, pageSize: req.pageSize },
          ),
        };
      }
      case 'transport.create': {
        const { adt } = await session(ctx);
        const destination = ctx.destination;
        const input = {
          objectName: req.ref.name,
          objectType: req.ref.objectType,
          developmentPackage: req.package,
          transportDescription: req.transportDescription,
          isCreation: req.isCreation,
        };
        return { ok: true, result: await transportCapability.create(adt, destination, input) };
      }
      case 'transport.assign': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await transportCapability.assign(
            adt,
            ctx.destination,
            { ...req.ref, transport: req.transport },
            (request) => withRest(ctx, (rest) => transportCapability.readRequestTasks(rest, request)),
          ),
        };
      }
      case 'transport.release': {
        await session(ctx);
        const native = await sessionManager.nativeSupport(ctx.key);
        return {
          ok: true,
          result: await withRest(ctx, (rest) => transportCapability.release(rest, ctx.destination, req, native)),
        };
      }

      case 'object.create':
      case 'object.validate': {
        const destination = ctx.destination;
        const type = propertiesCapability.formType(req.ref.objectType);
        // Every local check before the session: a refused call must not open one (or an SSO window).
        if (translationsCapability.isTranslationProjectType(req.ref.objectType)) {
          if (req.cmd === 'object.validate') throw new Error(`validate takes a package (DEVC/K) so far, not ${req.ref.objectType}`);
          assertTranslationsAllowed(destination);
          if (req.additionalFields && Object.keys(req.additionalFields).length > 0) throw new Error('a translation project takes "properties", not additionalFields');
          const properties = req.properties === undefined ? undefined : translationUpdateCapability.parseProjectUpdate(req.properties, 'create');
          const input = { name: req.ref.name, objectType: req.ref.objectType, package: req.package, description: req.description, transport: req.transport, properties };
          translationUpdateCapability.planCreate(input);
          const { adt } = await session(ctx);
          return {
            ok: true,
            result: await withRest(ctx, (rest) =>
              translationUpdateCapability.createProject(
                {
                  rest,
                  destination,
                  lookupChain: lookupPackageChain(adt),
                  recordsChanges: async (pkg) => (await packageCapability.readPackageDefinition(rest, pkg))?.recordChanges,
                  onServiceCheck: (check) => serviceChecks.set(ctx.key, check),
                },
                input,
              ),
            ),
          };
        }
        if (req.cmd === 'object.validate' && type !== 'DEVC') throw new Error(`validate takes a package (DEVC/K) so far, not ${req.ref.objectType}`);
        if (req.properties !== undefined && !type) throw new Error(`${req.ref.objectType} takes additionalFields, not "properties"`);
        if (req.properties !== undefined) propertiesCapability.checkProperties(req.ref.objectType, req.properties);
        if (type === 'DEVC') {
          if (req.cmd === 'object.create' && req.additionalFields && Object.keys(req.additionalFields).length > 0) {
            throw new Error('a package takes "properties", not additionalFields');
          }
          const input = {
            name: req.ref.name,
            superPackage: req.package,
            description: req.description,
            transport: req.transport,
            ...propertiesCapability.packageCreate(req.properties),
          };
          const native = await sessionManager.nativeSupport(ctx.key);
          // Opens the adt-ls session only if a `subpackages` allowlist entry needs the chain.
          const lookupChain = async (pkg: string) => lookupPackageChain((await session(ctx)).adt)(pkg);
          const result = await withRest<unknown>(ctx, (rest) =>
            req.cmd === 'object.create'
              ? packageCapability.createPackage(rest, destination, input, native, lookupChain)
              : packageCapability.validateCreatePackage(rest, destination, input, native, lookupChain),
          );
          return { ok: true, result };
        }
        if (req.cmd === 'object.validate') return { ok: false, error: 'validate takes a package (DEVC/K) so far' };
        if (type === 'MSAG') {
          if (req.additionalFields && Object.keys(req.additionalFields).length > 0) {
            throw new Error('a message class takes "properties", not additionalFields');
          }
          const update = req.properties ? propertiesCapability.messageClassUpdate(req.properties) : undefined;
          if (update?.description !== undefined) throw new Error('a message class takes its description as "description", not header.description');
          // Before the create: messages SAP would refuse must not leave an empty class behind.
          if (update?.messages) messageClassCapability.checkMessages(update.messages);
          const { adt } = await session(ctx);
          const native = await sessionManager.nativeSupport(ctx.key);
          const created = await withRest(ctx, (rest) =>
            messageClassCapability.createMessageClass(
              rest,
              destination,
              { name: req.ref.name, packageName: req.package, description: req.description, transport: req.transport },
              lookupPackageChain(adt),
              native,
            ),
          );
          if (!update?.messages?.length) return { ok: true, result: created };
          const written = await withRest(ctx, (rest) =>
            messageClassCapability.updateMessageClass(
              rest,
              destination,
              { name: req.ref.name, messages: update.messages, transport: req.transport },
              lookupPackageChain(adt),
              native,
            ),
          ).catch((err: unknown) => {
            throw new Error(`message class ${req.ref.name.toUpperCase()} was created, but its messages were not written: ${err instanceof Error ? err.message : String(err)}`);
          });
          return { ok: true, result: { ...created, messages: written.messages } };
        }
        const form = restFormOf(req.ref.objectType);
        if (form) {
          if (req.additionalFields && Object.keys(req.additionalFields).length > 0) throw new Error(`a ${form.kind.kind} takes "properties", not additionalFields`);
          const content = form.create(req.properties);
          const native = await sessionManager.nativeSupport(ctx.key);
          const created = await withRest(ctx, (rest) =>
            formObjectCapability.createFormObject(
              form.kind,
              rest,
              destination,
              { name: req.ref.name, packageName: req.package, description: req.description, content, transport: req.transport },
              async (pkg: string) => lookupPackageChain((await session(ctx)).adt)(pkg),
              native,
            ),
          );
          return { ok: true, result: formObjectResult(form, req.ref.objectType, created) };
        }
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await objectCapability.create(adt, destination, {
            ...req.ref,
            packageName: req.package,
            description: req.description,
            transportRequestNumber: req.transport,
            additionalFields: req.additionalFields,
          }),
        };
      }
      case 'object.update': {
        if (translationsCapability.isTranslationProjectType(req.ref.objectType)) {
          // Every local check before a session (ADR-019 §5): the switch, the update's shape.
          assertTranslationsAllowed(ctx.destination);
          if (req.source !== undefined || req.include !== undefined) throw new Error('a translation project is changed through "properties", not "source"');
          if (req.properties === undefined) throw new Error('update of a translation project needs "properties", e.g. {"translations": [...]} or {"languages": [...]}');
          const update = translationUpdateCapability.parseProjectUpdate(req.properties);
          const { adt } = await session(ctx);
          return {
            ok: true,
            result: await withRest(ctx, (rest) =>
              translationUpdateCapability.updateProject(
                {
                  rest,
                  destination: ctx.destination,
                  lookupChain: lookupPackageChain(adt),
                  // A confirmed resolve, then the write rule on its package and chain (ADR-003).
                  assertObjectWritable: async (ref) => assertObjectWritable(ctx.destination, await resolveObject(adt, ref)),
                  ownUploads: ownUploadsOf(ctx),
                  onServiceCheck: (check) => serviceChecks.set(ctx.key, check),
                },
                { name: req.ref.name, objectType: req.ref.objectType, update, transport: req.transport },
              ),
            ),
          };
        }
        const { adt } = await session(ctx);
        const type = propertiesCapability.formType(req.ref.objectType);
        if (type) {
          if (req.source !== undefined || req.include !== undefined) {
            throw new Error(`${req.ref.objectType} is changed through "properties" (its AFF JSON), not "source"`);
          }
          if (req.properties === undefined) throw new Error(`update of ${req.ref.objectType} needs "properties"`);
          const properties = propertiesCapability.checkProperties(req.ref.objectType, req.properties);
          const native = await sessionManager.nativeSupport(ctx.key);
          if (type === 'DEVC') {
            const edit = { name: req.ref.name, transport: req.transport, ...propertiesCapability.packageUpdate(properties) };
            return { ok: true, result: await withRest(ctx, (rest) => packageCapability.editPackage(adt, rest, ctx.destination, edit, native)) };
          }
          const form = restFormOf(req.ref.objectType);
          if (form) {
            const change = form.update(properties);
            const updated = await withRest(ctx, (rest) =>
              formObjectCapability.updateFormObject(form.kind, rest, ctx.destination, { name: req.ref.name, change, transport: req.transport }, lookupPackageChain(adt), native),
            );
            return { ok: true, result: { ...formObjectResult(form, req.ref.objectType, updated), previous: form.properties(updated.previous) } };
          }
          const update = { name: req.ref.name, transport: req.transport, ...propertiesCapability.messageClassUpdate(properties) };
          return {
            ok: true,
            result: await withRest(ctx, (rest) =>
              messageClassCapability.updateMessageClass(rest, ctx.destination, update, lookupPackageChain(adt), native),
            ),
          };
        }
        if (req.properties !== undefined) throw new Error(`${req.ref.objectType} is changed through "source", not "properties"`);
        if (req.source === undefined) throw new Error(`update of ${req.ref.objectType} needs "source"`);
        await objectCapability.updateSource(adt, ctx.destination, {
          ...req.ref,
          source: req.source,
          include: req.include,
          transport: req.transport,
        });
        return { ok: true, result: null };
      }
      case 'object.activate': {
        // The REST form types through ADT's activation (adt-ls answers "Internal error." for a
        // domain), in one request, which SAP orders; before the rest, which may use them.
        const refs = req.refs ?? [];
        const lookupChain = async (pkg: string) => lookupPackageChain((await session(ctx)).adt)(pkg);
        const viaRest = refs.filter((r) => restFormOf(r?.objectType));
        const kinds = REST_FORMS.map((f) => f.kind);
        const rest: objectCapability.RestActivationLane = {
          refs: viaRest,
          label: `${kinds.map((k) => k.plural).join(' and ')} (${kinds.map((k) => k.type).join(', ')})`,
          gate: async () => {
            // Every kind's reads and gates at once, the result in REST_FORMS order.
            const gated = await withRest(ctx, async (r) =>
              (
                await Promise.all(
                  REST_FORMS.map((form) => {
                    const names = viaRest.filter((ref) => restFormOf(ref.objectType) === form).map((ref) => ref.name);
                    return names.length > 0 ? formObjectCapability.gateFormObjects(form.kind, r, ctx.destination, names, lookupChain) : Promise.resolve([]);
                  }),
                )
              ).flat(),
            );
            return () => withRest(ctx, (r) => activateRest(r, gated));
          },
        };
        return {
          ok: true,
          result: await objectCapability.activateBatch(async () => (await session(ctx)).adt, ctx.destination, {
            refs: refs.filter((r) => !restFormOf(r?.objectType)),
            forceActivation: req.forceActivation,
            rest,
          }),
        };
      }
      case 'object.listInactive': {
        const { adt } = await session(ctx);
        return { ok: true, result: await objectCapability.listInactive(adt) };
      }
      case 'object.delete': {
        if (translationsCapability.isTranslationProjectType(req.ref.objectType)) {
          assertTranslationsAllowed(ctx.destination);
          assertConfirmed('delete', req.confirm);
          const { adt } = await session(ctx);
          return {
            ok: true,
            result: await withRest(ctx, (rest) =>
              translationUpdateCapability.deleteProject(
                {
                  rest,
                  destination: ctx.destination,
                  lookupChain: lookupPackageChain(adt),
                  ownUploads: ownUploadsOf(ctx),
                  onServiceCheck: (check) => serviceChecks.set(ctx.key, check),
                },
                { name: req.ref.name, objectType: req.ref.objectType, transport: req.transport },
              ),
            ),
          };
        }
        const { adt } = await session(ctx);
        if (propertiesCapability.formType(req.ref.objectType) === 'DEVC') {
          const native = await sessionManager.nativeSupport(ctx.key);
          const input = { name: req.ref.name, transport: req.transport, confirm: req.confirm };
          return { ok: true, result: await withRest(ctx, (rest) => packageCapability.deletePackage(adt, rest, ctx.destination, input, native)) };
        }
        const form = restFormOf(req.ref.objectType);
        if (form) {
          const native = await sessionManager.nativeSupport(ctx.key);
          const input = { name: req.ref.name, transport: req.transport, confirm: req.confirm };
          const { name, ...deleted } = await withRest(ctx, (rest) =>
            formObjectCapability.deleteFormObject(form.kind, rest, ctx.destination, input, lookupPackageChain(adt), native),
          );
          return { ok: true, result: { [form.deleteKey]: name, ...deleted } };
        }
        if (messageClassCapability.isMessageClassType(req.ref.objectType)) {
          const native = await sessionManager.nativeSupport(ctx.key);
          return {
            ok: true,
            result: await withRest(ctx, (rest) =>
              messageClassCapability.deleteMessageClass(
                rest,
                ctx.destination,
                { name: req.ref.name, transport: req.transport, confirm: req.confirm },
                lookupPackageChain(adt),
                native,
              ),
            ),
          };
        }
        await objectCapability.deleteObject(adt, ctx.destination, { ref: req.ref, confirm: req.confirm, transport: req.transport });
        return { ok: true, result: null };
      }
      case 'object.deleteMessages': {
        const { adt } = await session(ctx);
        const native = await sessionManager.nativeSupport(ctx.key);
        return {
          ok: true,
          result: await withRest(ctx, (rest) =>
            messageClassCapability.deleteMessages(
              rest,
              ctx.destination,
              { name: req.name, numbers: req.numbers, transport: req.transport, confirm: req.confirm },
              lookupPackageChain(adt),
              native,
            ),
          ),
        };
      }
      case 'object.lockStatus': {
        const { adt } = await session(ctx);
        return { ok: true, result: await objectCapability.lockStatus(adt, req.ref) };
      }

      case 'object.read': {
        const formType = propertiesCapability.formType(req.ref.objectType);
        if (translationsCapability.isTranslationProjectType(req.ref.objectType)) {
          const narrowing = (['include', 'version', 'method', 'context', 'fromLine', 'toLine', 'maxLines'] as const).filter((k) => req[k] !== undefined);
          if (narrowing.length > 0) throw new Error(`a TRPR read takes "language", "translationStatus", "grep", "maxResults" and "cursor", not ${narrowing.map((k) => `"${k}"`).join(', ')}`);
          // Before the session: a refused read must not open one (or an SSO window).
          const filter = translationsCapability.prepareProjectRead(ctx.destination, req);
          const read = await withRest(ctx, (rest) =>
            translationsCapability.readTranslationProject(rest, ctx.destination, req.ref, filter, (check) => serviceChecks.set(ctx.key, check)),
          );
          return { ok: true, result: read };
        }
        const translationOnly = (['language', 'translationStatus', 'maxResults', 'cursor'] as const).filter((k) => req[k] !== undefined);
        if (translationOnly.length > 0) throw new Error(`${translationOnly.map((k) => `"${k}"`).join(', ')} narrow a translation project's read (TRPR), not ${req.ref.objectType}`);
        if (formType) {
          const allowed = formType === 'MSAG' ? ['grep'] : [];
          const narrowing = (['include', 'version', 'method', 'grep', 'context', 'fromLine', 'toLine', 'maxLines'] as const).filter(
            (k) => req[k] !== undefined && !allowed.includes(k),
          );
          if (narrowing.length > 0) {
            throw new Error(`a ${formType} read returns its properties${formType === 'MSAG' ? ' and takes only "grep"' : ''}, not ${narrowing.map((k) => `"${k}"`).join(', ')}`);
          }
          const native = await Promise.resolve().then(() => sessionManager.nativeSupport(ctx.key)).catch(() => undefined);
          const form = restFormOf(req.ref.objectType);
          const read = await withRest<Record<string, unknown>>(ctx, (rest) =>
            form
              ? formObjectCapability.readFormObjectDefinition(form.kind, rest, req.ref.name, native).then((r) => formObjectResult(form, req.ref.objectType, r))
              : formType === 'MSAG'
              ? messageClassCapability.readMessages(rest, { name: req.ref.name, grep: req.grep }, native).then((mc) => ({
                  name: mc.name,
                  objectType: req.ref.objectType,
                  package: mc.package,
                  properties: propertiesCapability.messageClassProperties(mc),
                  ...(req.grep !== undefined ? { totalMessages: mc.totalMessages } : {}),
                  via: mc.via,
                  nativeAvailable: mc.nativeAvailable,
                }))
              : packageCapability.readPackageDefinition(rest, req.ref.name.toUpperCase()).then((p) => {
                  if (!p) throw new Error(`package "${req.ref.name.toUpperCase()}" does not exist`);
                  return {
                    name: p.name,
                    objectType: req.ref.objectType,
                    properties: propertiesCapability.packageProperties(p),
                    via: 'rest-fallback' as const,
                    nativeAvailable: native?.packageCreate ?? null,
                  };
                }),
          );
          const mirrored = await mirrorReadNote({ system: ctx.system, ref: req.ref, mirrorRoots: req.mirrorRoots, workspaceFolders: req.workspaceFolders });
          return { ok: true, result: mirrored ? { ...read, notes: [mirrored] } : read };
        }
        const { adt } = await session(ctx);
        // The listing's `00000`/`99999` are the active version and the draft: adt-ls reads those.
        const current = req.version === '00000' ? 'active' : req.version === '99999' ? 'inactive' : req.version;
        if (current !== undefined && current !== 'active' && current !== 'inactive') {
          const { include, method, grep, context, fromLine, toLine, maxLines } = req;
          const read = await versionsCapability.readVersion(
            { adt, withRest: (fn) => withRest(ctx, fn), clock: await clockOf(ctx) },
            { ...req.ref, include, version: current, method, grep, context, fromLine, toLine, maxLines },
          );
          const mirrored = await mirrorReadNote({ system: ctx.system, ref: req.ref, mirrorRoots: req.mirrorRoots, workspaceFolders: req.workspaceFolders });
          return { ok: true, result: { ...read, notes: mirrored ? [...read.notes, mirrored] : read.notes } };
        }
        const key = objectKey(ctx.key, req.ref);
        const read = await objectCapability.readSource(
          adt,
          {
            ...req.ref,
            include: req.include,
            version: current,
            method: req.method,
            grep: req.grep,
            context: req.context,
            fromLine: req.fromLine,
            toLine: req.toLine,
            maxLines: req.maxLines,
          },
          {
            hold: (fn) => objectLocks.shared([key], fn),
            // Exclusive: while adt-ls serves the active version, no other command on the object runs.
            readActive: (ref, includes) => objectLocks.exclusive(key, () => readActiveIncludes(adt, ref, includes)),
          },
        );
        const mirrored = await mirrorReadNote({ system: ctx.system, ref: req.ref, mirrorRoots: req.mirrorRoots, workspaceFolders: req.workspaceFolders });
        return { ok: true, result: { ...read, notes: mirrored ? [...read.notes, mirrored] : read.notes } };
      }
      case 'object.translations': {
        // Before the session: a refused read must not open one (or an SSO window).
        const prepared = translationsCapability.prepareTranslations(ctx.destination, req);
        const deps: translationsCapability.TranslationsDeps = {
          withRest: (fn) => withRest(ctx, fn),
          objectPackage: async (ref) => {
            const { adt } = await session(ctx);
            // The URI holds the package: no confirming read of the object's source (a stale index finds no project, which is all it can do here).
            const uri = await adt.lifecycle.resolveAffUri(ref);
            const placement = objectPlacement(uri, ref);
            if (!placement) throw new Error(`cannot tell which package ${ref.objectType} "${ref.name}" is in (${uri})`);
            return placement.package;
          },
          packageObjects: async (name) => {
            const { adt } = await session(ctx);
            const maxObjects = ctx.destination.mirror?.maxObjects ?? mirrorPull.DEFAULT_MAX_OBJECTS;
            const walked = await walk(adt, [{ name, subpackages: false }], { maxObjects, concurrency: limiterFor(ctx).concurrency });
            if (walked.missing.length > 0) throw new Error(`package ${name} not found on ${ctx.system}`);
            if (walked.exceeded) throw new Error(`package ${name} has over ${maxObjects} objects; read its objects' translations one by one`);
            // An unread folder's objects would be left out without a word: refuse instead.
            if (walked.unreadable.length > 0) throw new Error(`package ${name}: ${walked.unreadable.map((u) => `${u.path} (${u.message})`).join('; ')} could not be read, so its objects are unknown`);
            // The walk's type is the file name's: AFF's four letters, or adt-ls's placeholder with the subtype (`msagn`).
            return walked.objects.map((o) => ({ objectType: o.type.slice(0, 4), name: o.name }));
          },
          onServiceCheck: (check) => serviceChecks.set(ctx.key, check),
        };
        return { ok: true, result: await translationsCapability.readTranslations(deps, ctx.destination, prepared) };
      }
      case 'object.versions': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await versionsCapability.listVersions(
            { adt, withRest: (fn) => withRest(ctx, fn), clock: await clockOf(ctx) },
            { ...req.ref, include: req.include, maxResults: req.maxResults },
          ),
        };
      }
      case 'object.diff': {
        const { adt } = await session(ctx);
        const { include, version, baseVersion, context, maxLines } = req;
        return {
          ok: true,
          result: await versionsCapability.diffVersions(
            { adt, withRest: (fn) => withRest(ctx, fn), clock: await clockOf(ctx) },
            { ...req.ref, include, version, baseVersion, context, maxLines },
          ),
        };
      }
      case 'object.resolve': {
        const { adt } = await session(ctx);
        const { uri } = await objectCapability.resolve(adt, req.ref);
        return { ok: true, result: { uri } };
      }
      case 'object.search': {
        const { adt } = await session(ctx);
        const found = await objectCapability.search(adt, {
          query: req.query,
          objectType: req.objectType,
          maxResults: req.maxResults,
        });
        return {
          ok: true,
          result: found,
        };
      }
      case 'object.list': {
        const { adt } = await session(ctx);
        const listed = await objectCapability.list(adt, {
          packageName: req.package,
          path: req.path,
          depth: req.depth,
          maxRequests: req.maxRequests,
        });
        return { ok: true, result: listed };
      }
      case 'object.publish':
      case 'object.unpublish': {
        // Refused before the session, so a refusal opens no SSO window; publishService checks again.
        assertConfirmed(`object ${req.cmd === 'object.publish' ? 'publish' : 'unpublish'}`, req.confirm);
        assertPublishServiceAllowed(ctx.destination);
        const { adt } = await session(ctx);
        const destination = ctx.destination;
        return {
          ok: true,
          result: await objectCapability.publishService(adt, destination, {
            ref: req.ref,
            target: req.cmd === 'object.publish' ? 'PUBLISH' : 'UNPUBLISH',
            confirm: req.confirm,
            settleTimeoutMs: req.settleTimeoutMs,
          }),
        };
      }

      case 'object.generators': {
        const { adt } = await session(ctx);
        return { ok: true, result: await rapCapability.listGenerators(adt) };
      }
      case 'object.generatorSchema': {
        const { adt } = await session(ctx);
        const { generatorId, referencedObject } = req;
        return { ok: true, result: await rapCapability.generatorSchema(adt, { generatorId, packageName: req.package, referencedObject }) };
      }
      case 'object.generate': {
        const { adt } = await session(ctx);
        const { generatorId, referencedObject, content, transport } = req;
        return {
          ok: true,
          result: await rapCapability.generate(adt, ctx.destination, { generatorId, packageName: req.package, referencedObject, content, transport }),
        };
      }
      case 'object.serviceInfo': {
        const { adt } = await session(ctx);
        return { ok: true, result: await rapCapability.serviceInfo(adt, req.ref, req.service) };
      }
      case 'object.applyQuickfixes': {
        const { adt } = await session(ctx);
        const hold = { system: ctx.system, mirrorRoots: req.mirrorRoots, workspaceFolders: req.workspaceFolders };
        return {
          ok: true,
          result: await qualityCapability.applyQuickfixes(
            adt,
            ctx.destination,
            { worklistId: req.worklistId, transport: req.transport },
            (ref) => mirrorRefusal({ ...hold, ref }, req.cmd),
            // `sharedKeys` can't know the worklist's objects before it is read.
            (refs, fn) => objectLocks.shared(refs.map((ref) => objectKey(ctx.key, ref)), fn),
          ),
        };
      }

      case 'navigate.whereUsed': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await navigateCapability.references(adt, req.ref, locatorOf(req), {
            timeoutMs: req.timeoutMs,
            scanSource: req.scanSource,
            // Exclusive: while adt-ls serves the active version, no other command on the object runs.
            readActiveSource: (includes) =>
              objectLocks.exclusive(objectKey(ctx.key, req.ref), () => readActiveIncludes(adt, req.ref, includes)),
          }),
        };
      }
      case 'navigate.definition': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await navigateCapability.definition(adt, req.ref, locatorOf(req)),
        };
      }
      case 'navigate.declaration': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await navigateCapability.declaration(adt, req.ref, locatorOf(req)),
        };
      }
      case 'navigate.hover': {
        const { adt } = await session(ctx);
        return { ok: true, result: await navigateCapability.hover(adt, req.ref, locatorOf(req)) };
      }
      case 'navigate.outline': {
        const { adt } = await session(ctx);
        return { ok: true, result: await navigateCapability.symbols(adt, req.ref) };
      }
      case 'navigate.typeHierarchy': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await navigateCapability.hierarchy(adt, req.ref, locatorOf(req), {
            direction: req.direction,
          }),
        };
      }
      case 'quality.syntax': {
        if (req.source !== undefined) {
          if (!req.ref || req.refs || req.package) throw new Error('"source" checks one object: give "ref" (name + objectType), not "refs" or "package"');
          const input = { ref: req.ref, source: req.source, include: req.include };
          // Before the session: a refused check must not open one (or an SSO window).
          checkrunCapability.checkTextInput(input);
          const { adt } = await session(ctx);
          const native = await nativeSupportOf(ctx);
          return { ok: true, result: await withRest(ctx, (rest) => checkrunCapability.checkSyntaxText(adt, rest, input, native)) };
        }
        if (req.include !== undefined) throw new Error('"include" goes with "source": the stored check covers every include');
        const targets = await checkTargets(ctx, req);
        const { adt } = await session(ctx);
        if ('single' in targets) {
          const ref = targets.single;
          if (checkrunCapability.checksThroughCheckRun(ref)) return { ok: true, result: await withRest(ctx, (rest) => checkrunCapability.checkStoredSyntax(adt, rest, ref)) };
          return { ok: true, result: await navigateCapability.checkSyntax(adt, ref) };
        }
        const concurrency = limiterFor(ctx).concurrency;
        const checkRun = (ref: ObjectRef) => withRest(ctx, (rest) => checkrunCapability.checkStoredItems(adt, rest, ref)).then((r) => r.items);
        return {
          ok: true,
          result: await targets.hold(() => qualityCapability.checkSyntaxBatch(adt, targets.batch, concurrency, checkRun)),
        };
      }
      case 'quality.format': {
        if (!req.ref) throw new Error('"format" formats one object: give "ref" (name + objectType)');
        const input = { ref: req.ref, source: req.source };
        // Before the session: a refused format must not open one (or an SSO window); abap-cleaner on
        // given text opens none at all.
        formatCapability.checkFormatInput(ctx.destination, input);
        const deps: formatCapability.FormatDeps = {
          adt: async () => (await session(ctx)).adt,
          withRest: async (fn) => {
            await session(ctx);
            return withRest(ctx, fn);
          },
        };
        return { ok: true, result: await formatCapability.formatSource(deps, ctx.destination, input) };
      }

      case 'run.application': {
        const destination = ctx.destination;
        // Before the session: a refused run must not open one (or an SSO window).
        assertRunAllowed(destination);
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await runCapability.runApplication(adt, destination, { ref: req.ref, confirm: req.confirm }),
        };
      }

      case 'data.query': {
        // Every local check before the session: a refused query must not open one (or an SSO window).
        const prepared = dataPreviewCapability.prepareQuery(ctx.destination, { statement: req.statement, maxRows: req.maxRows });
        await session(ctx);
        const native = await nativeSupportOf(ctx);
        return { ok: true, result: await withRest(ctx, (rest) => dataPreviewCapability.query(rest, prepared, native)) };
      }

      case 'runtime.dumps': {
        // Every local check before the session: a refused list must not open one (or an SSO window).
        const prepared = dumpsCapability.prepareList(ctx.destination, req);
        await session(ctx);
        const [native, clock] = await Promise.all([nativeSupportOf(ctx), clockOf(ctx)]);
        return { ok: true, result: await withRest(ctx, (rest) => dumpsCapability.listDumps(rest, ctx.destination, prepared, native, clock)) };
      }
      case 'runtime.dump': {
        assertRuntimeLogsAllowed(ctx.destination);
        dumpsCapability.dumpSegment(req.id);
        await session(ctx);
        const [native, clock] = await Promise.all([nativeSupportOf(ctx), clockOf(ctx)]);
        const input = { id: req.id, chapters: req.chapters };
        return { ok: true, result: await withRest(ctx, (rest) => dumpsCapability.readDump(rest, ctx.destination, input, native, clock)) };
      }
      case 'runtime.gatewayErrors': {
        const prepared = runtimeLogsCapability.prepareGatewayList(ctx.destination, req);
        await session(ctx);
        const native = await nativeSupportOf(ctx);
        return { ok: true, result: await withRest(ctx, (rest) => runtimeLogsCapability.listGatewayErrors(rest, ctx.destination, prepared, native)) };
      }
      case 'runtime.gatewayError': {
        assertRuntimeLogsAllowed(ctx.destination);
        runtimeLogsCapability.gatewayErrorPath(req.id);
        await session(ctx);
        const native = await nativeSupportOf(ctx);
        return { ok: true, result: await withRest(ctx, (rest) => runtimeLogsCapability.readGatewayError(rest, ctx.destination, { id: req.id, sections: req.sections }, native)) };
      }
      case 'system.messages': {
        await session(ctx);
        const [native, clock] = await Promise.all([nativeSupportOf(ctx), clockOf(ctx)]);
        return { ok: true, result: await withRest(ctx, (rest) => runtimeLogsCapability.listSystemMessages(rest, native, clock)) };
      }

      case 'quality.atcVariants': {
        const { adt } = await session(ctx);
        return { ok: true, result: await qualityCapability.listAtcVariants(adt, req.ref) };
      }
      case 'quality.atc': {
        const targets = await checkTargets(ctx, req);
        const { adt } = await session(ctx);
        const { checkVariant, timeoutMs } = req;
        if (req.quickfixes) {
          const refs = 'single' in targets ? [targets.single] : targets.batch;
          const run = () => qualityCapability.runAtcWorklist(adt, { refs, checkVariant, timeoutMs });
          return { ok: true, result: 'single' in targets ? await run() : await targets.hold(run) };
        }
        if ('single' in targets) {
          return { ok: true, result: await qualityCapability.runAtc(adt, { ref: targets.single, checkVariant, timeoutMs }) };
        }
        const input = { refs: targets.batch, checkVariant, timeoutMs, concurrency: limiterFor(ctx).concurrency };
        return { ok: true, result: await targets.hold(() => qualityCapability.runAtcBatch(adt, input)) };
      }
      case 'test.unit': {
        const { adt } = await session(ctx);
        return {
          ok: true,
          result: await qualityCapability.runUnitTests(adt, ctx.destination, {
            ref: req.ref,
            coverage: req.coverage,
          }),
        };
      }
      case 'quality.abaplint': {
        const targets = await checkTargets(ctx, req);
        const { adt } = await session(ctx);
        const destination = ctx.destination;
        if ('single' in targets) {
          return { ok: true, result: await qualityCapability.runAbaplint(adt, destination, targets.single, req.rules) };
        }
        const concurrency = limiterFor(ctx).concurrency;
        return {
          ok: true,
          result: await targets.hold(() =>
            qualityCapability.runAbaplintBatch(adt, destination, targets.batch, concurrency, req.rules),
          ),
        };
      }

      case 'mirror.init': {
        const { root, workspaceFolders, subpackages } = req;
        return {
          ok: true,
          result: await mirrorPull.init(await mirrorDeps(ctx), ctx.destination.mirror ?? {}, {
            root,
            workspaceFolders,
            system: ctx.system,
            package: req.package,
            subpackages,
          }),
        };
      }
      case 'mirror.pull': {
        const { root, workspaceFolders, maxObjects, objects, bestEffort, reread } = req;
        return {
          ok: true,
          result: await mirrorPull.pull(await mirrorDeps(ctx), ctx.destination.mirror ?? {}, {
            root,
            workspaceFolders,
            system: ctx.system,
            maxObjects,
            ...listField('objects', objects),
            ...listField('bestEffort', bestEffort),
            ...listField('reread', reread),
          }),
        };
      }
      case 'mirror.changes': {
        const { root, workspaceFolders, maxObjects } = req;
        return {
          ok: true,
          result: await mirrorChanges(
            {
              withRest: (fn) => withRest(ctx, fn),
              concurrency: capsOf(ctx).rest,
              // Only reported (ADR-002): a failed probe leaves it unknown.
              native: (await Promise.resolve().then(() => sessionManager.nativeSupport(ctx.key)).catch(() => undefined))?.changeStamps,
              ...(onProgress ? { progress: onProgress } : {}),
            },
            ctx.destination.mirror ?? {},
            { root, workspaceFolders, system: ctx.system, maxObjects },
          ),
        };
      }
      case 'swc.packages': {
        return {
          ok: true,
          result: await componentPackages(
            { withRest: (fn) => withRest(ctx, fn), concurrency: capsOf(ctx).rest },
            ctx.destination.mirror ?? {},
            { system: ctx.system, component: req.component, maxObjects: req.maxObjects },
          ),
        };
      }
      case 'history.versions': {
        const { root, workspaceFolders, run, since, objects, known } = req;
        if (typeof run !== 'string' || run === '' || typeof since !== 'string') throw new Error('history.versions needs a run id and a since date');
        return {
          ok: true,
          result: await historyVersions(
            { withRest: (fn) => withRest(ctx, fn), concurrency: capsOf(ctx).rest, clock: await clockOf(ctx) },
            {
              root,
              workspaceFolders,
              system: ctx.system,
              run,
              since,
              ...listField('objects', objects),
              ...listField('known', known),
            },
          ),
        };
      }
      case 'history.released': {
        return { ok: true, result: await releasedRequests({ withRest: (fn) => withRest(ctx, fn), concurrency: capsOf(ctx).rest, clock: await clockOf(ctx) }) };
      }
      case 'mirror.status': {
        const adtLs = adtLsInfo({ resolvePath: opts.resolveAdtLsPath });
        return {
          ok: true,
          result: await mirrorStatus({
            root: req.root,
            workspaceFolders: req.workspaceFolders,
            adtLsVersion: adtLs.version ?? undefined,
          }),
        };
      }
      case 'mirror.check': {
        const adtLs = adtLsInfo({ resolvePath: opts.resolveAdtLsPath });
        return {
          ok: true,
          result: await mirrorCheck({
            root: req.root,
            workspaceFolders: req.workspaceFolders,
            system: ctx.system,
            languageVersion: ctx.destination.languageVersion,
            adtLsVersion: adtLs.version ?? undefined,
            rules: req.rules,
          }),
        };
      }
      case 'mirror.push':
      case 'mirror.activate': {
        const patterns = [...deny, ...(Array.isArray(req.deny) ? req.deny : [])];
        for (const cmd of mirrorWriteCmds(req)) {
          const refused = denyRefusal(cmd, patterns);
          if (refused) return { ok: false, error: `${req.cmd} refused before any write: ${refused}` };
        }
        const deps = await pushDeps(ctx, req, patterns, onProgress);
        const { root, workspaceFolders } = req;
        if (req.cmd === 'mirror.activate') {
          return { ok: true, result: await activateMirror(deps, { root, workspaceFolders, system: ctx.system }) };
        }
        return {
          ok: true,
          result: await mirrorPush(deps, ctx.destination.mirror ?? {}, {
            root,
            workspaceFolders,
            system: ctx.system,
            dryRun: req.dryRun,
            activate: req.activate,
            transport: req.transport,
            maxObjects: req.maxObjects,
            takeSystemVersion: req.takeSystemVersion,
          }),
        };
      }
      case 'mirror.new': {
        const { root, workspaceFolders, type, name, description } = req;
        return {
          ok: true,
          result: await mirrorNew(ctx.destination.mirror ?? {}, {
            root,
            workspaceFolders,
            system: ctx.system,
            type,
            name,
            package: req.package,
            description,
            languageVersion: ctx.destination.languageVersion,
            language: logonLanguage(ctx.destination),
          }),
        };
      }

      default:
        return { ok: false, error: `Unknown command "${(req as { cmd: string }).cmd}"` };
    }
  }

  /**
   * The SDK uses a ref's `uri` as given, without the name search, and the write
   * gate reads the package off that URI. Whether adt-ls would serve a hand-built
   * repotree path under an allowlisted package is unprobed, so a ref from a
   * client loses its `uri`: adt+ passes on only URIs it resolved itself.
   */
  function withoutCallerUris(req: DaemonRequest): DaemonRequest {
    const strip = (ref: unknown) => {
      if (!ref || typeof ref !== 'object' || !('uri' in ref)) return ref;
      const { uri: _uri, ...rest } = ref as Record<string, unknown>;
      return rest;
    };
    const out = { ...req } as Record<string, unknown>;
    if ('ref' in out) out.ref = strip(out.ref);
    if (Array.isArray(out.refs)) out.refs = out.refs.map(strip);
    return out as unknown as DaemonRequest;
  }

  /** Handle one request, never throwing — failures come back as {ok: false}. Its start and its end both count as activity. */
  async function handleRequest(incoming: DaemonRequest, onProgress?: (p: DaemonProgress) => void): Promise<DaemonResponse> {
    inFlight += 1;
    lastActivityAt = now();
    try {
      return await handleOne(incoming, onProgress);
    } finally {
      inFlight -= 1;
      lastActivityAt = now();
    }
  }

  async function handleOne(incoming: DaemonRequest, onProgress?: (p: DaemonProgress) => void): Promise<DaemonResponse> {
    const req = withoutCallerUris(incoming);
    const callStart = now();
    let res: DaemonResponse;
    const refusal =
      readOnlyRefusal(req.cmd, readOnly || req.readOnly === true) ??
      denyRefusal(req.cmd, [...deny, ...(Array.isArray(req.deny) ? req.deny : [])]);
    let ctx: SystemContext | undefined;
    try {
      // Before the rate limit and the locks: resolving may wait for the approval dialog.
      if (!refusal && 'system' in req) ctx = await systemContext(req.system, projectSetsOf(req));
      // ADR-011: the git remote helper only on systems that opted in, before any SAP call.
      if (ctx && req.client === 'git' && ctx.destination.mirror?.git?.enabled !== true) {
        throw new Error(`git remote not enabled for ${ctx.system}; set "mirror": { "git": { "enabled": true } } for it in systems.json`);
      }
      // ADR-009: before the rate limit, so a refused write costs no budget. Push never dispatches this command.
      if (ctx && req.cmd === 'object.update') {
        const mirrored = await mirrorRefusal({ system: ctx.system, ref: req.ref, mirrorRoots: req.mirrorRoots, workspaceFolders: req.workspaceFolders });
        if (mirrored) throw new Error(mirrored);
      }
      if (ctx && req.cmd === 'object.deleteMessages') {
        const ref = { name: req.name, objectType: 'MSAG/N' };
        const mirrored = await mirrorRefusal({ system: ctx.system, ref, mirrorRoots: req.mirrorRoots, workspaceFolders: req.workspaceFolders }, req.cmd);
        if (mirrored) throw new Error(mirrored);
      }
      if (ctx && !UNLIMITED_CMDS.has(req.cmd)) limiterFor(ctx).admit();
      const keys = ctx ? sharedKeys(req, ctx) : [];
      // One timeout scope per command: its REST requests' limit, and whether SAP still answers them (`withTimeout`).
      const run = (): Promise<DaemonResponse> =>
        withTimeout(ctx && restTimeoutMs(ctx), () =>
          ctx && BULK_CMDS.has(req.cmd)
            ? limiterFor(ctx).bulk(capsOf(ctx), () => dispatch(req, ctx, onProgress))
            : dispatch(req, ctx, onProgress),
        );
      res = refusal ? { ok: false, error: refusal } : keys.length > 0 ? await objectLocks.shared(keys, run) : await run();
    } catch (err) {
      res =
        err instanceof ThrottledError
          ? { ok: false, error: err.message, throttled: true, retryAfterMs: err.retryAfterMs }
          : { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (ctx) res = toVfs(ctx, res);
    callLog?.record(req, res, callStart, now() - callStart, ctx?.projectFiles);
    return res;
  }

  async function defaultIdleShutdown(): Promise<void> {
    await sessionManager.disposeAll();
    await close();
    process.exit(0);
  }

  async function checkIdle(): Promise<boolean> {
    if (retiring || inFlight > 0 || now() - lastActivityAt <= idleTimeoutMs) return false;
    await (opts.onIdleShutdown ?? defaultIdleShutdown)();
    return true;
  }

  mkdirSync(path.dirname(socketPath), { recursive: true });
  // A daemon that crashed leaves its socket file behind; a fresh one just
  // takes over. Known simplification: not race-proof under two
  // near-simultaneous first launches.
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });

  const server = createServer((socket: Socket) => {
    // A client gone mid-command (Ctrl-C on a fetch) makes the next progress line or the answer an
    // EPIPE: without a listener that would end the daemon.
    socket.on('error', () => undefined);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        void (async () => {
          let response: DaemonResponse;
          try {
            const req = JSON.parse(line) as DaemonRequest;
            response = await handleRequest(req, req.progress === true ? progressWriter(socket) : undefined);
          } catch (err) {
            response = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          socket.write(`${JSON.stringify(response)}\n`);
        })();
      }
    });
  });

  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
  });

  const interval = setInterval(() => {
    void checkIdle();
  }, checkIntervalMs);
  interval.unref();

  async function close(): Promise<void> {
    clearInterval(interval);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!retiring) rmSync(socketPath, { force: true });
  }

  /**
   * Make way for a successor: give up the socket path now, so a fresh daemon can
   * bind it, and exit once every open connection has had its answer. Requests
   * already running, e.g. a long ABAP Unit run, finish on this daemon.
   */
  function retire(): void {
    if (retiring) return;
    retiring = true;
    clearInterval(interval);
    // Now, not after draining: by then the path belongs to the successor.
    rmSync(socketPath, { force: true });
    server.close(() => {
      void (async () => {
        if (opts.onRetired) return opts.onRetired();
        await sessionManager.disposeAll();
        process.exit(0);
      })();
    });
  }

  return { server, socketPath, handleRequest, checkIdle, close };
}

function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = netConnect(socketPath);
    probe.once('connect', () => {
      probe.end();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

async function main(): Promise<void> {
  // Parallel first calls each spawn a daemon; a later one must not delete the
  // live socket of the one that already won.
  if (await socketIsLive(resolveSocketPath())) return;
  // Before the config is read: an edit landing in between then shows as a mismatch, never as a match.
  const identity = currentIdentity();
  const config = createConfigResolver({
    // Before any session of those systems opens: adt-ls receives extraCaCerts
    // for its JVM, but adt+'s own HTTP calls run on Node's truststore and need
    // them here too. Project configs can bring their own, so on every fresh read.
    onLoaded: async (destinations) => {
      const ca = await installExtraCaCerts(destinations);
      if (ca.added > 0) console.error(`adt+: trusting ${ca.added} extra CA certificate(s) from ${ca.files.join(', ')}`);
    },
  });
  // Fail at start, as before, when the user config itself doesn't load.
  await config.resolve([]);
  for (const warning of adtLsWarnings(adtLsInfo())) console.error(`adt+: ${warning}`);
  createDaemonServer({ sessionManager: new SessionManager(), config, identity });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
