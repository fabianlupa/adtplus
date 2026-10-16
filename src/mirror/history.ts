import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RawAdtError, decodeXml, endsLoop, type RawAdtClient } from '../backends/rawadt.js';
import { parseTransportRequest } from '../capabilities/transport.js';
import { clockOffset, feedTime, notesOf, type ClockRead } from '../core/clock.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { shortMessage } from './changes.js';
import { abapName, parseId, resolveRoot } from './layout.js';
import { loadManifest } from './manifest.js';
import { blobSha, toLocal } from './normalize.js';
import type { MirrorLocation } from './pull.js';

/**
 * Transport history for the git helper (docs/decisions/011-git-remote-helper.md, "History"; G6).
 *
 * - `history.versions`: the released versions of a mirror's source files, from each file's version
 *   feed (REST Atom, `…/versions`; P4, P6). Only numbered versions (`00001…`) count: each names the
 *   request whose release made it and carries the release time and author; `00000` and `99999` name
 *   whoever holds the object now, so they never date or attribute history. Each version's content is
 *   read (content URLs go stale with the next release, so never stored) and kept as a blob under the
 *   shadow's `history/`, with an index the helper builds its commits from. Resumable per object.
 * - `history.released`: the requests released in the last two weeks with their objects
 *   (`cts/transportrequests?user=*&targets=false`, 1 request), so a fetch reads only those objects'
 *   feeds.
 *
 * Both are REST fallbacks (ADR-002) until adt-ls has version history and lists released requests.
 */

export interface HistoryVersionsInput extends MirrorLocation {
  system: string;
  /** Identifies the read: an index from another run is started over. */
  run: string;
  /** Versions released before this ISO time (UTC) are left out. */
  since: string;
  /** Mirror ids (`CLAS ZCL_X`) to read; absent: every object of the manifest. */
  objects?: string[];
  /** Requests whose versions are already in git: left out, their contents not read. */
  known?: string[];
}

export interface HistoryVersion {
  /** Repository path (`src/…`). */
  path: string;
  /** Mirror id of the object. */
  object: string;
  /** `00001`… */
  version: string;
  request: string;
  /** SAP user. */
  author: string;
  /** The version's feed time, UTC by the measured clock (ADR-016), else as the feed sent it. */
  at: string;
  /** `blobSha` of the content as a pull would write it, under `history/blobs/`. */
  blob: string;
}

export interface HistoryRequest {
  description: string;
  /** From the request's own read: absent until read, `''` when it didn't read or named none. */
  owner?: string;
  /** From the same read: its release, the system's local time (`YYYYMMDDhhmmss`). */
  releasedLocal?: string;
}

/** `<shadow>/history/index.json`. */
export interface HistoryIndex {
  run: string;
  since: string;
  /** Objects whose feeds are all read; one that failed isn't, so the next call reads it again. */
  done: string[];
  versions: HistoryVersion[];
  requests: Record<string, HistoryRequest>;
  /** The last call's failures. */
  failed: Array<{ object: string; path?: string; message: string }>;
  /** Newest releases taken from the pulled file (`asSource`), over the run. */
  fromPull?: number;
  /** The feed offset `at` was corrected by; an index with another (or none) is started over. */
  feedOffsetMinutes?: number;
}

export interface HistoryVersionsResult {
  via: 'rest-fallback';
  /** Always null: no probe tells whether adt-ls has version history (ADR-002). */
  nativeAvailable: null;
  /** Objects read in this call (a resumed read skips those done before). */
  objects: number;
  feeds: number;
  /** Newest releases equal to the active version, taken from the pulled file (its real text). */
  fromPull: number;
  /** Versions in the index, this run's earlier calls included. */
  versions: number;
  requests: number;
  failed: HistoryIndex['failed'];
  /** The system clock's offset from UTC, when measured: for the requests' local release times. */
  localOffsetMinutes?: number;
  /** Set when the versions' times stay as the feed sent them (the clock didn't measure). */
  notes?: string[];
  units: number;
  ms: number;
}

export interface HistoryDeps {
  withRest: <T>(fn: (rest: RawAdtClient) => Promise<T>) => Promise<T>;
  /** The bulk lane's REST requests in flight. */
  concurrency: number;
  /** The system clock (ADR-016): feed times become UTC; absent or unmeasured, they stay as sent. */
  clock?: ClockRead;
}

export const HISTORY_DIR = 'history';
const INDEX = 'index.json';
/** The index is saved after this many objects, so a stopped read resumes without much lost. */
const SAVE_EVERY = 25;

