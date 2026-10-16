import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import { decodeXml, startTags, type RawAdtClient } from '../backends/rawadt.js';
import type { NativeSupport } from '../core/capabilities.js';
import type { Destination } from '../core/destinations.js';
import { lookupPackageChain } from '../core/placement.js';
import { resolveObject } from '../core/resolve.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { CREATION_TYPES } from '../mirror/create.js';
import { read as readTransport } from './transport-diff.js';
import { assertConfirmed, assertObjectWritable, assertPackageWritable } from './policy.js';

export interface TransportListInput {
  query?: string;
  limit?: number;
}

export async function list(adt: AdtLsClient, input: TransportListInput = {}): Promise<unknown> {
  return adt.transport.list(input);
}

export interface TransportFindInput {
  objectName: string;
  objectType: string;
  developmentPackage: string;
  isCreation: boolean;
}

export async function find(adt: AdtLsClient, input: TransportFindInput): Promise<unknown> {
  return adt.transport.find(input);
}

export interface TransportCheckInput extends ObjectRef {
  operation?: 'CREATE' | 'MODIFY' | 'DELETE';
  transportLayer?: string;
  recordChanges?: boolean;
}

export async function check(adt: AdtLsClient, input: TransportCheckInput): Promise<unknown> {
  return adt.transport.check(input);
}

export interface TransportCreateInput {
  developmentPackage: string;
  transportDescription: string;
  isCreation: boolean;
  objectName: string;
  objectType: string;
}

/**
 * The object type with its subtype: adt-ls's `create_transport` takes `CLAS/OC` but answers a bare
 * `CLAS` with "Failed to read object type info from registry for type CLAS".
 */
export function withSubtype(objectType: string): string {
  if (objectType.includes('/')) return objectType;
  const full = CREATION_TYPES[objectType.toUpperCase()];
  if (full) return full;
  throw new Error(`object type "${objectType}": give it with its subtype (e.g. CLAS/OC, DDLS/DF); adt-ls doesn't take a bare type here`);
}

/**
 * Refuses a write outside `destination.writeAllowlist`: for a new object the
 * package it will be created in, for an existing one the package it actually
 * sits in — not the `developmentPackage` the caller claims.
 */
export async function create(
  adt: AdtLsClient,
  destination: Destination,
  input: TransportCreateInput,
): Promise<unknown> {
  const objectType = withSubtype(input.objectType);
  if (input.isCreation) {
    await assertPackageWritable(destination, input.developmentPackage, { lookupChain: lookupPackageChain(adt) });
  } else {
    const resolved = await resolveObject(adt, { name: input.objectName, objectType });
    await assertObjectWritable(destination, resolved);
  }
  return adt.transport.create({ ...input, objectType });
}

/**
 * adt-ls's error code for a write or delete of an object that is in no open
 * transport request: "Object not assigned to a transport" (`onprem`).
 */
export const NOT_IN_TRANSPORT = 1001;

export function isNotInTransport(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === NOT_IN_TRANSPORT;
}

/**
 * Assign `transport` to the file at `objectUri` for its next write: adt-ls
 * keeps the choice in that file's lock result, and the next write of that file
 * records the object in the request (ADT for VS Code's own save path). A write
 * of another file of the object (a class include, the `.json`) doesn't see it. A
 * `checkTransportForObjectLock` between the assign and the write cancels it, so
 * there is no read-back here. The SDK's typed `transport.assign` reads back and
 * so cancels itself; this raw call is the ADR-004 workaround until upstream
 * offers an assign without the read-back (backlog, "Upstream issues to file").
 */
export async function assignForNextWrite(adt: AdtLsClient, objectUri: string, transport: string): Promise<void> {
  await adt.raw.lsp('adtLs/cts/transport/assignTransportToObject', { objectUri, transport: transport.toUpperCase() });
}

/**
 * Run `write`; when it answers 1001 (the object is in no open request), `assign` gives the written
 * file `transport` and the write is sent once more. Without a transport the 1001 goes to the
 * caller. adt-ls reads the request from the stored lock result of the file it writes, so
 * `assign` names that file, not the object's main source.
 */
