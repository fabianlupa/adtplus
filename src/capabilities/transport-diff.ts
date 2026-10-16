import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { RawAdtError, decodeXml, type RawAdtClient } from '../backends/rawadt.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { localToUtc, notesOf, type ClockRead } from '../core/clock.js';
import { unifiedDiff } from '../core/udiff.js';
import { feedsOf, mainProgram, parseFeed, type FeedEntry } from '../mirror/history.js';
import { affName } from '../mirror/layout.js';
import { toLocal } from '../mirror/normalize.js';

/**
 * `transport read` and `transport diff`.
 *
 * - **read** (REST fallback, ADR-002): a request's or task's organizer document,
 *   `cts/transportrequests/<id>` (1 request): header, tasks, entries. adt-ls lists modifiable
 *   requests only and no request's objects.
 * - **diff**: adt-ls's `transport.getDiff`, one page per call (≤ 40 objects), plus on the first
 *   page adt+'s own diffs from the version feeds for what getDiff leaves out: one source file per
 *   entry, so a whole class's (`R3TR CLAS`) other includes and a function group's other parts, and
 *   nothing for an object that no longer exists.
 */

const ORGANIZER_MEDIA_TYPE = 'application/vnd.sap.adt.transportorganizer.v1+xml';
const FEED_MEDIA_TYPE = 'application/atom+xml;type=feed';

export interface TransportEntry {
  /**
   * `R3TR` (an object), `LIMU` (a part of one: a method, a class include, a program's source) or
   * `LANG` (an object's translations, e.g. a translation project's publish).
   */
  pgmid: string;
  type: string;
  name: string;
  /** ADT's workbench type, e.g. `CLAS/OC`, `CLAS/OCN` (a class include). */
  wbtype?: string;
  /** `tm:obj_func="D"`: the request deletes it (`onprem` marks this; `cloud-erp` didn't for a class, P6). */
  deleted?: true;
}

export interface TransportTaskDetail {
  number: string;
  owner: string;
  status: string;
  description: string;
  objects: TransportEntry[];
}

export interface TransportDetail {
  via: 'rest-fallback';
  /** adt-ls reads a request's objects (`NativeSupport.transportContents`); null: not probed. */
  nativeAvailable: boolean | null;
  number: string;
  /** Set when `number` is a task: its request, and the request's status. */
  request?: string;
  requestStatus?: string;
  owner: string;
  /** `tm:type`: a request's `K` workbench, `W` customizing, `T` transport of copies, …; a task's `S`, `R`, `X`, … */
  type: string;
  /** `D` modifiable, `L` locked, `R` released, … */
  status: string;
  statusText: string;
  description: string;
  target: string;
  /**
   * `tm:lastchanged_timestamp`, a released request's release: UTC ISO by the measured system clock
   * (ADR-016); unmeasured, the system's local `YYYYMMDDhhmmss` as sent, and `notes` says so.
   */
  lastChanged: string;
  tasks: TransportTaskDetail[];
  /** Every entry of the request and its tasks, once each; `CORR` comment entries left out. */
  objects: TransportEntry[];
  notes?: string[];
}

function attrsOf(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/\btm:(\w+)="([^"]*)"/g)) attrs[m[1]!] = decodeXml(m[2]!);
  return attrs;
}