/** A logon refused, the rate limit, or SAP no longer answering (`endsLoop`): ends the call. */
function fatal(err: unknown): boolean {
  return err instanceof ThrottledError || (err instanceof RawAdtError && err.isAuthFailure) || endsLoop(err);
}

/** A text without what the version store's rebuild changes: case and blank lines. */
function layoutFree(text: string): string {
  return text
    .toLowerCase()
    .split('\n')
    .filter((l) => l.trim() !== '')
    .join('\n');
}

const enc = (name: string) => encodeURIComponent(name.toLowerCase());

/** abapGit's and AFF's class include files → the include's name in ADT. */
const CLASS_INCLUDES: Record<string, string> = {
  abap: 'main',
  'definitions.abap': 'definitions',
  'implementations.abap': 'implementations',
  'macros.abap': 'macros',
  'testclasses.abap': 'testclasses',
};

/** Where a type's one source lives, and whether its feed sits under `source/main` (P4). */
const SOURCES: Record<string, { collection: string; ext: string; direct?: boolean }> = {
  INTF: { collection: 'oo/interfaces', ext: 'abap' },
  PROG: { collection: 'programs/programs', ext: 'abap' },
  DDLS: { collection: 'ddic/ddl/sources', ext: 'acds', direct: true },
  DCLS: { collection: 'acm/dcl/sources', ext: 'acds', direct: true },
  DDLX: { collection: 'ddic/ddlx/sources', ext: 'acds' },
  BDEF: { collection: 'bo/behaviordefinitions', ext: 'abdl' },
  SRVD: { collection: 'ddic/srvd/sources', ext: 'acds' },
  TABL: { collection: 'ddic/tables', ext: 'ddic' },
};

/** A function group's main program: `SAPLZFG`, `/NS/SAPLFG`. */
export function mainProgram(group: string): string {
  const ns = group.match(/^(\/[^/]+\/)(.+)$/);
  return ns ? `${ns[1]}SAPL${ns[2]}` : `SAPL${group}`;
}

/**
 * The version feed of each source file of an object, built from its type and name (a deleted
 * object's feed still answers, its metadata doesn't: P6). Files without a feed (`.json`,
 * `.properties`, `.jsonc`, types without versions) are left out.
 */
export function feedsOf(type: string, name: string, files: string[]): Array<{ file: string; feed: string }> {
  const out: Array<{ file: string; feed: string }> = [];
  const lower = files.map((f) => f.toLowerCase());
  for (const [i, file] of lower.entries()) {
    const segs = file.split('.');
    if (segs[1] !== type.toLowerCase()) continue;
    const rest = segs.slice(2).join('.');
    if (type === 'CLAS') {
      const include = CLASS_INCLUDES[rest];
      if (include) out.push({ file: files[i]!, feed: `/sap/bc/adt/oo/classes/${enc(name)}/includes/${include}/versions` });
      continue;
    }
    if (type === 'FUGR') {
      // `<group>.fugr.<part>.reps.abap` (the main program or an include), `<group>.fugr.<module>.func.abap`.
      const m = rest.match(/^([^.]+)\.(reps|func)\.abap$/);
      if (!m) continue;
      const part = abapName(m[1]!);
      const group = `/sap/bc/adt/functions/groups/${enc(name)}`;
      const feed =
        m[2] === 'func'
          ? `${group}/fmodules/${enc(part)}/source/main/versions`
          : part === mainProgram(name)
            ? `${group}/source/main/versions`
            : `${group}/includes/${enc(part)}/source/main/versions`;
      out.push({ file: files[i]!, feed });
      continue;
    }
    const source = SOURCES[type];
    if (source && rest === source.ext) {
      out.push({ file: files[i]!, feed: `/sap/bc/adt/${source.collection}/${enc(name)}${source.direct ? '' : '/source/main'}/versions` });
    }
  }
  return out;
}

export interface FeedEntry {
  id: string;
  author: string;
  updated: string;
  /** The request a version names (`adtcore:name` of its transport request link), if any. */
  request?: string;
  /** The request's description (the link's title). */
  description?: string;
  content?: string;
}