export async function writeAssigning<T>(
  write: () => Promise<T>,
  transport: string | undefined,
  assign: (transport: string) => Promise<void>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (!isNotInTransport(err) || !transport) throw err;
    await assign(transport.toUpperCase());
    try {
      return await write();
    } catch (again) {
      if (!isNotInTransport(again)) throw again;
      const text = again instanceof Error ? again.message : String(again);
      throw new Error(`transport ${transport.toUpperCase()} was not taken (does it exist, is it modifiable and yours?): ${text}`);
    }
  }
}

export interface TransportAssignInput extends ObjectRef {
  transport: string;
}

export interface TransportAssignResult {
  /**
   * `true`: SAP shows the lock in the request. `'onNextWrite'`: the object was in no open request;
   * adt-ls holds the assignment, and the object's next write through adt+ records it there.
   */
  assigned: true | 'onNextWrite';
  object: string;
  objectType: string;
  transport: string;
  /** The request SAP reports the lock in — `transport` itself, or its parent when a task was given; null until the next write. */
  lockedIn: string | null;
  /** Files of an object in no open request adt-ls refused the assignment for: a write of one answers "not assigned". */
  unassigned?: string[];
  note?: string;
}

/**
 * The object's CTS state from the typed check (harmless before an assign): its lock's requests, and
 * whether it records at all. `onprem` answers `isRecordingRequired: false` also for an object already
 * locked in an open request, so only `recording: false` with no lock means a package that records
 * nothing.
 */
async function ctsState(adt: AdtLsClient, ref: ObjectRef & { uri: string }): Promise<{ locks: string[]; recording: boolean }> {
  const r = (await adt.transport.check({ ...ref, operation: 'MODIFY' })) as {
    isRecordingRequired?: boolean;
    locks?: Array<{ number?: string }>;
  } | null;
  return {
    locks: (r?.locks ?? []).map((l) => l.number?.toUpperCase()).filter((n): n is string => Boolean(n)),
    recording: r?.isRecordingRequired !== false,
  };
}

/**
 * The other files adt+ writes of the object whose main source is `mainUri`: those named
 * `<name>.<type>.…` like it (a function module's folder is its group's, shared with the other
 * modules), not `.jsonc` stubs or `.properties` (read-only, ADR-007; adt-ls refuses an assignment
 * on one nothing has read yet, "The Semantic file store doesn't exist"). File names; none when the
 * folder can't be read.
 */
async function otherFiles(adt: AdtLsClient, mainUri: string): Promise<string[]> {
  const folder = mainUri.slice(0, mainUri.lastIndexOf('/') + 1);
  const mainName = decodeURIComponent(mainUri.slice(folder.length)).toLowerCase();
  const prefix = mainName.split('.').slice(0, 2).join('.') + '.';
  try {
    return (await adt.repository.readDirectory(folder))
      .filter((c) => c.kind === 'file' && !/\.(jsonc|properties)$/.test(c.name))
      .map((c) => c.name)
      .filter((name) => name.toLowerCase().startsWith(prefix) && name.toLowerCase() !== mainName);
  } catch {
    return [];
  }
}

/**
 * Assign an existing transport to an object.
 *
 * An object already locked in a request goes through the SDK, which reads the
 * CTS lock back (adt-ls#13); success is decided here from that `lockedIn`,
 * because the SDK's `assigned` flag is also true when the lock names another
 * request. The read-back names the lock's **request**, so a task number only
 * matches through its parent: `readTasks` lists a request's tasks (REST,
 * supplied by the daemon).
 *
 * An object in no open request can't be confirmed that way: the assignment
 * takes effect with its next write, and any lock check before that write
 * cancels it. Each of its
 * files is assigned for its next write (`assignForNextWrite`; adt-ls keeps an
 * assignment per file) and
 * the object reported as such.
 */
