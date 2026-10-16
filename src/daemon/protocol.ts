import type { ClockRead } from '../core/clock.js';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ObjectRef } from '@arc-mcp/adt-ls';
import type { AdtLsInfo } from '../core/adtls-version.js';
import type { NativeSupport } from '../core/capabilities.js';
import type { RestSessionInfo, SessionInfo } from '../core/session.js';
import type { DaemonIdentity } from './identity.js';
import type { ServiceCheck } from '../backends/odata-ui.js';
import type { TranslationStatus } from '../capabilities/translations.js';

export interface StatusRequest {
  cmd: 'system.status';
}

export interface ConnectRequest {
  cmd: 'system.connect';
  system: string;
}

export interface PingRequest {
  cmd: 'ping';
}

/**
 * Retire the daemon unless its identity equals `unless` — the one the caller
 * would spawn. Conditional so that a client acting on a stale ping can't take
 * down the fresh daemon another client already started.
 */
export interface ShutdownRequest {
  cmd: 'shutdown';
  unless: DaemonIdentity;
}

// --- transport -----------------------------------------------------------

export interface TransportListRequest {
  cmd: 'transport.list';
  system: string;
  query?: string;
  maxResults?: number;
}

export interface TransportFindRequest {
  cmd: 'transport.find';
  system: string;
  ref: ObjectRef;
  /** The object's package. */
  package: string;
  isCreation: boolean;
}

export interface TransportCheckRequest {
  cmd: 'transport.check';
  system: string;
  ref: ObjectRef;
  operation?: 'CREATE' | 'MODIFY' | 'DELETE';
  transportLayer?: string;
  recordChanges?: boolean;
}

export interface TransportReadRequest {
  cmd: 'transport.read';
  system: string;
  /** A request or task number. */
  transport: string;
}

export interface TransportDiffRequest {
  cmd: 'transport.diff';
  system: string;
  transport: string;
  /** `nextCursor` of the previous page; absent for the first, which also carries the supplement. */
  cursor?: string;
  /** Objects per page, 1–40 (adt-ls's default 40). */
  pageSize?: number;
}

export interface TransportCreateRequest {
  cmd: 'transport.create';
  system: string;
  ref: ObjectRef;
  /** The object's package. */
  package: string;
  transportDescription: string;
  isCreation: boolean;
}

export interface TransportAssignRequest {
  cmd: 'transport.assign';
  system: string;
  ref: ObjectRef;
  transport: string;
}

export interface TransportReleaseRequest {
  cmd: 'transport.release';
  system: string;
  transport: string;
  confirm?: boolean;
}

// --- object -----------------------------------------------------------

export interface ObjectCreateRequest {
  cmd: 'object.create';
  system: string;
  ref: ObjectRef;
  /** The package the object lands in; for a package (DEVC) its superpackage. */
  package: string;
  description: string;
  transport?: string;
  /** A source-based type's creation fields (the SDK's). */
  additionalFields?: Record<string, unknown>;
  /** A form-based type's fields as its AFF JSON (`capabilities/properties.ts`, ADR-018). */
  properties?: Record<string, unknown>;
}

/** A create checked by SAP without creating anything; packages only so far (ADR-018). */
export interface ObjectValidateRequest {
  cmd: 'object.validate';
  system: string;
  ref: ObjectRef;
  package: string;
  description: string;
  transport?: string;
  properties?: Record<string, unknown>;
}

/**
 * Change an object: `source` for a source-based one (`include` for a class include), or
 * `properties`, AFF JSON merged by key, for a form-based one (MSAG, DEVC; ADR-018).
 */
export interface ObjectUpdateRequest {
  cmd: 'object.update';
  system: string;
  ref: ObjectRef;
  source?: string;
  include?: string;
  properties?: Record<string, unknown>;
  /** The request to record the change in when the object is in no open request. */
  transport?: string;
  /** MCP: the mirror roots this session's mirror calls named; a mirror among them holding the object refuses the write (ADR-009). */
  mirrorRoots?: string[];
  /** With `mirrorRoots`: the client's workspace folders, which those roots must lie in. */
  workspaceFolders?: string[];
}

export interface ObjectActivateRequest {
  cmd: 'object.activate';
  system: string;
  refs: ObjectRef[];
  forceActivation?: boolean;
}

export interface ObjectListInactiveRequest {
  cmd: 'object.listInactive';
  system: string;
}