/** The entries of a version feed (`atom:feed`), as the feed lists them. */
export function parseFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const [, body = ''] of xml.matchAll(/<atom:entry\b[^>]*>([\s\S]*?)<\/atom:entry>/g)) {
    const text = (tag: string) => {
      const v = body.match(new RegExp(`<atom:${tag}\\b[^>]*>([\\s\\S]*?)</atom:${tag}>`))?.[1];
      return v === undefined ? undefined : decodeXml(v.trim());
    };
    const id = text('id');
    if (!id) continue;
    const author = body.match(/<atom:author\b[^>]*>[\s\S]*?<atom:name>([^<]*)<\/atom:name>/)?.[1];
    const link = [...body.matchAll(/<atom:link\b[^>]*>/g)]
      .map((m) => m[0])
      .find((l) => l.includes('type="application/vnd.sap.adt.transportrequests.v1+xml"'));
    const attr = (tag: string | undefined, a: string) => {
      const v = tag?.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1];
      return v === undefined ? undefined : decodeXml(v);
    };
    const request = attr(link, 'adtcore:name');
    const description = attr(link, 'title');
    const content = attr(body.match(/<atom:content\b[^>]*>/)?.[0], 'src');
    entries.push({
      id,
      author: decodeXml(author ?? ''),
      updated: text('updated') ?? '',
      ...(request ? { request } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(content ? { content } : {}),
    });
  }
  return entries;
}

/** A released version: numbered, naming a request. `00000` (active) and `99999` (draft) are neither. */
export function isReleased(e: FeedEntry): boolean {
  return /^\d{5}$/.test(e.id) && e.id !== '00000' && e.id !== '99999' && e.request !== undefined;
}