export async function assign(
  adt: AdtLsClient,
  destination: Destination,
  input: TransportAssignInput,
  readTasks?: (request: string) => Promise<string[]>,
): Promise<TransportAssignResult> {
  const resolved = await resolveObject(adt, input);
  await assertObjectWritable(destination, resolved);
  const transport = input.transport.toUpperCase();
  const ref = { name: input.name, objectType: input.objectType, uri: resolved.uri };

  const cts = await ctsState(adt, ref);
  if (!cts.recording && cts.locks.length === 0) {
    throw new Error(`${input.objectType} "${input.name}" needs no transport: its package records no changes (local package or $TMP)`);
  }
  if (cts.locks.length === 0) {
    // adt-ls keeps an assignment per file, so every file adt+ writes gets one: the next write of any
    // of them records the object. Costs no SAP request (adt-ls only stores it). The main source's
    // must take; another file's failing costs only that file's.
    await assignForNextWrite(adt, resolved.uri, transport);
    const folder = resolved.uri.slice(0, resolved.uri.lastIndexOf('/') + 1);
    const unassigned: string[] = [];
    for (const name of await otherFiles(adt, resolved.uri)) {
      await assignForNextWrite(adt, folder + encodeURIComponent(name), transport).catch(() => unassigned.push(name));
    }
    return {
      assigned: 'onNextWrite',
      object: input.name,
      objectType: input.objectType,
      transport,
      lockedIn: null,
      ...(unassigned.length ? { unassigned } : {}),
      note:
        `${input.objectType} "${input.name}" is in no open request: the next write of any of its files through adt+ ` +
        `(object update, mirror push) records it in ${transport}` +
        (unassigned.length ? ` (not ${unassigned.join(', ')}: adt-ls refused those, a write of one answers "not assigned")` : '') +
        `. A transport check before that write cancels the assignment, and a request that doesn't exist or isn't ` +
        `modifiable fails only at that write. Each file keeps its assignment in this adt+ session until its own next ` +
        `write, also after another file's write recorded the object.`,
    };
  }

  const result = await adt.transport.assign({ ...ref, transport });
  const locks = result.lockedIn.map((n) => n.toUpperCase());

  let lockedIn = locks.find((n) => n === transport);
  if (!lockedIn && readTasks) {
    for (const request of locks) {
      if ((await readTasks(request)).some((t) => t.toUpperCase() === transport)) {
        lockedIn = request;
        break;
      }
    }
  }
  if (!lockedIn) {
    const seen = locks.length ? `SAP shows it locked in ${locks.join(', ')}` : 'SAP shows no lock on it';
    throw new Error(
      `transport ${transport} was not assigned to ${input.objectType} "${input.name}": ${seen} ` +
        `(does ${transport} exist, and is it modifiable?)`,
    );
  }
  return { assigned: true, object: input.name, objectType: input.objectType, transport, lockedIn };
}

// --- release: REST fallback ------------------------------------------------
//
// adt-ls 1.1.2 has no release request.
// Protocol from ARC-1 (verified there on S/4HANA 2023), re-verified live by
// adt+ on `onprem` and `cloud-erp`:
//   GET  /sap/bc/adt/cts/transportrequests/{id}               → tm:request + tm:task attrs
//   POST /sap/bc/adt/cts/transportrequests/{id}/newreleasejobs → chkrun:checkReport per job
// SAP releases a request only once its tasks are released, so tasks go first.

const ORGANIZER_MEDIA_TYPE = 'application/vnd.sap.adt.transportorganizer.v1+xml';

function xmlAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) {
    attrs[m[1]!.replace(/^[\w]+:/, '')] = decodeXml(m[2]!);
  }
  return attrs;
}

export interface TransportTaskState {
  number: string;
  owner: string;
  status: string;
}

export interface TransportRequestState extends TransportTaskState {
  description: string;
  target: string;
  /** `tm:lastchanged_timestamp`, the system's local time (`YYYYMMDDhhmmss`): a released request's release. */
  lastChanged: string;
  tasks: TransportTaskState[];
}

