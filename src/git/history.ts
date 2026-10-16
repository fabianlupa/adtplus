import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localToUtc } from '../core/clock.js';
import { blobPath, loadHistoryIndex, type HistoryReleasedResult, type HistoryRequest, type HistoryVersion, type HistoryVersionsResult, type ReleasedEntry } from '../mirror/history.js';
import { abapName, objectOfPath, parseId } from '../mirror/layout.js';
import type { Manifest } from '../mirror/manifest.js';
import { ident, type CommitSpec, type FileChange } from './fastimport.js';
import type { Git } from './git.js';

/**
 * Transport commits (docs/decisions/011-git-remote-helper.md, "History"; G6): with
 * `adtplus.history=transports`, one commit per released request, oldest first, before the sync
 * commit. A clone takes every request released since `adtplus.since` (default one year back) from
 * the version feeds of all its source files; a later fetch only the requests released since the
 * last one, found through the released-in-two-weeks list (a longer gap reads every feed again).
 * The requests git already holds (`Transport:` trailers) are never committed twice.
 */

export type HistoryMode = 'none' | 'transports';

export interface HistorySettings {
  mode: HistoryMode;
  /** ISO time: the clone's history starts here. */
  since: string;
}

const DAY = 24 * 3600 * 1000;
/** The released list covers two weeks; a fetch later than this reads every feed. */
const RELEASED_DAYS = 13;

/** `adtplus.history` and `adtplus.since` from git config. */
export async function historySettings(git: Git, now: Date): Promise<HistorySettings> {
  const mode = (await git.config('adtplus.history')) ?? 'none';
  if (mode !== 'none' && mode !== 'transports') throw new Error(`adtplus.history must be none or transports, not "${mode}"`);
  const value = await git.config('adtplus.since');
  // A day, not a moment: a stopped clone resumes the same read on the same day.
  if (value === undefined) return { mode, since: `${new Date(now.getTime() - 365 * DAY).toISOString().slice(0, 10)}T00:00:00.000Z` };
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`adtplus.since must be a date (2025-10-01), not "${value}"`);
  return { mode, since: new Date(at).toISOString() };
}

/** `<shadow>/history.json`: where the history began and when the last fetch looked for releases. */
export interface HistoryState {
  since: string;
  checkedAt: string;
  /** Objects whose versions didn't read, and from when: the next fetch reads them again. */
  retry?: { objects: string[]; since: string };
}

const STATE = 'history.json';