export interface ObjectDeleteRequest {
  cmd: 'object.delete';
  system: string;
  ref: ObjectRef;
  confirm?: boolean;
  /** The request to record the deletion in when the object is in no open request. */
  transport?: string;
}

export interface ObjectDeleteMessagesRequest {
  cmd: 'object.deleteMessages';
  system: string;
  name: string;
  numbers: Array<string | number>;
  confirm?: boolean;
  transport?: string;
  /** As for `object.update`. */
  mirrorRoots?: string[];
  workspaceFolders?: string[];
}

export interface ObjectLockStatusRequest {
  cmd: 'object.lockStatus';
  system: string;
  ref: ObjectRef;
}

export interface ObjectReadRequest {
  cmd: 'object.read';
  system: string;
  ref: ObjectRef;
  include?: string;
  /** `active`, `inactive` (default), or a released version's number from `object.versions` (`00001`…). */
  version?: string;
  method?: string;
  grep?: string;
  context?: number;
  fromLine?: number;
  toLine?: number;
  maxLines?: number;
  /** TRPR: the target language (BCP 47) whose pairs are read. */
  language?: string;
  /** TRPR: read the project's texts too, those with these statuses (ADR-019 §4). */
  translationStatus?: TranslationStatus[];
  /** TRPR texts: at most this many (default 100, at most 500; 0: the counts only). */
  maxResults?: number;
  /** TRPR texts: the `nextCursor` of the page before. */
  cursor?: string;
  /** MCP: the mirror roots this session's mirror calls named; a mirror among them holding the object adds a note. */
  mirrorRoots?: string[];
  /** With `mirrorRoots`: the client's workspace folders, which those roots must lie in. */
  workspaceFolders?: string[];
}

/** The translations of an object or a package (`DEVC/K`), from the projects that cover it (ADR-019 §3). */
export interface ObjectTranslationsRequest {
  cmd: 'object.translations';
  system: string;
  ref: ObjectRef;
  /** The target language, BCP 47. */
  language?: string;
  translationStatus?: TranslationStatus[];
  grep?: string;
  maxResults?: number;
  cursor?: string;
}

export interface ObjectVersionsRequest {
  cmd: 'object.versions';
  system: string;
  ref: ObjectRef;
  /** Classes: one include only; absent: the main source and every include. */
  include?: string;
  maxResults?: number;
}

export interface ObjectDiffRequest {
  cmd: 'object.diff';
  system: string;
  ref: ObjectRef;
  include?: string;
  /** The newer side: a version number, `active` or `inactive` (default). */
  version?: string;
  /** The older side; default the numbered version before `version`. */
  baseVersion?: string;
  context?: number;
  maxLines?: number;
}

export interface ObjectResolveRequest {
  cmd: 'object.resolve';
  system: string;
  ref: ObjectRef;
}

export interface ObjectSearchRequest {
  cmd: 'object.search';
  system: string;
  query: string;
  objectType?: string;
  maxResults?: number;
}

export interface ObjectListRequest {
  cmd: 'object.list';
  system: string;
  package: string;
  path?: string[];
  depth?: number;
  maxRequests?: number;
}

/** Publish or unpublish a service binding (SRVB); refused when it is already there (ADR-018). */
export interface ObjectPublishServiceRequest {
  cmd: 'object.publish' | 'object.unpublish';
  system: string;
  ref: ObjectRef;
  confirm?: boolean;
  /**
   * Keep re-sending a toggle the backend refuses instantly, for this long — the
   * cloud un-publish refusal documented on `capabilities/object.ts sendToggle`.
   * Omitted: fail on the first refusal.
   */
  settleTimeoutMs?: number;
}

/** The RAP generators the system offers (`capabilities/rap.ts`). */
export interface ObjectGeneratorsRequest {
  cmd: 'object.generators';
  system: string;
}

export interface ObjectGeneratorSchemaRequest {
  cmd: 'object.generatorSchema';
  system: string;
  generatorId: string;
  package: string;
  referencedObject?: ObjectRef;
}

/** Run a RAP generator into a package (a write: the package must be in the allowlist). */
export interface ObjectGenerateRequest {
  cmd: 'object.generate';
  system: string;
  generatorId: string;
  package: string;
  referencedObject?: ObjectRef;
  /** As `object.generatorSchema` proposes it; omitted: that proposal unchanged. */
  content?: Record<string, unknown>;
  transport?: string;
}

/** A service binding's OData services, URL and entity sets. */
export interface ObjectServiceInfoRequest {
  cmd: 'object.serviceInfo';
  system: string;
  ref: ObjectRef;
  service?: string;
}