/** Parse one request (and its tasks) out of an organizer document. */
export function parseTransportRequest(xml: string, id: string): TransportRequestState | undefined {
  const requests = [...xml.matchAll(/<tm:request\b[^>]*>[\s\S]*?<\/tm:request>/g)].map((m) => m[0]);
  const block = requests.find((r) => xmlAttrs(r.match(/<tm:request\b[^>]*>/)![0]).number === id);
  if (!block) return undefined;
  const head = xmlAttrs(block.match(/<tm:request\b[^>]*>/)![0]);
  return {
    number: head.number ?? id,
    owner: head.owner ?? '',
    status: head.status ?? '',
    description: head.desc ?? '',
    target: head.target ?? '',
    lastChanged: head.lastchanged_timestamp ?? '',
    tasks: [...block.matchAll(/<tm:task\b[^>]*>/g)].map((m) => {
      const t = xmlAttrs(m[0]);
      return { number: t.number ?? '', owner: t.owner ?? '', status: t.status ?? '' };
    }),
  };
}

/** The task numbers of one request, for `assign`'s read-back. */
export async function readRequestTasks(rest: RawAdtClient, request: string): Promise<string[]> {
  const detail = await rest.expectOk('GET', `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(request)}`, `read ${request}`, {
    headers: { Accept: ORGANIZER_MEDIA_TYPE },
  });
  return parseTransportRequest(detail.body, request)?.tasks.map((t) => t.number) ?? [];
}

export interface ReleaseReport {
  reporter: string;
  status: string;
  statusText: string;
  messages: { type: string; text: string }[];
}

