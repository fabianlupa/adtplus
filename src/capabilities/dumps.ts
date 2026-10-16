import { decodeXml, startTags, xmlAttr, type RawAdtClient } from '../backends/rawadt.js';
import type { NativeSupport } from '../core/capabilities.js';
import { feedBound, feedTime, notesOf, type ClockRead } from '../core/clock.js';
import type { Destination } from '../core/destinations.js';
import { assertRuntimeLogsAllowed } from './policy.js';
import { ownUser } from './transport.js';

// --- REST fallback (ADR-015) -------------------------------------------------
//
// adt-ls has no runtime feeds. Wire protocol:
//   GET /sap/bc/adt/runtime/dumps, Accept application/atom+xml;type=feed: newest first, at most
//       100 entries (`$top` narrows), `$query=and(equals(user,X))`, `from`/`to` as UTC
//       YYYYMMDDHHMMSS, both inclusive. SAP ignores a bound it can't parse and answers with the whole feed.
//       Each entry: author (the user), categories "ABAP runtime error" and "Terminated ABAP
//       program", published, a `self` link to runtime/dump/<id>, and an HTML summary of the dump
//       (left unread: it repeats the dump).
//   GET /sap/bc/adt/runtime/dump/<id> (application/vnd.sap.adt.runtime.dump.v1+xml): `dump:dump`
//       with error, exception, terminatedProgram, author, datetime, and `dump:chapter` entries
//       (name, title, line); …/formatted (text/plain) is the text the chapters' lines point into.

const FEED = '/sap/bc/adt/runtime/dumps';
const DUMP = '/sap/bc/adt/runtime/dump';

export const DEFAULT_DUMPS = 20;
export const MAX_DUMPS = 100;
/** A dump's returned chapters are cut at this many characters in all. */
export const MAX_DUMP_CHARS = 40_000;

/** The developer chapters a dump read returns unless `chapters` names others (ADR-015). */
export const DEFAULT_CHAPTERS = ['kap0', 'kap1', 'kap3', 'kap4', 'kap28', 'kap7', 'kap8', 'kap11'];

export interface ListDumpsInput {
  /** Whose dumps: default the logon user, `*` everyone's. */
  user?: string;
  /** Oldest and newest dump time: ISO 8601, YYYY-MM-DD or YYYYMMDDHHMMSS (UTC unless an offset says otherwise). */
  from?: string;
  to?: string;
  /** Entries to return, default 20, at most 100. */
  maxResults?: number;
}

export interface DumpEntry {
  /** For `dump`. */
  id: string;
  /** UTC, ISO 8601 (ADR-016: corrected by the system clock, else as sent and noted). */
  time: string;
  runtimeError: string;
  program: string;
  user: string;
}

export interface DumpList {
  /** The user filtered on, or `*`. */
  user: string;
  dumps: DumpEntry[];
  /** As many entries as asked for came back: there may be older ones (narrow `to`). */
  mayHaveMore?: true;
  /** Set when the times stay as the system sent them (the clock didn't measure). */
  notes?: string[];
  via: 'rest-fallback';
  nativeAvailable: boolean | null;
}

export interface ReadDumpInput {
  id: string;
  /** Chapter names (`kap10`) or titles ("Selected Variables") instead of the developer chapters. */
  chapters?: string[];
}

export interface DumpChapter {
  name: string;
  title: string;
  text: string;
}