/** Apply an ATC worklist's deterministic quick fixes (`quality.atc` with `quickfixes`). */
export interface ObjectApplyQuickfixesRequest {
  cmd: 'object.applyQuickfixes';
  system: string;
  worklistId: string;
  transport?: string;
  /** As for `object.update`: a mirror among them holding a worklist object refuses the fixes (ADR-009). */
  mirrorRoots?: string[];
  workspaceFolders?: string[];
}

// --- navigate -----------------------------------------------------------

/** Where to point a position-based query: a symbol name, or 1-based line + character. */
export interface NavigateLocator {
  symbol?: string;
  line?: number;
  character?: number;
}

export interface NavigateWhereUsedRequest extends NavigateLocator {
  cmd: 'navigate.whereUsed';
  system: string;
  ref: ObjectRef;
  timeoutMs?: number;
  scanSource?: boolean;
}

export interface NavigateDefinitionRequest extends NavigateLocator {
  cmd: 'navigate.definition';
  system: string;
  ref: ObjectRef;
}

export interface NavigateDeclarationRequest extends NavigateLocator {
  cmd: 'navigate.declaration';
  system: string;
  ref: ObjectRef;
}

export interface NavigateHoverRequest extends NavigateLocator {
  cmd: 'navigate.hover';
  system: string;
  ref: ObjectRef;
}

export interface NavigateOutlineRequest {
  cmd: 'navigate.outline';
  system: string;
  ref: ObjectRef;
}

export interface NavigateTypeHierarchyRequest extends NavigateLocator {
  cmd: 'navigate.typeHierarchy';
  system: string;
  ref: ObjectRef;
  direction?: 'supertypes' | 'subtypes' | 'both';
}

/**
 * What a check runs over: one `ref` (the check's own result), or `refs` / a
 * `package`'s objects (one batch summary, `capabilities/quality.ts`). Exactly one.
 */
export interface CheckTargets {
  ref?: ObjectRef;
  refs?: ObjectRef[];
  package?: string;
  /** With `package`: its subpackages' objects too. Default false. */
  subpackages?: boolean;
}

export interface QualitySyntaxRequest extends CheckTargets {
  cmd: 'quality.syntax';
  system: string;
  /** With `ref` only: check this text as the object's source instead of the stored one (REST check run). */
  source?: string;
  /** With `source`, classes only: the include the text is for; omit for the main source. */
  include?: string;
}

export interface QualityFormatRequest {
  cmd: 'quality.format';
  system: string;
  ref: ObjectRef;
  /** Text to format as the object's source instead of the stored one; nothing is saved. */
  source?: string;
}

// --- run -----------------------------------------------------------

export interface RunApplicationRequest {
  cmd: 'run.application';
  system: string;
  ref: ObjectRef;
  confirm?: boolean;
}

// --- data -----------------------------------------------------------

/** One ABAP SQL SELECT through ADT's data preview (ADR-013). */
export interface DataQueryRequest {
  cmd: 'data.query';
  system: string;
  /** The SELECT, without INTO. */
  statement: string;
  /** Rows to return, default 100, at most 1000. */
  maxRows?: number;
}

// --- runtime -----------------------------------------------------------

/** Short dumps, metadata only (ADR-015). */
export interface RuntimeDumpsRequest {
  cmd: 'runtime.dumps';
  system: string;
  /** Default the logon user; `*` everyone's. */
  user?: string;
  from?: string;
  to?: string;
  maxResults?: number;
}

/** One short dump by its id from `runtime.dumps` (ADR-015). */
export interface RuntimeDumpRequest {
  cmd: 'runtime.dump';
  system: string;
  id: string;
  chapters?: string[];
}

/** Gateway errors, metadata only (ADR-015). */
export interface RuntimeGatewayErrorsRequest {
  cmd: 'runtime.gatewayErrors';
  system: string;
  /** Default the logon user; `*` everyone's. */
  user?: string;
  from?: string;
  to?: string;
  maxResults?: number;
}

/** One gateway error by its id from `runtime.gatewayErrors` (ADR-015). */
export interface RuntimeGatewayErrorRequest {
  cmd: 'runtime.gatewayError';
  system: string;
  id: string;
  /** Section names or titles instead of all of them. */
  sections?: string[];
}

/** System messages (SM02), in full, without a switch (ADR-018). */
export interface SystemMessagesRequest {
  cmd: 'system.messages';
  system: string;
}