export function parseReleaseReports(xml: string): ReleaseReport[] {
  return [...xml.matchAll(/<chkrun:checkReport\b(?:[^>"]|"[^"]*")*?(?:\/>|>[\s\S]*?<\/chkrun:checkReport>)/g)].map((m) => {
    const report = xmlAttrs(m[0].match(startTags('chkrun:checkReport'))![0]);
    return {
      reporter: report.reporter ?? '',
      status: report.status ?? '',
      statusText: report.statusText ?? '',
      messages: [...m[0].matchAll(startTags('chkrun:checkMessage'))].map((msg) => {
        const a = xmlAttrs(msg[0]);
        return { type: a.type ?? '', text: a.shortText ?? '' };
      }),
    };
  });
}

/** A report with a status other than "released" is a failed release. */
function failedReports(reports: ReleaseReport[]): ReleaseReport[] {
  return reports.filter((r) => r.status !== '' && r.status !== 'released');
}

async function releaseOne(rest: RawAdtClient, id: string): Promise<ReleaseReport[]> {
  const res = await rest.expectOk(
    'POST',
    `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(id)}/newreleasejobs`,
    `release ${id}`,
    { headers: { Accept: ORGANIZER_MEDIA_TYPE } },
  );
  return parseReleaseReports(res.body);
}

export interface TransportReleaseInput {
  transport: string;
  confirm?: boolean;
}

export interface TransportReleaseResult {
  transport: string;
  /** Set when `transport` is a task: its request, which stays open. */
  request?: string;
  target: string;
  /** The tasks released: a request's, before it; a task release names the task. */
  releasedTasks: string[];
  reports: ReleaseReport[];
  via: 'rest-fallback';
  nativeAvailable: boolean | null;
}

/** `D` modifiable, `L` modifiable but protected: what adt-ls's own list of modifiable requests shows. */
const MODIFIABLE = new Set(['D', 'L']);
/** Request types released here: workbench (`K`) and customizing (`W`); not transports of copies, relocations, … */
const RELEASABLE_REQUEST_TYPES = new Set(['K', 'W']);

/**
 * The logon user: ADT's system information (`userName`), else the configured basic-auth user. An
 * SSO system has no `user` in its config. The rate limit's refusal is passed on, never replaced.
 */
export async function logonUser(rest: RawAdtClient, destination: Destination): Promise<string | undefined> {
  try {
    const res = await rest.expectOk('GET', '/sap/bc/adt/core/http/systeminformation', 'read the logon user', {
      headers: { Accept: 'application/vnd.sap.adt.core.http.systeminformation.v1+json' },
    });
    const user = (JSON.parse(res.body) as { userName?: unknown }).userName;
    if (typeof user === 'string' && user) return user.toUpperCase();
  } catch (err) {
    if (err instanceof ThrottledError) throw err;
  }
  return destination.user?.toUpperCase();
}

/** The logon user per REST client (one per session): it doesn't change, so it is read once. */
const logonUsers = new WeakMap<RawAdtClient, string>();

export async function ownUser(rest: RawAdtClient, destination: Destination): Promise<string | undefined> {
  const known = logonUsers.get(rest);
  if (known) return known;
  const user = await logonUser(rest, destination);
  if (user) logonUsers.set(rest, user);
  return user;
}

function reportLines(reports: ReleaseReport[]): string {
  return reports
    .flatMap((r) => [`${r.reporter}: ${r.statusText || r.status}`, ...r.messages.map((m) => `  ${m.type} ${m.text}`)])
    .join('\n');
}

/**
 * Release one of the caller's own modifiable requests, or one of the caller's own modifiable tasks
 * (also in someone else's request, which stays open). Irreversible, so `confirm: true`, and owner
 * and status come from the organizer's read of the number, which names a task's request.
 *
 * A request's unreleased tasks go first. A task with objects whose release fails stops the
 * release with that task's report (`onprem` names the inactive object there; the request's own report
 * only says a task isn't released); a task holding only translations (`LANG`) has objects too.
 * An empty task can't release on its own; the request release folds it in. The request's own report decides success.
 */
export async function release(
  rest: RawAdtClient,
  destination: Destination,
  input: TransportReleaseInput,
  native?: NativeSupport,
): Promise<TransportReleaseResult> {
  assertConfirmed('transport release', input.confirm);
  const id = input.transport.toUpperCase();

  const [detail, user] = await Promise.all([readTransport(rest, id), logonUser(rest, destination)]);
  if (!user) throw new Error(`transport ${id}: the logon user is unknown, so its owner can't be checked`);
  const isTask = detail.request !== undefined || detail.tasks.some((t) => t.number === id);
  const kind = isTask ? 'task' : 'request';
  if (detail.owner.toUpperCase() !== user) {
    throw new Error(`${kind} ${id} belongs to ${detail.owner || 'no one'}, not ${user}: only your own ${kind}s are released`);
  }
  if (!MODIFIABLE.has(detail.status)) {
    throw new Error(`${kind} ${id} is not modifiable (status ${detail.status}${detail.statusText ? ` ${detail.statusText}` : ''})`);
  }
  if (!isTask && !RELEASABLE_REQUEST_TYPES.has(detail.type)) {
    throw new Error(`request ${id} is of type ${detail.type || 'unknown'}: only workbench (K) and customizing (W) requests are released`);
  }
  const result = { transport: id, target: detail.target, via: 'rest-fallback' as const, nativeAvailable: native?.transportRelease ?? null };

  if (isTask) {
    const reports = await releaseOne(rest, id);
    const failed = failedReports(reports);
    if (failed.length) throw new Error(`task ${id} was not released:\n${reportLines(failed)}`);
    return { ...result, ...(detail.request ? { request: detail.request } : {}), releasedTasks: [id], reports };
  }

  const releasedTasks: string[] = [];
  for (const task of detail.tasks) {
    if (task.status === 'R') continue;
    const failed = failedReports(await releaseOne(rest, task.number));
    if (!failed.length) releasedTasks.push(task.number);
    else if (task.objects.length) {
      const done = releasedTasks.length ? ` (released before it: ${releasedTasks.join(', ')})` : '';
      throw new Error(`transport ${id} was not released: its task ${task.number} failed${done}:\n${reportLines(failed)}`);
    }
  }

  const reports = await releaseOne(rest, id);
  const failed = failedReports(reports);
  if (failed.length) throw new Error(`transport ${id} was not released:\n${reportLines(failed)}`);
  return { ...result, releasedTasks, reports };
}