export interface DumpDetail {
  id: string;
  runtimeError: string;
  exception?: string;
  program: string;
  user: string;
  time: string;
  chapters: DumpChapter[];
  /** Chapters not returned whole, by name and title: pass them in `chapters` to read them. */
  otherChapters: Array<{ name: string; title: string }>;
  /** The returned text was cut at MAX_DUMP_CHARS. */
  truncated?: true;
  notes?: string[];
  via: 'rest-fallback';
  nativeAvailable: boolean | null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * A time bound as SAP's UTC `YYYYMMDDHHMMSS`, or an error: SAP ignores a bound it can't parse and
 * answers with the whole feed, so one adt+ can't read must not reach it. A date alone is its start
 * as `from`, its end as `to`.
 */
export function feedStamp(value: string, field: 'from' | 'to'): string {
  const raw = value.trim();
  const invalid = new Error(`"${field}" must be a time: 2026-10-12T08:00:00Z, 2026-10-12 or 20261012080000 (UTC), not "${value}"`);
  let date: Date;
  if (/^\d{14}$/.test(raw)) {
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`;
    date = new Date(iso);
    if (Number.isNaN(date.getTime()) || toStamp(date) !== raw) throw invalid;
    return raw;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // A day as `to` takes the whole day: midnight would leave out every dump of it.
    date = new Date(`${raw}T${field === 'to' ? '23:59:59' : '00:00:00'}Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw invalid;
    return toStamp(date);
  }
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!iso) throw invalid;
  date = new Date(raw.endsWith('Z') || iso[7] ? raw : `${raw}Z`);
  // Date rolls 2026-02-30 over to March: compare the calendar part back.
  const local = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6] ?? '00'}Z`);
  if (Number.isNaN(date.getTime()) || local.toISOString().slice(0, 10) !== `${iso[1]}-${iso[2]}-${iso[3]}`) throw invalid;
  return toStamp(date);
}

export function listLimit(maxResults: number | undefined): number {
  if (maxResults === undefined) return DEFAULT_DUMPS;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_DUMPS) {
    throw new Error(`maxResults must be a whole number from 1 to ${MAX_DUMPS}`);
  }
  return maxResults;
}

/** A user name as SAP's filter takes it: no spaces, commas or parentheses, which would change the query. */
export function filterUser(user: string): string {
  const name = user.trim().toUpperCase();
  if (!/^[A-Z0-9_/.@-]{1,40}$/.test(name)) throw new Error(`"user" must be an SAP user name or "*", not "${user}"`);
  return name;
}

/** Every check that needs no SAP call: the system's switch and the parameters. Shared by the runtime log lists. */
export function prepareList(destination: Destination, input: ListDumpsInput) {
  assertRuntimeLogsAllowed(destination);
  return {
    user: input.user === undefined ? undefined : input.user.trim() === '*' ? '*' : filterUser(input.user),
    from: input.from === undefined ? undefined : feedStamp(input.from, 'from'),
    to: input.to === undefined ? undefined : feedStamp(input.to, 'to'),
    top: listLimit(input.maxResults),
  };
}

export type PreparedList = ReturnType<typeof prepareList>;

const ENTRY = /<atom:entry\b[\s\S]*?<\/atom:entry>/g;

/** A dump's id as its `self` link carries it: the path segment after `runtime/dump/`, still encoded. */
function idOf(entry: string): string | undefined {
  const self = [...entry.matchAll(startTags('atom:link'))].map(([tag]) => tag).find((tag) => xmlAttr(tag, 'rel') === 'self');
  const href = (self && xmlAttr(self, 'href')) ?? '';
  return href.match(/\/runtime\/dump\/([^/?#]+)/)?.[1];
}

/** The feed's entries as metadata only: the summary, the dump itself, is never read. */
export function parseDumpFeed(xml: string): DumpEntry[] {
  if (!/<atom:feed\b/.test(xml)) throw new Error('not an Atom feed');
  const out: DumpEntry[] = [];
  for (const [entry] of xml.matchAll(ENTRY)) {
    const id = idOf(entry);
    if (!id) continue;
    const categories = [...entry.matchAll(startTags('atom:category'))].map(([tag]) => ({
      term: xmlAttr(tag, 'term') ?? '',
      label: xmlAttr(tag, 'label') ?? '',
    }));
    // The labels follow the logon language; their order (error, then program) doesn't.
    const byLabel = (re: RegExp, i: number) => (categories.find((c) => re.test(c.label)) ?? categories[i])?.term ?? '';
    out.push({
      id,
      time: entry.match(/<atom:published>([^<]*)<\/atom:published>/)?.[1] ?? '',
      runtimeError: byLabel(/runtime error/i, 0),
      program: byLabel(/program/i, 1),
      user: decodeXml(entry.match(/<atom:author\b[^>]*>\s*<atom:name>([^<]*)<\/atom:name>/)?.[1] ?? ''),
    });
  }
  return out;
}

/** Whose entries a list reads: the one named, `*`, or else the logon user's own. */
export async function listUser(rest: RawAdtClient, destination: Destination, prepared: PreparedList): Promise<string> {
  if (prepared.user !== undefined) return prepared.user;
  const own = await ownUser(rest, destination);
  if (!own) throw new Error(`adt+ system "${destination.id}": the logon user is unknown here; pass "user" (an SAP user name, or "*" for everyone's)`);
  return filterUser(own);
}