// --- quality -----------------------------------------------------------

export interface QualityAtcVariantsRequest {
  cmd: 'quality.atcVariants';
  system: string;
  ref: ObjectRef;
}

export interface QualityAtcRequest extends CheckTargets {
  cmd: 'quality.atc';
  system: string;
  checkVariant?: string;
  timeoutMs?: number;
  /** Run through SAP's worklist instead: findings say whether a quick fix exists, no line numbers. */
  quickfixes?: boolean;
}

export interface TestUnitRequest {
  cmd: 'test.unit';
  system: string;
  ref: ObjectRef;
  coverage?: boolean;
}

export interface QualityAbaplintRequest extends CheckTargets {
  cmd: 'quality.abaplint';
  system: string;
  /** abaplint rule switches on top of the default (`mirror/lint.ts`). */
  rules?: Record<string, boolean>;
}

// --- mirror -----------------------------------------------------------

/** Where a mirror lives: an absolute root, which must lie inside one of the client's workspace folders. */
export interface MirrorLocationFields {
  root: string;
  /** MCP: the client's `file:` roots; CLI: the working folder. */
  workspaceFolders: string[];
}

export interface MirrorInitRequest extends MirrorLocationFields {
  cmd: 'mirror.init';
  system: string;
  package: string;
  /** Default true. */
  subpackages?: boolean;
}

export interface MirrorPullRequest extends MirrorLocationFields {
  cmd: 'mirror.pull';
  system: string;
  /** Overrides the system's `mirror.maxObjects` for this call. */
  maxObjects?: number;
  /** Re-read only these manifest objects (`CLAS ZCL_X`), without the walk (`mirror/pull.ts`). */
  objects?: string[];
  /** With `objects`: more to re-read, best effort; one that can't be found is skipped. */
  bestEffort?: string[];
  /** Without `objects`: what a resumed pull reads again though the stopped pull read it. */
  reread?: string[];
}

/** A change stamp per object of the mirror's packages (REST `changedAt`, `mirror/changes.ts`); reads only. */
export interface MirrorChangesRequest extends MirrorLocationFields {
  cmd: 'mirror.changes';
  system: string;
  /** Overrides the system's `mirror.maxObjects` for this call. */
  maxObjects?: number;
}

/** The root packages of a software component (`mirror/component.ts`, G4); reads only. */
export interface SwcPackagesRequest {
  cmd: 'swc.packages';
  system: string;
  component: string;
  /** Overrides the system's `mirror.maxObjects` for this call. */
  maxObjects?: number;
}

/** The released versions of a mirror's source files, kept under its `history/` (`mirror/history.ts`, G6); reads only. */
export interface HistoryVersionsRequest extends MirrorLocationFields {
  cmd: 'history.versions';
  system: string;
  /** Identifies the read: an index from another run is started over. */
  run: string;
  /** ISO time: versions released before it are left out. */
  since: string;
  /** Mirror ids to read; absent: every object. */
  objects?: string[];
  /** Requests already in git: their versions aren't read. */
  known?: string[];
}

/** The requests released in the last two weeks, with their objects (`mirror/history.ts`, G6); reads only. */
export interface HistoryReleasedRequest {
  cmd: 'history.released';
  system: string;
}

/** Local only: no system, no SAP call. */
export interface MirrorStatusRequest extends MirrorLocationFields {
  cmd: 'mirror.status';
}

/** Local only: each object is linted at the language version its `.json` names, else the system's (`systemLanguageVersion`); no SAP call. */
export interface MirrorCheckRequest extends MirrorLocationFields {
  cmd: 'mirror.check';
  system: string;
  /** abaplint rule switches on top of the default (`mirror/lint.ts`). */
  rules?: Record<string, boolean>;
}

/** Local only: AFF skeleton files for a new object; a cloud system's language version, none on premise (the package default applies). */
export interface MirrorNewRequest extends MirrorLocationFields {
  cmd: 'mirror.new';
  system: string;
  type: string;
  name: string;
  /** Default: the mirror's root package, when it has one. */
  package?: string;
  description?: string;
}

/** Writes the mirror's changed objects back (ADR-007 "Push"); a dry run makes no SAP call. */
export interface MirrorPushRequest extends MirrorLocationFields {
  cmd: 'mirror.push';
  system: string;
  dryRun?: boolean;
  /** Activate what was written. Default true. */
  activate?: boolean;
  /** Record an object that is in no open request in this one (assigned on its first refused write). */
  transport?: string;
  /** Overrides the system's `mirror.maxObjects` for this call. */
  maxObjects?: number;
  /** After each write the local file takes the system's read-back (the git helper's shadow, ADR-011). */
  takeSystemVersion?: boolean;
}