/** The entries in `xml`, once each by pgmid/type/name; a deletion mark on any copy counts. */
function entriesOf(xml: string): TransportEntry[] {
  const byKey = new Map<string, TransportEntry>();
  for (const [tag] of xml.matchAll(/<tm:abap_object\b[^>]*>/g)) {
    const a = attrsOf(tag);
    if (a.pgmid !== 'R3TR' && a.pgmid !== 'LIMU' && a.pgmid !== 'LANG') continue;
    const key = `${a.pgmid} ${a.type} ${a.name}`;
    const entry = byKey.get(key) ?? {
      pgmid: a.pgmid,
      type: a.type ?? '',
      name: a.name ?? '',
      ...(a.wbtype ? { wbtype: a.wbtype } : {}),
    };
    if (a.obj_func === 'D') entry.deleted = true;
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

/**
 * One organizer document (`tm:root`) of a request or a task. A request's document lists its own
 * entries and each task's (open requests add `tm:all_objects`); a task's names its request first.
 */
export function parseTransportDetail(xml: string, id: string): Omit<TransportDetail, 'via' | 'nativeAvailable'> | undefined {
  const rootTag = xml.match(/<tm:root\b[^>]*>/)?.[0];
  if (!rootTag) return undefined;
  const isTask = attrsOf(rootTag).object_type === 'T';
  const requestTag = xml.match(/<tm:request\b[^>]*>/)?.[0];
  const tasks = [...xml.matchAll(/<tm:task\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tm:task>)/g)].map((m) => {
    const a = attrsOf(m[1]!);
    return {
      attrs: a,
      task: { number: a.number ?? '', owner: a.owner ?? '', status: a.status ?? '', description: a.desc ?? '', objects: entriesOf(m[2] ?? '') },
    };
  });
  const self = isTask ? tasks.find((t) => t.task.number === id) : undefined;
  if (isTask ? !self : !requestTag) return undefined;
  const head = self ? self.attrs : attrsOf(requestTag!);
  return {
    number: head.number ?? id,
    ...(isTask && requestTag ? { request: attrsOf(requestTag).number ?? '', requestStatus: attrsOf(requestTag).status ?? '' } : {}),
    owner: head.owner ?? '',
    type: head.type ?? '',
    status: head.status ?? '',
    statusText: head.status_text ?? '',
    description: head.desc ?? '',
    target: head.target ?? '',
    lastChanged: head.lastchanged_timestamp ?? '',
    tasks: self ? [self.task] : tasks.map((t) => t.task),
    objects: self ? self.task.objects : entriesOf(xml),
  };
}

export async function read(rest: RawAdtClient, transport: string, nativeAvailable: boolean | null = null, clock?: ClockRead): Promise<TransportDetail> {
  const id = transport.toUpperCase();
  const res = await rest.expectOk('GET', `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(id)}`, `read ${id}`, {
    headers: { Accept: ORGANIZER_MEDIA_TYPE },
  });
  const detail = parseTransportDetail(res.body, id);
  if (!detail) throw new Error(`read ${id}: no transport request or task in SAP's answer`);
  if (!clock) return { via: 'rest-fallback', nativeAvailable, ...detail };
  const utc = clock.localOffsetMinutes !== undefined ? localToUtc(detail.lastChanged, clock.localOffsetMinutes) : undefined;
  return { via: 'rest-fallback', nativeAvailable, ...detail, ...(utc ? { lastChanged: utc } : {}), ...notesOf(clock, 'local') };
}

// --- diff ------------------------------------------------------------------

/** A class include's suffix (`ZCL_X=====CCAU`) → AFF's file part. */
const INCLUDE_FILES: Record<string, string> = {
  CCDEF: 'definitions.abap',
  CCIMP: 'implementations.abap',
  CCMAC: 'macros.abap',
  CCAU: 'testclasses.abap',
};
const CLASS_FILES = ['abap', ...Object.values(INCLUDE_FILES)];
/** Types with one source file whose feed `feedsOf` knows, by AFF extension. */
const SOURCE_EXT: Record<string, string> = {
  INTF: 'abap',
  PROG: 'abap',
  DDLS: 'acds',
  DCLS: 'acds',
  DDLX: 'acds',
  BDEF: 'abdl',
  SRVD: 'acds',
  TABL: 'ddic',
};
/** Class parts recorded as `LIMU`: each stands for its class. */
const CLASS_PARTS = new Set(['CINC', 'CLSD', 'CPUB', 'CPRO', 'CPRI', 'METH', 'CDEF']);

/** `zcl_x`, `(ns)cl_x` (`/NS/CL_X`): an object name as AFF's file names spell it. */
function fileStem(name: string): string {
  return affName(name).toLowerCase();
}

/** A function group's main program file: `zfg.fugr.saplzfg.reps.abap`, `(ns)fg.fugr.(ns)saplfg.reps.abap`. */
function groupMainFile(group: string): string {
  return `${fileStem(group)}.fugr.${fileStem(mainProgram(group))}.reps.abap`;
}

/** A class part's class: `ZCL_X=====CCAU` and `ZCL_X<padding>METHOD` name it in their first 30 characters. */
function classOf(name: string): string {
  return name.slice(0, 30).replace(/=+[^=]*$/, '').trim();
}

interface Planned {
  type: string;
  name: string;
  /** Files getDiff diffs itself while the object exists: the ones an entry names. */
  covered: Set<string>;
}

/** The objects whose version feeds the supplement reads, from the request's entries. */
export function planSupplement(entries: TransportEntry[]): { objects: Planned[]; notCovered: string[] } {
  const objects = new Map<string, Planned>();
  const notCovered: string[] = [];
  const at = (type: string, name: string) => {
    const key = `${type} ${name}`;
    const o = objects.get(key) ?? { type, name, covered: new Set<string>() };
    objects.set(key, o);
    return o;
  };
  for (const e of entries) {
    if (e.pgmid === 'R3TR' && e.type === 'CLAS') {
      at('CLAS', e.name).covered.add(`${fileStem(e.name)}.clas.abap`);
    } else if (e.pgmid === 'LIMU' && CLASS_PARTS.has(e.type)) {
      const cls = classOf(e.name);
      // The class name padded with `=` to 30 characters, then the suffix (none for a 30-character name).
      const suffix = e.type === 'CINC' ? e.name.slice(30).trim() : undefined;
      const file = suffix ? INCLUDE_FILES[suffix] : 'abap';
      // A local-types include outside AFF's four (`CCMAC` is one of them; e.g. `CCU`): getDiff only.
      if (file === undefined) continue;
      at('CLAS', cls).covered.add(`${fileStem(cls)}.clas.${file}`);
    } else if (e.pgmid === 'R3TR' && e.type === 'FUGR') {
      at('FUGR', e.name).covered.add(groupMainFile(e.name));
    } else if (e.pgmid === 'R3TR' && SOURCE_EXT[e.type]) {
      at(e.type, e.name).covered.add(`${fileStem(e.name)}.${e.type.toLowerCase()}.${SOURCE_EXT[e.type]}`);
    } else if (e.pgmid === 'LIMU' && e.type === 'REPS') {
      // A program's source or a function group's include: only a program's feed is known by name.
      at('PROG', e.name).covered.add(`${fileStem(e.name)}.prog.abap`);
    } else if (e.pgmid === 'LIMU' && e.type === 'FUNC') {
      notCovered.push(`LIMU FUNC ${e.name}: a function module's group isn't named; getDiff only`);
    } else if (e.pgmid === 'LANG') {
      notCovered.push(`LANG ${e.type} ${e.name}: translations; not diffed`);
    }
  }
  return { objects: [...objects.values()], notCovered };
}

export interface SupplementFile {
  object: string;
  file: string;
  /** Versions compared: `old` absent for a file the request created. */
  old?: string;
  new: string;
  /** Why getDiff doesn't show it. */
  reason: 'include' | 'gone';
}

export interface DiffSupplement {
  via: 'rest-fallback';
  nativeAvailable: null;
  /** adt+'s unified diffs, headed by AFF file names (`--- zcl_x.clas.testclasses.abap (old)`). */
  diff: string;
  files: SupplementFile[];
  /** Objects the request names that no longer exist: getDiff leaves them out entirely. */
  gone: string[];
  /** Includes the request created that hold only SAP's template comment, left out. */
  templates: number;
  notCovered: string[];
  requests: number;
}

export interface TransportDiffResult {
  via: 'adt-ls';
  transport: string;
  /** getDiff's unified diffs of this page (`--- CLAS/OC ZCL_X (old)`), `''` when none differ. */
  diff: string;
  message?: string;
  page: { processed?: number; total?: number; remaining?: number };
  /** Pass back as `cursor` for the next page; absent on the last. */
  nextCursor?: string;
  /** Only on the first page (no `cursor`). */
  supplement?: DiffSupplement;
  /** The first page's supplement failed as a whole (the request's read): getDiff's page stands. */
  supplementError?: string;
}

export interface TransportDiffInput {
  transport: string;
  cursor?: string;
  pageSize?: number;
}

export interface TransportDiffDeps {
  adt: AdtLsClient;
  withRest<T>(fn: (rest: RawAdtClient) => Promise<T>): Promise<T>;
  /** REST requests in flight for the supplement. */
  concurrency?: number;
}

/**
 * Which feed rule a request's status takes: `D`/`L` (modifiable) open, `R`/`N` (released,
 * with or without import protection) released; any other (`O`, release started) tries the
 * released rule first. A task goes by its request's status: its versions come with the request's
 * release.
 */
export function stateOf(status: string): 'open' | 'released' | 'unsettled' {
  if (status === 'D' || status === 'L') return 'open';
  if (status === 'R' || status === 'N') return 'released';
  return 'unsettled';
}

/** The version a request made of one file, and the one before it (P4/P6 feed rules). */
export function pickVersions(
  list: FeedEntry[],
  ids: Set<string>,
  state: 'open' | 'released' | 'unsettled',
): { old?: FeedEntry; new: FeedEntry } | undefined {
  if (state === 'unsettled') return pickVersions(list, ids, 'released') ?? pickVersions(list, ids, 'open');
  const numbered = list.filter((e) => /^\d{5}$/.test(e.id) && e.id !== '00000' && e.id !== '99999').sort((a, b) => (a.id < b.id ? 1 : -1));
  if (state === 'open') {
    // An open request's state is the draft, else the active version, while it holds the object.
    const current = [list.find((e) => e.id === '99999'), list.find((e) => e.id === '00000')].find(
      (e) => e !== undefined && e.request !== undefined && ids.has(e.request),
    );
    return current ? { new: current, ...(numbered[0] ? { old: numbered[0] } : {}) } : undefined;
  }
  const index = numbered.findIndex((e) => e.request !== undefined && ids.has(e.request));
  if (index < 0) return undefined;
  const old = numbered[index + 1];
  return { new: numbered[index]!, ...(old ? { old } : {}) };
}

/** SAP's text of a class include nobody wrote into: `*"* use this source file for …` lines only. */
function isTemplate(text: string): boolean {
  const body = text.split('\n').filter((l) => l.trim() !== '');
  return body.length > 0 && body.every((l) => l.startsWith('*"*'));
}

/** The `new` side of a deletion no version records. */
const DELETED = 'deleted';

function lastVersion(list: FeedEntry[]): { old: FeedEntry; new: FeedEntry } | undefined {
  const newest = list.filter((e) => /^\d{5}$/.test(e.id) && e.id !== '00000' && e.id !== '99999').sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  return newest ? { old: newest, new: { id: DELETED, author: '', updated: '' } } : undefined;
}

/** Whether a feed shows the object still there: an active or draft version (a deleted one's feed keeps only the released ones). */
function exists(list: FeedEntry[]): boolean {
  return list.some((e) => e.id === '00000' || e.id === '99999');
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, size), queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

/** The files of an existing function group, from its folder in adt-ls's repository tree. */
async function groupFiles(adt: AdtLsClient, name: string): Promise<string[] | undefined> {
  try {
    const uri = await adt.lifecycle.resolveAffUri({ name, objectType: 'FUGR' });
    const folder = uri.slice(0, uri.lastIndexOf('/') + 1);
    const prefix = `${fileStem(name)}.fugr.`;
    return (await adt.repository.readDirectory(folder))
      .filter((c) => c.kind === 'file' && c.name.toLowerCase().startsWith(prefix) && /\.(reps|func)\.abap$/i.test(c.name))
      .map((c) => c.name.toLowerCase());
  } catch (err) {
    if (err instanceof ThrottledError) throw err;
    return undefined;
  }
}

async function supplement(deps: TransportDiffDeps, detail: TransportDetail): Promise<DiffSupplement> {
  const ids = new Set([detail.request ?? detail.number, detail.number, ...detail.tasks.map((t) => t.number)]);
  const state = stateOf(detail.requestStatus ?? detail.status);
  const plan = planSupplement(detail.objects);
  const files: SupplementFile[] = [];
  const diffs = new Map<string, string>();
  const gone = new Set<string>();
  const notCovered = [...plan.notCovered];
  let requests = 0;
  let templates = 0;

  await deps.withRest(async (rest) => {
    const get = async (path: string, accept: string): Promise<string | undefined> => {
      requests += 1;
      try {
        return (await rest.expectOk('GET', path, `read ${path}`, { headers: { Accept: accept } })).body;
      } catch (err) {
        if (err instanceof RawAdtError && err.status === 404) return undefined;
        throw err;
      }
    };
    const feedOf = async (path: string) => {
      const xml = await get(path, FEED_MEDIA_TYPE);
      return xml === undefined ? undefined : parseFeed(xml);
    };
    const text = async (e: FeedEntry | undefined) => (e?.content ? toLocal((await get(e.content, 'text/plain')) ?? '') : '');

    /** Diff the files of one object; `skip` names the ones getDiff shows, `known` feeds already read. */
    const diffFiles = async (
      id: string,
      list: Array<{ file: string; feed: string }>,
      skip: Set<string>,
      reason: SupplementFile['reason'],
      known: Map<string, FeedEntry[]>,
    ) => {
      for (const { file, feed } of list) {
        if (skip.has(file)) continue;
        const versions = known.get(feed) ?? (await feedOf(feed));
        if (!versions) continue;
        // Deleted while the request is open: no version names it; its last one against nothing.
        const pick = pickVersions(versions, ids, state) ?? (state === 'open' && reason === 'gone' ? lastVersion(versions) : undefined);
        if (!pick) continue;
        const [before, after] = [await text(pick.old), pick.new.id === DELETED ? '' : await text(pick.new)];
        // A class include the request created as SAP's template, nothing written into it yet.
        if (pick.old === undefined && isTemplate(after)) {
          templates += 1;
          continue;
        }
        const diff = unifiedDiff(file, before, after);
        if (diff === '') continue;
        files.push({ object: id, file, ...(pick.old ? { old: pick.old.id } : {}), new: pick.new.id, reason });
        diffs.set(`${id}\u0000${file}`, diff);
      }
    };

    const one = async (o: Planned) => {
      const id = `${o.type} ${o.name}`;
      const stem = fileStem(o.name);
      const mainFile =
        o.type === 'CLAS' ? `${stem}.clas.abap` : o.type === 'FUGR' ? groupMainFile(o.name) : `${stem}.${o.type.toLowerCase()}.${SOURCE_EXT[o.type]}`;
      const [main] = feedsOf(o.type, o.name, [mainFile]);
      if (!main) return;
      const mainVersions = await feedOf(main.feed);
      // No feed at all: never versioned, or a type without version management.
      if (!mainVersions) return;
      const known = new Map([[main.feed, mainVersions]]);
      if (!exists(mainVersions)) {
        gone.add(id);
        const all =
          o.type === 'CLAS' ? feedsOf('CLAS', o.name, CLASS_FILES.map((f) => `${stem}.clas.${f}`)) : [main];
        if (o.type === 'FUGR') notCovered.push(`${id}: no longer exists, its main program only (its other parts can't be listed)`);
        await diffFiles(id, all, new Set(), 'gone', known);
        return;
      }
      if (o.type === 'CLAS') {
        await diffFiles(id, feedsOf('CLAS', o.name, CLASS_FILES.map((f) => `${stem}.clas.${f}`)), o.covered, 'include', known);
      } else if (o.type === 'FUGR') {
        const parts = await groupFiles(deps.adt, o.name);
        if (!parts) {
          notCovered.push(`${id}: its parts couldn't be listed; main program only (getDiff)`);
          return;
        }
        await diffFiles(id, feedsOf('FUGR', o.name, parts), o.covered, 'include', known);
      }
    };

    // An object whose reads fail is named in `notCovered`; the rate limit's refusal stops the rest.
    let throttled: ThrottledError | undefined;
    await pool(plan.objects, deps.concurrency ?? 3, async (o) => {
      const id = `${o.type} ${o.name}`;
      if (throttled) {
        notCovered.push(`${id}: not read, ${throttled.message}`);
        return;
      }
      try {
        await one(o);
      } catch (err) {
        if (err instanceof ThrottledError) throttled ??= err;
        notCovered.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  // Stable order: by object, then file.
  files.sort((a, b) => (a.object === b.object ? (a.file < b.file ? -1 : 1) : a.object < b.object ? -1 : 1));
  return {
    via: 'rest-fallback',
    nativeAvailable: null,
    diff: files.map((f) => diffs.get(`${f.object}\u0000${f.file}`)!).join('\n'),
    files,
    gone: [...gone].sort(),
    templates,
    notCovered,
    requests,
  };
}

export async function diff(deps: TransportDiffDeps, input: TransportDiffInput): Promise<TransportDiffResult> {
  const transport = input.transport.toUpperCase();
  // The first page's supplement runs beside getDiff's slower pass; it never fails the page.
  const extra =
    input.cursor === undefined
      ? deps
          .withRest((rest) => read(rest, transport))
          .then((detail) => supplement(deps, detail))
          .then(
            (s): { supplement?: DiffSupplement; supplementError?: string } => ({ supplement: s }),
            (err: unknown) => ({ supplementError: err instanceof Error ? err.message : String(err) }),
          )
      : Promise.resolve({});
  const page = await deps.adt.transport.getDiff(transport, {
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
  });
  const raw = page.diffResult ?? '';
  // getDiff answers a page without changes with a sentence instead of a diff.
  const text = /^\s*(?:No differences found\.?)?\s*$/.test(raw) ? '' : raw;
  return {
    via: 'adt-ls',
    transport,
    diff: text,
    ...(page.message ? { message: page.message } : {}),
    page: {
      ...(page.batchInfo?.processedCount !== undefined ? { processed: page.batchInfo.processedCount } : {}),
      ...(page.batchInfo?.totalObjects !== undefined ? { total: page.batchInfo.totalObjects } : {}),
      ...(page.batchInfo?.remainingCount !== undefined ? { remaining: page.batchInfo.remainingCount } : {}),
    },
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(await extra),
  };
}