/**
 * Keep texts in order up to MAX_DUMP_CHARS in all; the one that crosses the limit is cut with `…`,
 * the rest left out. `whole` holds the indexes returned uncut.
 */
export function capTexts<T extends { text: string }>(items: T[]): { kept: T[]; truncated: boolean; whole: Set<number> } {
  const kept: T[] = [];
  const whole = new Set<number>();
  let left = MAX_DUMP_CHARS;
  for (const [i, item] of items.entries()) {
    if (left <= 0) return { kept, truncated: true, whole };
    const cut = item.text.length > left;
    kept.push(cut ? { ...item, text: `${item.text.slice(0, left)}…` } : item);
    left -= item.text.length;
    if (cut) return { kept, truncated: true, whole };
    whole.add(i);
  }
  return { kept, truncated: false, whole };
}

/** List short dumps, own by default, metadata only (ADR-015). One feed request. */
export async function listDumps(
  rest: RawAdtClient,
  destination: Destination,
  prepared: PreparedList,
  native: NativeSupport | undefined,
  clock?: ClockRead,
): Promise<DumpList> {
  const user = await listUser(rest, destination, prepared);
  const query: Record<string, string> = { $top: String(prepared.top) };
  if (user !== '*') query.$query = `and(equals(user,${user}))`;
  const [from, to] = [feedBound(prepared.from, clock), feedBound(prepared.to, clock)];
  if (from) query.from = from;
  if (to) query.to = to;
  const res = await rest.expectOk('GET', FEED, 'list short dumps', { query, headers: { Accept: 'application/atom+xml;type=feed' } });
  const dumps = parseDumpFeed(res.body)
    .slice(0, prepared.top)
    .map((d) => ({ ...d, time: feedTime(d.time, clock) }));
  return {
    user,
    dumps,
    ...(dumps.length >= prepared.top ? { mayHaveMore: true as const } : {}),
    ...notesOf(clock, 'feed'),
    via: 'rest-fallback',
    nativeAvailable: native?.runtimeFeeds ?? null,
  };
}

/** A dump id from `dumps`, as one path segment: spaces encoded, nothing that leaves the segment. */
export function dumpSegment(id: string): string {
  const raw = id.trim();
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error(`"${id}" is not a dump id from "dumps"`);
  }
  if (!/^[A-Za-z0-9_ .-]+$/.test(decoded) || decoded.includes('..') || decoded.trim() === '') {
    throw new Error(`"${id}" is not a dump id from "dumps"`);
  }
  return encodeURIComponent(decoded);
}

interface ChapterIndex {
  name: string;
  title: string;
  line: number;
}