/** Activates the objects a push wrote and didn't activate. */
export interface MirrorActivateRequest extends MirrorLocationFields {
  cmd: 'mirror.activate';
  system: string;
}

/** Which entry point sent a request; recorded by the call log (ADTPLUS_LOG). Optional so older callers keep working. */
export type ClientKind = 'mcp' | 'cli' | 'git';

export type DaemonRequest = (
  | StatusRequest
  | ConnectRequest
  | PingRequest
  | ShutdownRequest
  | TransportListRequest
  | TransportFindRequest
  | TransportCheckRequest
  | TransportReadRequest
  | TransportDiffRequest
  | TransportCreateRequest
  | TransportAssignRequest
  | TransportReleaseRequest
  | ObjectCreateRequest
  | ObjectValidateRequest
  | ObjectUpdateRequest
  | ObjectActivateRequest
  | ObjectListInactiveRequest
  | ObjectDeleteRequest
  | ObjectDeleteMessagesRequest
  | ObjectLockStatusRequest
  | ObjectReadRequest
  | ObjectTranslationsRequest
  | ObjectVersionsRequest
  | ObjectDiffRequest
  | ObjectResolveRequest
  | ObjectSearchRequest
  | ObjectListRequest
  | ObjectPublishServiceRequest
  | ObjectGeneratorsRequest
  | ObjectGeneratorSchemaRequest
  | ObjectGenerateRequest
  | ObjectServiceInfoRequest
  | ObjectApplyQuickfixesRequest
  | NavigateWhereUsedRequest
  | NavigateDefinitionRequest
  | NavigateDeclarationRequest
  | NavigateHoverRequest
  | NavigateOutlineRequest
  | NavigateTypeHierarchyRequest
  | QualitySyntaxRequest
  | QualityFormatRequest
  | RunApplicationRequest
  | DataQueryRequest
  | RuntimeDumpsRequest
  | RuntimeDumpRequest
  | RuntimeGatewayErrorsRequest
  | RuntimeGatewayErrorRequest
  | SystemMessagesRequest
  | QualityAtcVariantsRequest
  | QualityAtcRequest
  | TestUnitRequest
  | QualityAbaplintRequest
  | MirrorInitRequest
  | MirrorPullRequest
  | MirrorChangesRequest
  | SwcPackagesRequest
  | HistoryVersionsRequest
  | HistoryReleasedRequest
  | MirrorStatusRequest
  | MirrorCheckRequest
  | MirrorNewRequest
  | MirrorPushRequest
  | MirrorActivateRequest
) & {
  client?: ClientKind;
  /** Set by a client running under ADTPLUS_READONLY: the daemon refuses anything but a read (see readonly.ts). */
  readOnly?: boolean;
  /** Set by a client running under ADTPLUS_DENY: command patterns the daemon refuses (see deny.ts). */
  deny?: string[];
  /** The project configs the client found, nearest first: paths only, the daemon reads them itself (ADR-006). */
  projectConfigs?: string[];
  /** Instead of `projectConfigs`, one such list per workspace folder when a client has several that differ. */
  projectConfigSets?: string[][];
  /** The client shows progress: a long command sends `ProgressLine`s before its answer. */
  progress?: boolean;
};

/** A step of a long command (`mirror.changes`, `mirror.push`): `done` of `total` in its `stage`. */
export interface DaemonProgress {
  stage: string;
  done: number;
  total: number;
  units?: number;
}

/** Sent before the answer to a request with `progress: true`; the answer is the first other line. */
export interface ProgressLine {
  progress: DaemonProgress;
}