async function readIndex(root: string): Promise<HistoryIndex | undefined> {
  try {
    return JSON.parse(await readFile(path.join(root, HISTORY_DIR, INDEX), 'utf8')) as HistoryIndex;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

async function saveIndex(root: string, index: HistoryIndex): Promise<void> {
  const file = path.join(root, HISTORY_DIR, INDEX);
  await writeFile(`${file}.tmp`, `${JSON.stringify(index)}\n`);
  await rename(`${file}.tmp`, file);
}

/** The index of a run, for the helper: undefined when none or another run's. */
export async function loadHistoryIndex(root: string, run: string): Promise<HistoryIndex | undefined> {
  const index = await readIndex(root);
  return index?.run === run ? index : undefined;
}

export function blobPath(root: string, blob: string): string {
  return path.join(root, HISTORY_DIR, 'blobs', blob);
}

export async function historyVersions(deps: HistoryDeps, input: HistoryVersionsInput): Promise<HistoryVersionsResult> {
  const started = Date.now();
  const root = await resolveRoot(input.root, input.workspaceFolders);
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error(`no mirror at ${root}; run \`mirror init\` first`);
  if (manifest.system !== input.system) throw new Error(`${root} mirrors system "${manifest.system}", not "${input.system}"`);
  if (Number.isNaN(Date.parse(input.since))) throw new Error(`since "${input.since}" is no date`);
  const feedOffset = deps.clock?.feedOffsetMinutes;
  const loaded = await readIndex(root);
  // A read whose times are in another scale is started over: one index never mixes two.
  const previous = loaded?.run === input.run && loaded.feedOffsetMinutes === feedOffset ? loaded : undefined;
  // Another read's blobs aren't needed any more.
  if (!previous) await rm(path.join(root, HISTORY_DIR), { recursive: true, force: true });
  await mkdir(path.join(root, HISTORY_DIR, 'blobs'), { recursive: true });
  const index: HistoryIndex = previous ?? {
    run: input.run,
    since: input.since,
    done: [],
    versions: [],
    requests: {},
    failed: [],
    ...(feedOffset !== undefined ? { feedOffsetMinutes: feedOffset } : {}),
  };
  const done = new Set(index.done);
  const known = new Set(input.known ?? []);
  const wanted = input.objects ? new Set(input.objects) : undefined;
  const queue = Object.keys(manifest.objects)
    .filter((id) => parseId(id) && (!wanted || wanted.has(id)) && !done.has(id))
    .sort();
  let units = 0;
  let objects = 0;
  let feeds = 0;
  let unsaved = 0;

  /**
   * The version store keeps a class's main source as SAP rebuilds it from its parts (upper-case
   * name, blank lines after `IMPLEMENTATION`), not as written. The newest release is the active
   * state when the active version `00000` equals it; then its real text is the source the pull
   * read. That file must be this state: read without error or draft, and equal to the release but
   * for case and blank lines (a change after the pull, or a stale file, differs by more).
   */
  const asSource = async (
    id: string,
    file: string,
    at: string,
    text: string,
    active: FeedEntry | undefined,
    read: (e: FeedEntry) => Promise<string>,
  ): Promise<Buffer | undefined> => {
    const own = manifest.objects[id]!.files[file]!;
    if (own.error !== undefined || own.hash === undefined || own.draft) return undefined;
    let pulled: Buffer;
    try {
      pulled = await readFile(path.join(root, ...at.split('/')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { path: at });
    }
    const source = pulled.toString('utf8');
    if (source === text) return undefined;
    if (layoutFree(source) !== layoutFree(text) || !active) return undefined;
    try {
      return (await read(active)) === text ? pulled : undefined;
    } catch (err) {
      // Without the active version the release keeps its own text.
      if (fatal(err)) throw err;
      return undefined;
    }
  };

  return deps.withRest(async (rest) => {
    /** A failure other than a missing feed throws: the object isn't done, a later call reads it again. */
    const readObject = async (id: string) => {
      const { type, name } = parseId(id)!;
      const entry = manifest.objects[id]!;
      const found: HistoryVersion[] = [];
      for (const { file, feed } of feedsOf(type, name, Object.keys(entry.files))) {
        const at = `${entry.dir}/${file}`;
        units += 1;
        feeds += 1;
        let list: FeedEntry[];
        try {
          list = parseFeed((await rest.expectOk('GET', feed, `read versions of ${at}`, { headers: { Accept: 'application/atom+xml;type=feed' } })).body);
        } catch (err) {
          // No feed for this file (a type or part without version management): no history for it.
          if (err instanceof RawAdtError && err.status === 404) continue;
          throw Object.assign(err instanceof Error ? err : new Error(String(err)), { path: at });
        }
        const read = async (e: FeedEntry) => {
          units += 1;
          try {
            return toLocal((await rest.expectOk('GET', e.content!, `read version ${e.id} of ${at}`, { headers: { Accept: 'text/plain' } })).body);
          } catch (err) {
            throw Object.assign(err instanceof Error ? err : new Error(String(err)), { path: at });
          }
        };
        const released = list.filter(isReleased);
        const newest = released.reduce<string | undefined>((n, v) => (n === undefined || v.id > n ? v.id : n), undefined);
        const active = list.find((e) => e.id === '00000' && e.content);
        for (const v of released) {
          const time = feedTime(v.updated, deps.clock);
          if (time < input.since || known.has(v.request!) || !v.content) continue;
          const text = await read(v);
          const pulled = v.id === newest ? await asSource(id, file, at, text, active, read) : undefined;
          if (pulled) index.fromPull = (index.fromPull ?? 0) + 1;
          const data = pulled ?? Buffer.from(text);
          const blob = blobSha(data);
          await writeFile(blobPath(root, blob), data);
          found.push({ path: at, object: id, version: v.id, request: v.request!, author: v.author, at: time, blob });
          index.requests[v.request!] ??= { description: v.description ?? '' };
        }
      }
      return found;
    };

    let stop: unknown;
    /** Run `fn` over `items`, the bulk lane's requests in flight; a refused logon or the rate limit ends it. */
    const pool = async <T>(items: T[], fn: (item: T) => Promise<void>) => {
      const queue = [...items];
      await Promise.all(
        Array.from({ length: Math.min(Math.max(1, deps.concurrency), queue.length) }, async () => {
          for (let item = queue.shift(); item !== undefined && stop === undefined; item = queue.shift()) {
            try {
              await fn(item);
            } catch (err) {
              if (!fatal(err)) throw err;
              stop ??= err;
            }
          }
        }),
      );
    };
    // This call's failures only: an object that failed before and reads now is no failure any more.
    index.failed = [];
    await pool(queue, async (id) => {
      try {
        const found = await readObject(id);
        index.versions.push(...found);
        index.done.push(id);
        objects += 1;
      } catch (err) {
        if (fatal(err)) throw err;
        // Nothing of the object kept, and not done: the next call (the helper's retry) reads it again.
        const at = (err as { path?: string }).path;
        index.failed.push({ object: id, ...(at ? { path: at } : {}), message: shortMessage(err) });
      }
      unsaved += 1;
      if (unsaved >= SAVE_EVERY) {
        unsaved = 0;
        await saveIndex(root, index);
      }
    });
    if (stop === undefined) {
      // Each request's owner and release, once: the feed names only the version's author. `''`: read,
      // no owner. A request read before releases were kept is read again for its release.
      const owners = Object.keys(index.requests).filter((n) => {
        const r = index.requests[n]!;
        return r.owner === undefined || (r.owner !== '' && r.releasedLocal === undefined);
      });
      await pool(owners, async (number) => {
        units += 1;
        const r = index.requests[number]!;
        try {
          const res = await rest.expectOk('GET', `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(number)}`, `read ${number}`, {
            headers: { Accept: 'application/vnd.sap.adt.transportorganizer.v1+xml' },
          });
          const request = parseTransportRequest(res.body, number);
          index.requests[number] = {
            description: request?.description || r.description,
            owner: request?.owner ?? '',
            ...(request?.lastChanged ? { releasedLocal: request.lastChanged } : {}),
          };
        } catch (err) {
          if (fatal(err)) throw err;
          // No owner: the commit goes without the trailer.
          index.requests[number] = { ...r, owner: '' };
        }
      });
    }
    await saveIndex(root, index);
    if (stop !== undefined) throw stop;
    return {
      via: 'rest-fallback',
      nativeAvailable: null,
      objects,
      feeds,
      fromPull: index.fromPull ?? 0,
      versions: index.versions.length,
      requests: Object.keys(index.requests).length,
      failed: index.failed,
      ...(deps.clock?.localOffsetMinutes !== undefined ? { localOffsetMinutes: deps.clock.localOffsetMinutes } : {}),
      ...notesOf(deps.clock, 'feed'),
      units,
      ms: Date.now() - started,
    };
  });
}

export interface ReleasedEntry {
  /** `R3TR` or `LIMU`. */
  pgmid: string;
  type: string;
  name: string;
  /** `tm:obj_func="D"`: the request deletes it (`onprem` marks this, `cloud-erp` didn't for a class: P6). */
  deleted: boolean;
}

export interface ReleasedRequest {
  number: string;
  owner: string;
  description: string;
  /** Its release, the system's local time (`YYYYMMDDhhmmss`); `''` when the list names none. */
  releasedLocal: string;
  /** The request's own entries (its tasks list the same), `CORR` comment entries left out. */
  objects: ReleasedEntry[];
}

export interface HistoryReleasedResult {
  via: 'rest-fallback';
  nativeAvailable: null;
  requests: ReleasedRequest[];
  /**
   * The system's clock ahead of UTC, in minutes (a multiple of 15): the daemon's measurement
   * (ADR-016), else from the list's `changedAt`, the system's local time of the answer labelled `Z`.
   * Absent when neither has one.
   */
  clockOffsetMinutes?: number;
  units: number;
  ms: number;
}

/** The released requests of a `tm:root` list: those under `tm:released`, each with its own entries. */
export function parseReleased(xml: string): ReleasedRequest[] {
  const requests: ReleasedRequest[] = [];
  for (const [, section = ''] of xml.matchAll(/<tm:released\b[^>]*>([\s\S]*?)<\/tm:released>/g)) {
    for (const [, head = '', body = ''] of section.matchAll(/<tm:request\b([^>]*)>([\s\S]*?)<\/tm:request>/g)) {
      const attr = (tag: string, a: string) => {
        const v = tag.match(new RegExp(`\\btm:${a}="([^"]*)"`))?.[1];
        return v === undefined ? '' : decodeXml(v);
      };
      if (attr(head, 'status') !== 'R') continue;
      // The request's own entries come before its first task.
      const own = body.split(/<tm:task\b/)[0]!;
      const objects: ReleasedEntry[] = [];
      for (const [tag] of own.matchAll(/<tm:abap_object\b[^>]*>/g)) {
        const pgmid = attr(tag, 'pgmid');
        // `LANG` (translations) left out: the mirror holds no translations (ADR-007).
        if (pgmid !== 'R3TR' && pgmid !== 'LIMU') continue;
        objects.push({ pgmid, type: attr(tag, 'type'), name: attr(tag, 'name'), deleted: attr(tag, 'obj_func') === 'D' });
      }
      requests.push({
        number: attr(head, 'number'),
        owner: attr(head, 'owner'),
        description: attr(head, 'desc'),
        releasedLocal: attr(head, 'lastchanged_timestamp'),
        objects,
      });
    }
  }
  return requests;
}

/** The requests released in the last two weeks, all owners (P6: ~150 KB on `onprem`, 1 request). */
export async function releasedRequests(deps: HistoryDeps): Promise<HistoryReleasedResult> {
  const started = Date.now();
  return deps.withRest(async (rest) => {
    const sent = Date.now();
    const res = await rest.expectOk('GET', '/sap/bc/adt/cts/transportrequests', 'list released transport requests', {
      query: { user: '*', targets: 'false' },
      headers: { Accept: 'application/vnd.sap.adt.transportorganizertree.v1+xml' },
    });
    // The shared measurement when there is one (ADR-016), else the list's own time.
    const offset = deps.clock?.localOffsetMinutes ?? clockOffset(res.body, (sent + Date.now()) / 2);
    return {
      via: 'rest-fallback',
      nativeAvailable: null,
      requests: parseReleased(res.body),
      ...(offset !== undefined ? { clockOffsetMinutes: offset } : {}),
      units: 1,
      ms: Date.now() - started,
    };
  });
}