export function parseDumpHeader(xml: string): { root: Record<string, string>; chapters: ChapterIndex[] } {
  const rootTag = xml.match(startTags('dump:dump'))?.[0];
  if (!rootTag) throw new Error('not a dump');
  const attrs = (tag: string) =>
    Object.fromEntries([...tag.matchAll(/\s([\w:]+)="([^"]*)"/g)].map(([, k, v]) => [k!, decodeXml(v!)]));
  const chapters = [...xml.matchAll(startTags('dump:chapter'))]
    .map(([tag]) => attrs(tag))
    .map((a) => ({ name: a.name ?? '', title: a.title ?? '', line: Number(a.line) }))
    .filter((c) => c.name && Number.isInteger(c.line) && c.line > 0)
    .sort((a, b) => a.line - b.line);
  return { root: attrs(rootTag), chapters };
}

/** Pick chapters by name or title, case-insensitive; an unknown one is an error naming the valid ones. */
function pickChapters(index: ChapterIndex[], wanted: string[] | undefined): ChapterIndex[] {
  if (!wanted || wanted.every((w) => w.trim() === '')) return index.filter((c) => DEFAULT_CHAPTERS.includes(c.name));
  const picked: ChapterIndex[] = [];
  for (const w of wanted.filter((w) => w.trim() !== '')) {
    const key = w.trim().toLowerCase();
    const hit = index.find((c) => c.name.toLowerCase() === key || c.title.toLowerCase() === key);
    if (!hit) throw new Error(`this dump has no chapter "${w}"; it has: ${index.map((c) => `${c.name} (${c.title})`).join(', ')}`);
    if (!picked.includes(hit)) picked.push(hit);
  }
  return picked.sort((a, b) => a.line - b.line);
}

/**
 * SAP boxes each line of the formatted text and pads it to 100 characters (`|text     |`), with rows
 * of dashes between blocks: half a chapter is padding. Unboxed, trimmed, dash rows and repeated
 * blank lines dropped; the text and its left alignment stay.
 */
export function compactLines(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (/^-{20,}\s*$/.test(line)) continue;
    const text = (line.match(/^\|(.*)\|\s*$/)?.[1] ?? line).replace(/\s+$/, '');
    if (text === '' && (out.length === 0 || out.at(-1) === '')) continue;
    out.push(text);
  }
  return out.join('\n').replace(/\s+$/, '');
}

/** Each chosen chapter's lines of the formatted text, compacted, cut at MAX_DUMP_CHARS in all. */
export function chapterTexts(
  text: string,
  index: ChapterIndex[],
  chosen: ChapterIndex[],
): { chapters: DumpChapter[]; truncated: boolean; whole: Set<string> } {
  const lines = text.split(/\r?\n/);
  const all = chosen.map((c) => {
    const next = index.find((o) => o.line > c.line)?.line ?? lines.length + 1;
    return { name: c.name, title: c.title, text: compactLines(lines.slice(c.line - 1, next - 1)) };
  });
  const { kept, truncated, whole } = capTexts(all);
  /** The chapters returned uncut, by name. */
  return { chapters: kept, truncated, whole: new Set([...whole].map((i) => all[i]!.name)) };
}

/** One dump: its header and the developer chapters, others on request (ADR-015). */
export async function readDump(
  rest: RawAdtClient,
  destination: Destination,
  input: ReadDumpInput,
  native: NativeSupport | undefined,
  clock?: ClockRead,
): Promise<DumpDetail> {
  assertRuntimeLogsAllowed(destination);
  const segment = dumpSegment(input.id);
  const head = await rest.expectOk('GET', `${DUMP}/${segment}`, 'read a short dump', {
    headers: { Accept: 'application/vnd.sap.adt.runtime.dump.v1+xml' },
  });
  const { root, chapters: index } = parseDumpHeader(head.body);
  const chosen = pickChapters(index, input.chapters);
  const formatted = chosen.length > 0
    ? (await rest.expectOk('GET', `${DUMP}/${segment}/formatted`, 'read a short dump', { headers: { Accept: 'text/plain' } })).body
    : '';
  const { chapters, truncated, whole } = chapterTexts(formatted, index, chosen);
  return {
    id: segment,
    runtimeError: root.error ?? '',
    ...(root.exception ? { exception: root.exception } : {}),
    program: root.terminatedProgram ?? '',
    user: root.author ?? '',
    time: feedTime(root.datetime ?? '', clock),
    chapters,
    // Every chapter not returned whole, a chosen one the size limit cut or left out included.
    otherChapters: index.filter((c) => !whole.has(c.name)).map(({ name, title }) => ({ name, title })),
    ...(truncated ? { truncated: true as const } : {}),
    ...notesOf(clock, 'feed'),
    via: 'rest-fallback',
    nativeAvailable: native?.runtimeFeeds ?? null,
  };
}