/** Every daemon command. The type below fails to compile when a command is missing from this list. */
export const ALL_CMDS = [
  'system.status',
  'system.connect',
  'ping',
  'shutdown',
  'transport.list',
  'transport.find',
  'transport.check',
  'transport.read',
  'transport.diff',
  'transport.create',
  'transport.assign',
  'transport.release',
  'object.create',
  'object.validate',
  'object.update',
  'object.activate',
  'object.listInactive',
  'object.delete',
  'object.deleteMessages',
  'object.lockStatus',
  'object.read',
  'object.translations',
  'object.versions',
  'object.diff',
  'object.resolve',
  'object.search',
  'object.list',
  'object.publish',
  'object.unpublish',
  'object.generators',
  'object.generatorSchema',
  'object.generate',
  'object.serviceInfo',
  'object.applyQuickfixes',
  'navigate.whereUsed',
  'navigate.definition',
  'navigate.declaration',
  'navigate.hover',
  'navigate.outline',
  'navigate.typeHierarchy',
  'quality.syntax',
  'quality.format',
  'run.application',
  'data.query',
  'runtime.dumps',
  'runtime.dump',
  'runtime.gatewayErrors',
  'runtime.gatewayError',
  'system.messages',
  'quality.atcVariants',
  'quality.atc',
  'test.unit',
  'quality.abaplint',
  'mirror.init',
  'mirror.pull',
  'mirror.changes',
  'swc.packages',
  'history.versions',
  'history.released',
  'mirror.status',
  'mirror.check',
  'mirror.new',
  'mirror.push',
  'mirror.activate',
] as const satisfies readonly DaemonRequest['cmd'][];

/** Commands only the git remote helper sends (ADR-011): no MCP tool, no CLI subcommand. */
export const GIT_ONLY_CMDS: readonly DaemonRequest['cmd'][] = ['mirror.changes', 'swc.packages', 'history.versions', 'history.released'];

type MissingCmd = Exclude<DaemonRequest['cmd'], (typeof ALL_CMDS)[number]>;
const allCmdsComplete: [MissingCmd] extends [never] ? true : MissingCmd = true;
void allCmdsComplete;

export interface StatusResponse {
  ok: true;
  /** The daemon's own read-only mode (ADTPLUS_READONLY at start). */
  readOnly?: boolean;
  /** The daemon's own deny list (ADTPLUS_DENY at start). */
  deny?: string[];
  /** Per system this client sees (its project configs included): the session, null until connected. */
  sessions: Record<string, SessionInfo | null>;
  /** The config files this client's systems come from, and the systems refused (ADR-006). */
  config?: {
    files: { path: string; kind: 'user' | 'project'; trusted: boolean }[];
    refused: Record<string, string>;
    /** Per system, the project configs that set any of its fields. */
    projectFiles: Record<string, string[]>;
    /** The config didn't load; `sessions` is then empty. */
    error?: string;
  };
  /** REST-fallback sessions (ADR-001): null until a fallback — or, on
   * interactive systems, the adt-ls logon riding on it — first needs one. */
  restSessions: Record<string, RestSessionInfo | null>;
  /** Native-support probe per system; null until a fallback call probed it. */
  native: Record<string, NativeSupport | null>;
  /** The system clock per system (ADR-016); null until a call reporting a time measured it. */
  clocks: Record<string, ClockRead | null>;
  /** The OData UI service check per system (ADR-019 §6); null until a translation call checked it. */
  serviceChecks?: Record<string, ServiceCheck | null>;
  /** Which adt-ls adt+ runs on and whether it is the verified release. */
  adtLs: AdtLsInfo;
  /** Present when something needs the user's attention (an unverified adt-ls). */
  warnings?: string[];
  uptimeMs: number;
  pid: number;
  identity: DaemonIdentity;
}

export interface ConnectResponse {
  ok: true;
  session: SessionInfo;
  warnings?: string[];
}

export interface PongResponse {
  ok: true;
  pong: true;
  /** Absent from daemons that predate the restart handshake. */
  identity?: DaemonIdentity;
  pid?: number;
}

export interface ShutdownResponse {
  ok: true;
  /** false: the daemon already matched `unless` and keeps running. */
  shuttingDown: boolean;
}

/** Generic envelope for every capability command below — the result shape
 * is whatever that capability function returns (see src/capabilities/*.ts). */
export interface ResultResponse {
  ok: true;
  result: unknown;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  /** The per-system rate limit refused the command (daemon/ratelimit.ts). Nothing was queued. */
  throttled?: true;
  /** With `throttled`: when a retry can be admitted. */
  retryAfterMs?: number;
}

export type DaemonResponse =
  | StatusResponse
  | ConnectResponse
  | PongResponse
  | ShutdownResponse
  | ResultResponse
  | ErrorResponse;

/** Unix socket path both the daemon and its clients use to find each other. */
export function resolveSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) return path.join(runtimeDir, 'adtplus.sock');
  return path.join(homedir(), '.cache', 'adtplus', 'adtplus.sock');
}