export async function readHistoryState(root: string): Promise<HistoryState | undefined> {
  try {
    return JSON.parse(await readFile(path.join(root, STATE), 'utf8')) as HistoryState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

async function writeHistoryState(root: string, state: HistoryState): Promise<void> {
  await writeFile(path.join(root, STATE), `${JSON.stringify(state)}\n`);
}

/**
 * Which objects a released list's entry may stand for, by name: an `R3TR` entry its object, a
 * `LIMU` part its owner (a method `ZCL_X<padding>METHOD` or an include `ZCL_X=====CCAU` its class, `REPS`/`FUNC` a program or a
 * function group's include or module). More than needed only costs feed reads.
 */
export function ownersOfEntry(entry: ReleasedEntry, ids: string[], parts: Map<string, string>): string[] {
  const name = entry.name.toUpperCase();
  // A class include's name pads the class with `=` up to its suffix: `ZCL_X=====CCAU`.
  const names = new Set([name.trim(), name.slice(0, 30).trim(), name.replace(/=+[^=]*$/, '').trim()]);
  const found = new Set<string>();
  for (const id of ids) {
    const parsed = parseId(id);
    if (!parsed || !names.has(parsed.name)) continue;
    if (entry.pgmid === 'LIMU' || parsed.type.startsWith(entry.type) || entry.type.startsWith(parsed.type)) found.add(id);
  }
  for (const name of names) {
    const group = parts.get(name);
    if (group) found.add(group);
  }
  return [...found].sort();
}

/** A function group's parts by name (`LZFGTOP`, `Z_FM`) → the group's id, from the manifest's file names. */
export function groupParts(manifest: Manifest): Map<string, string> {
  const parts = new Map<string, string>();
  for (const [id, o] of Object.entries(manifest.objects)) {
    if (!id.startsWith('FUGR ')) continue;
    for (const file of Object.keys(o.files)) {
      const m = file.match(/^[^.]+\.fugr\.([^.]+)\.(reps|func)\.abap$/i);
      if (m) parts.set(abapName(m[1]!), id);
    }
  }
  return parts;
}

export interface TransportDeps {
  /** One daemon call: the result, or throws. */
  call: <T>(req: Record<string, unknown> & { cmd: string }) => Promise<T>;
  git: Git;
  system: string;
  root: string;
  workspace: string;
  say: (line: string) => void;
  warn: (line: string) => void;
  /** Runs the read, showing its progress. */
  watch: <T>(total: number, run: () => Promise<T>) => Promise<T>;
  now: Date;
}

export interface TransportCommits {
  commits: CommitSpec[];
  /** The tree after them, by path → blob SHA (the tip's when there are none). */
  tree: Map<string, string>;
}

/**
 * The requests' commits from the versions read, oldest first, each on top of `tree`. A request is
 * dated by its release in the system's local time less the clock's offset (`clockOffsetMinutes`,
 * docs/tools/git-remote-helper.md, "Known issues"), else by its versions' feed time.
 */
export async function buildCommits(
  deps: Pick<TransportDeps, 'root' | 'system'>,
  ref: string,
  tip: string | undefined,
  versions: HistoryVersion[],
  requests: Record<string, HistoryRequest>,
  deletions: Map<string, string[]>,
  tree: Map<string, string>,
  clockOffsetMinutes?: number,
): Promise<TransportCommits> {
  const byRequest = new Map<string, HistoryVersion[]>();
  for (const v of versions) {
    const list = byRequest.get(v.request);
    if (list) list.push(v);
    else byRequest.set(v.request, [v]);
  }
  for (const request of deletions.keys()) if (!byRequest.has(request)) byRequest.set(request, []);
  // Each request's release time: its own when every request with versions has one, else its
  // versions' (all share it), never a mix: the feed's times run apart from the releases, which
  // could put two requests out of order. None for one that only deletes and has no time of its own.
  const released = (r: string) => (clockOffsetMinutes === undefined ? undefined : localToUtc(requests[r]?.releasedLocal, clockOffsetMinutes));
  const own = [...byRequest].every(([r, list]) => list.length === 0 || released(r) !== undefined);
  const times = new Map([...byRequest].map(([r, list]) => [r, (own ? released(r) : undefined) ?? list.reduce((t, v) => (v.at > t ? v.at : t), '')]));
  const at = (request: string) => times.get(request) ?? '';
  // Requests that only delete have no time of their own: last, in number order.
  const LAST = '\uffff';
  const order = [...byRequest.keys()].sort((a, b) => {
    const [x, y] = [at(a) || LAST, at(b) || LAST];
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  const commits: CommitSpec[] = [];
  const now = new Map(tree);
  let last = '';
  for (const request of order) {
    const list = byRequest.get(request)!;
    // A file twice in one request (never seen): its highest version.
    const newest = new Map<string, HistoryVersion>();
    for (const v of list) if (!newest.has(v.path) || newest.get(v.path)!.version < v.version) newest.set(v.path, v);
    const changes: FileChange[] = [];
    for (const v of [...newest.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      changes.push({ op: 'M', path: v.path, data: await readFile(blobPath(deps.root, v.blob)) });
      now.set(v.path, v.blob);
    }
    for (const p of deletions.get(request) ?? []) {
      if (!now.has(p)) continue;
      changes.push({ op: 'D', path: p });
      now.delete(p);
    }
    // The most frequent author of its versions; else the owner.
    const counts = new Map<string, number>();
    for (const v of list) counts.set(v.author, (counts.get(v.author) ?? 0) + 1);
    const info = requests[request];
    const author = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] || info?.owner || deps.system.toUpperCase();
    const date = at(request) || last || new Date().toISOString();
    last = date;
    const subject = info?.description ? `${request}: ${info.description}` : request;
    const trailers = [`Transport: ${request}`, ...(info?.owner ? [`Owner: ${info.owner}`] : [])];
    commits.push({
      ref,
      ...(commits.length === 0 && tip ? { from: tip } : {}),
      author: ident(author, `${author.toLowerCase()}@${deps.system.toLowerCase()}.invalid`, new Date(date)),
      message: `${subject}\n\n${trailers.join('\n')}\n`,
      changes,
    });
  }
  return { commits, tree: now };
}

/**
 * The system clock's offset from the released list (1 unit), for a read that didn't list it; none
 * when it doesn't read: the commits then take the feed's times.
 */
async function clockOffsetOf(deps: TransportDeps): Promise<number | undefined> {
  try {
    return (await deps.call<HistoryReleasedResult>({ cmd: 'history.released', system: deps.system })).clockOffsetMinutes;
  } catch (err) {
    deps.warn(`adtplus: the system's clock offset didn't read (${err instanceof Error ? err.message : String(err)}); commits dated by the version lists' times`);
    return undefined;
  }
}

/**
 * The transport commits of this fetch, on top of the tip (`tipFiles` its tree under `src/`).
 * `manifest` is the shadow's after the pull: objects deleted on the system are gone from it.
 */
export async function transportCommits(
  deps: TransportDeps,
  settings: HistorySettings,
  manifest: Manifest,
  ref: string,
  tip: string | undefined,
  tipFiles: Map<string, string> | undefined,
): Promise<TransportCommits> {
  const tree = new Map(tipFiles ?? []);
  const state = await readHistoryState(deps.root);
  const startedAt = deps.now.toISOString();
  if (tip && !state) {
    // History switched on after the clone: it can't be put before the commits git has.
    await writeHistoryState(deps.root, { since: startedAt, checkedAt: startedAt });
    deps.say('adtplus: transport history starts with this fetch; a clone takes earlier releases');
    return { commits: [], tree };
  }
  const known = tip ? await deps.git.transports(tip) : new Set<string>();
  const ids = Object.keys(manifest.objects).filter((id) => parseId(id));
  let since = settings.since;
  let objects: string[] | undefined;
  const deletions = new Map<string, string[]>();
  const requests: Record<string, HistoryRequest> = {};
  /** What tells this read from another: a stopped one resumes, one with new requests to read starts over. */
  let scope = 'all';
  let released: HistoryReleasedResult | undefined;
  if (tip && state) {
    since = new Date(Date.parse(state.checkedAt) - DAY).toISOString();
    if (deps.now.getTime() - Date.parse(state.checkedAt) < RELEASED_DAYS * DAY) {
      released = await deps.call<HistoryReleasedResult>({ cmd: 'history.released', system: deps.system });
    } else {
      deps.say(`adtplus: last checked for releases ${state.checkedAt.slice(0, 10)}, more than ${RELEASED_DAYS} days ago: reading every version list`);
    }
  }
  // Objects an earlier read failed on: again, from where that read began.
  const retry = state?.retry?.objects.filter((id) => manifest.objects[id]) ?? [];
  if (retry.length > 0 && state!.retry!.since < since) since = state!.retry!.since;
  if (released) {
    const fresh = released.requests.filter((r) => !known.has(r.number));
    const parts = groupParts(manifest);
    const wanted = new Set<string>(retry);
    // Objects in the tip, gone from the manifest after the pull: deleted (or moved away).
    const tipObjects = new Map<string, string[]>();
    for (const p of tree.keys()) {
      const id = objectOfPath(p);
      const files = tipObjects.get(id);
      if (files) files.push(p);
      else tipObjects.set(id, [p]);
    }
    const goneIds = [...tipObjects.keys()].filter((id) => !manifest.objects[id]);
    /** Per gone object, the new requests naming it, and whether each marks the deletion. */
    const naming = new Map<string, Array<{ request: string; flagged: boolean }>>();
    for (const r of fresh) {
      requests[r.number] = { description: r.description, ...(r.owner ? { owner: r.owner } : {}), ...(r.releasedLocal ? { releasedLocal: r.releasedLocal } : {}) };
      for (const entry of r.objects) {
        for (const id of ownersOfEntry(entry, ids, parts)) wanted.add(id);
        if (entry.pgmid !== 'R3TR') continue;
        for (const id of ownersOfEntry(entry, goneIds, new Map())) naming.set(id, [...(naming.get(id) ?? []), { request: r.number, flagged: entry.deleted }]);
      }
    }
    // The request that marks the deletion (`obj_func="D"`, `onprem`); unmarked (`cloud-erp`, P6): the latest naming it.
    for (const [id, list] of naming) {
      const flagged = list.filter((n) => n.flagged);
      const request = (flagged.length > 0 ? flagged : list).map((n) => n.request).sort().at(-1)!;
      deletions.set(request, [...(deletions.get(request) ?? []), ...tipObjects.get(id)!]);
    }
    if (wanted.size === 0 && deletions.size === 0) {
      await writeHistoryState(deps.root, { since: state!.since, checkedAt: startedAt });
      return { commits: [], tree };
    }
    objects = [...wanted].sort();
    scope = createHash('sha1').update(fresh.map((r) => r.number).sort().join(',')).update(`|${objects.join(',')}`).digest('hex').slice(0, 12);
    deps.say(`adtplus: ${fresh.length} request(s) released lately, ${objects.length} of the clone's objects in them`);
  }

  const run = tip ? `fetch ${state!.checkedAt} ${scope}` : `clone ${since}`;
  let failed: string[] = [];
  let readOffset: number | undefined;
  if (!objects || objects.length > 0) {
    const total = objects?.length ?? ids.length;
    deps.say(`adtplus: reading the released versions of ${total} object(s) since ${since.slice(0, 10)}…`);
    const read = () =>
      deps.call<HistoryVersionsResult>({
        cmd: 'history.versions',
        system: deps.system,
        root: deps.root,
        workspaceFolders: [deps.workspace],
        run,
        since,
        ...(objects ? { objects } : {}),
        known: [...known].sort(),
      });
    let r = await deps.watch(total, read);
    // Once more right away: the read skips the objects it has, so only the failed ones are read.
    if (r.failed.length > 0) r = await read();
    // The last read's: a retry under another clock started the index over in its scale.
    readOffset = r.localOffsetMinutes;
    for (const note of r.notes ?? []) deps.warn(`adtplus: ${note}`);
    for (const f of r.failed) deps.warn(`adtplus: versions not read: ${f.path ?? f.object}: ${f.message}; read again on the next fetch`);
    failed = [...new Set(r.failed.map((f) => f.object))].sort();
    const asSource = r.fromPull > 0 ? `, ${r.fromPull} newest release(s) as the source` : '';
    deps.say(`adtplus: ${r.versions} released version(s) in ${r.requests} request(s), ${r.feeds} version list(s) read${asSource}; ${r.units} units`);
  }
  const index = await loadHistoryIndex(deps.root, run);
  const versions = (index?.versions ?? []).filter((v) => !known.has(v.request) && v.at >= since);
  // The released list's fields, then the request's own read over them.
  const merged = { ...requests };
  for (const [n, r] of Object.entries(index?.requests ?? {})) merged[n] = { ...merged[n], ...r };
  // The released list's offset, else the version read's (both the daemon's measurement, ADR-016), else a list read for it.
  const offset =
    released?.clockOffsetMinutes ?? readOffset ?? (versions.length + deletions.size > 0 ? await clockOffsetOf(deps) : undefined);
  const built = await buildCommits(deps, ref, tip, versions, merged, deletions, tree, offset);
  await writeHistoryState(deps.root, {
    since: state?.since ?? settings.since,
    checkedAt: startedAt,
    ...(failed.length > 0 ? { retry: { objects: failed, since } } : {}),
  });
  return built;
}
