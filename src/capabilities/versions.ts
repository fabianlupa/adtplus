import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import { RawAdtError, endsLoop, type RawAdtClient } from '../backends/rawadt.js';
import { includeUri } from '../core/active-source.js';
import { feedTime, notesOf, type ClockRead } from '../core/clock.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { feedsOf, parseFeed, type FeedEntry } from '../mirror/history.js';
import { abapName } from '../mirror/layout.js';
import { toLocal } from '../mirror/normalize.js';
import { unifiedDiff } from '../core/udiff.js';
import { CLASS_INCLUDES, checkInclude, checkNarrowing, isClass, narrowText, type NarrowedText, type ReadSourceInput } from './object.js';

/**
 * Version history of one object: `object versions` lists it, `object read` with a version number
 * reads one (REST fallback, ADR-002).
 *
 * adt-ls has no version history. Each source file has a version feed (Atom, `…/versions`,
 * the one `mirror/history.ts` and `transport-diff.ts` read). adt-ls's AFF file name of the object
 * names its feed (`feedsOf`), so a function module or a group's include finds its group without
 * a search. A numbered version (`00001`…) is a released state: it names the request whose release
 * made it; one without a request was stored by hand (SE80 "Generate version"). `00000` is the active version and `99999` the draft; their request is the open one
 * holding the object, or the one that imported it. An object imported from another system has
 * only its `00000` here.
 */

const FEED_MEDIA_TYPE = 'application/atom+xml;type=feed';

export const VERSIONS_DEFAULT_MAX = 50;
export const VERSIONS_HARD_MAX = 500;

export interface ObjectVersion {
  /** Classes: which include (`main` for the class's own source). */
  include?: string;
  /** `00001`… a stored version; `00000` the active one; `99999` the draft. */
  version: string;
  /** `released`: a request's release made it; `stored`: numbered, no request (stored by hand). */
  state: 'released' | 'stored' | 'active' | 'draft';
  /** The request whose release made it; for the active version and the draft, the open one holding it or the one that imported it. */
  request?: string;
  /** The request's description. */
  description?: string;
  /** SAP user. */
  author: string;
  /** UTC (ADR-016): a release's time, the active version's last activation, the draft's last save. */
  at: string;
}

export interface VersionsInput extends ObjectRef {
  /** Classes: one include only; absent: the main source and every include. */
  include?: string;
  maxResults?: number;
}

export interface VersionsResult {
  via: 'rest-fallback';
  /** Always null: no probe tells whether adt-ls has version history (ADR-002). */
  nativeAvailable: null;
  name: string;
  objectType: string;
  /** Per file (`main`, then `CLASS_INCLUDES` order): the draft, the active version, then numbered ones newest first. */
  versions: ObjectVersion[];
  /** `maxResults` cut a file's list. */
  truncated?: true;
  notes: string[];
}

export interface VersionReadResult extends NarrowedText {
  via: 'rest-fallback';
  nativeAvailable: null;
  /** The file read: an include's own file for an include. */
  uri: string;
  include: string;
  version: ObjectVersion;
  notes: string[];
}

export interface VersionsDeps {
  /** The system clock: feed times become UTC (ADR-016); absent or unmeasured, they stay as sent. */
  clock?: ClockRead;
  adt: AdtLsClient;
  withRest: <T>(fn: (rest: RawAdtClient) => Promise<T>) => Promise<T>;
}

/** A version number another call can read: `00001`…`99998`; `00000` and `99999` are `active`/`inactive`. */
export function isVersionNumber(version: string | undefined): version is string {
  return version !== undefined && /^\d{5}$/.test(version) && version !== '00000' && version !== '99999';
}

/** The AFF file name at the end of an `abap:` URI, decoded (`(ns)cl_x.clas.abap`). */
function affFileName(fileUri: string): string {
  return decodeURIComponent(fileUri.slice(fileUri.lastIndexOf('/') + 1));
}

/** The version feed of an AFF file (`zfg.fugr.z_fm.func.abap`, `zcl_x.clas.testclasses.abap`); undefined when its type has none. */
export function feedOfFile(fileUri: string): string | undefined {
  const file = affFileName(fileUri).toLowerCase();
  const [stem, type] = file.split('.');
  if (!stem || !type) return undefined;
  return feedsOf(type.toUpperCase(), abapName(stem), [file])[0]?.feed;
}

function toVersion(e: FeedEntry, include: string | undefined, clock: ClockRead | undefined): ObjectVersion {
  return {
    ...(include !== undefined ? { include } : {}),
    version: e.id,
    state: e.id === '00000' ? 'active' : e.id === '99999' ? 'draft' : e.request !== undefined ? 'released' : 'stored',
    ...(e.request !== undefined ? { request: e.request } : {}),
    ...(e.description ? { description: e.description } : {}),
    author: e.author,
    at: feedTime(e.updated, clock),
  };
}

/** The draft first, then the active version, then released ones newest first. */
const RANK = (id: string) => (id === '99999' ? 2 : id === '00000' ? 1 : 0);
function byRecency(a: FeedEntry, b: FeedEntry): number {
  return RANK(b.id) - RANK(a.id) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** A feed's entries, or undefined when the file has none (404). */
async function readFeed(rest: RawAdtClient, feed: string, what: string): Promise<FeedEntry[] | undefined> {
  try {
    return parseFeed((await rest.expectOk('GET', feed, `read the versions of ${what}`, { headers: { Accept: FEED_MEDIA_TYPE } })).body);
  } catch (err) {
    if (err instanceof RawAdtError && err.status === 404) return undefined;
    throw err;
  }
}

/** One version's text, as a pull would write it. */
async function readContent(client: RawAdtClient, e: FeedEntry, what: string): Promise<string> {
  if (!e.content) throw new Error(`version ${e.id} of ${what} names no content to read`);
  return toLocal((await client.expectOk('GET', e.content, `read version ${e.id} of ${what}`, { headers: { Accept: 'text/plain' } })).body);
}

/** "has no version 00007" / "has no active version", with the versions the feed has. */
function missing(what: string, side: string, entries: FeedEntry[]): Error {
  const known = entries.map((e) => e.id).sort().reverse().join(', ') || 'none';
  return new Error(`${what} has no ${/^\d/.test(side) ? `version ${side}` : `${side} version`}; its versions: ${known}`);
}

function noHistory(ref: ObjectRef): Error {
  return new Error(
    `${ref.name} (${ref.objectType}) has no version history adt+ can read: only source files have one ` +
      '(classes and their includes, interfaces, programs and includes, function groups and modules, CDS sources, ' +
      'behaviour definitions, service definitions, tables)',
  );
}

/** An error that ends the call rather than one file's list: the rate limit, a refused logon. */
const fatal = (err: unknown) => err instanceof ThrottledError || (err instanceof RawAdtError && err.isAuthFailure);

/**
 * An object's versions: one feed (a class without `include`: one per include, one after another),
 * 1 request each; `maxResults` caps each file's list. A file whose feed fails is noted; all failing fails the call.
 */
export async function listVersions(deps: VersionsDeps, input: VersionsInput): Promise<VersionsResult> {
  const problem = checkInclude(input.objectType, input.include);
  if (problem) throw new Error(problem);
  const max = input.maxResults ?? VERSIONS_DEFAULT_MAX;
  if (!Number.isInteger(max) || max < 1 || max > VERSIONS_HARD_MAX) throw new Error(`maxResults must be a whole number from 1 to ${VERSIONS_HARD_MAX}`);
  const ref: ObjectRef = { name: input.name, objectType: input.objectType };
  const uri = await deps.adt.lifecycle.resolveAffUri(ref);
  const includes: Array<string | undefined> =
    input.include !== undefined ? [input.include] : isClass(input.objectType) ? [undefined, ...CLASS_INCLUDES] : [undefined];
  const files = includes.map((include) => ({ include, feed: feedOfFile(includeUri(uri, include)) }));
  if (files.some((f) => f.feed === undefined)) throw noHistory(ref);
  const tagged = isClass(input.objectType);

  const notes: string[] = notesOf(deps.clock, 'feed').notes ?? [];
  const feeds = await deps.withRest(async (rest) => {
    const read: Array<{ include?: string; entries?: FeedEntry[] }> = [];
    let firstError: unknown;
    let stopped: unknown;
    for (const [i, f] of files.entries()) {
      const what = `${input.name} ${f.include ?? 'main'}`;
      try {
        read.push({ include: f.include, entries: await readFeed(rest, f.feed!, what) });
      } catch (err) {
        if (fatal(err) || files.length === 1) throw err;
        firstError ??= err;
        notes.push(`the versions of ${what} could not be read: ${err instanceof Error ? err.message : String(err)}`);
        // SAP stopped answering: what was read so far, the rest named.
        if (endsLoop(err)) {
          stopped = err;
          const left = files.slice(i + 1).map((g) => g.include ?? 'main');
          if (left.length > 0) notes.push(`not read, since SAP stopped answering: ${left.join(', ')}`);
          break;
        }
      }
    }
    // Nothing read: with the files left, if SAP stopped answering.
    if (read.length === 0) throw stopped ? new Error(notes.join('; '), { cause: stopped }) : firstError;
    return read;
  });
  if (feeds.every((f) => f.entries === undefined)) {
    // A feed that failed may be the one that exists: its error, not "no history".
    if (notes.length > 0) throw new Error(notes.join('; '));
    throw noHistory(ref);
  }
  let truncated = false;
  const all = feeds.flatMap((f) => {
    const sorted = [...(f.entries ?? [])].sort(byRecency);
    if (sorted.length > max) truncated = true;
    return sorted.slice(0, max).map((e) => toVersion(e, tagged ? (f.include ?? 'main') : undefined, deps.clock));
  });
  if (!feeds.some((f) => f.entries?.some((e) => e.request !== undefined && isVersionNumber(e.id)))) {
    notes.push('no released version: none was released from this system (a local object never is; an imported one keeps only its active version here)');
  }
  return {
    via: 'rest-fallback',
    nativeAvailable: null,
    name: input.name,
    objectType: input.objectType,
    versions: all,
    ...(truncated ? { truncated: true as const } : {}),
    notes,
  };
}

/** One released version's source, narrowed like `object read`: 2 requests (the feed, the content). */
export async function readVersion(deps: VersionsDeps, input: Omit<ReadSourceInput, 'version'> & { version: string }): Promise<VersionReadResult> {
  const { version, ...rest } = input;
  if (!isVersionNumber(version)) {
    throw new Error(`version "${version}": a released version's number from \`versions\` (00001…); "active" and "inactive" read the current ones`);
  }
  const problem = checkInclude(input.objectType, input.include) ?? checkNarrowing(rest);
  if (problem) throw new Error(problem);
  const ref: ObjectRef = { name: input.name, objectType: input.objectType };
  const fileUri = includeUri(await deps.adt.lifecycle.resolveAffUri(ref), input.include);
  const feed = feedOfFile(fileUri);
  if (!feed) throw noHistory(ref);
  const includeName = input.include ?? 'main';
  const what = `${input.name} ${includeName}`;

  const { entry, text } = await deps.withRest(async (client) => {
    const entries = await readFeed(client, feed, what);
    if (!entries) throw noHistory(ref);
    const entry = entries.find((e) => e.id === version);
    if (!entry) throw missing(what, version, entries);
    return { entry, text: await readContent(client, entry, what) };
  });

  const notes: string[] = notesOf(deps.clock, 'feed').notes ?? [];
  if (isClass(input.objectType) && input.include === undefined) {
    notes.push("SAP's version store keeps a class's main source as it rebuilds it: case and blank lines can differ from the text as written");
  }
  return {
    via: 'rest-fallback',
    nativeAvailable: null,
    uri: fileUri,
    include: includeName,
    version: toVersion(entry, isClass(input.objectType) ? includeName : undefined, deps.clock),
    notes,
    ...narrowText(text, rest, notes),
  };
}

export const DIFF_DEFAULT_CONTEXT = 3;

export interface DiffVersionsInput extends ObjectRef {
  include?: string;
  /** The newer side: a version number, `active`, or `inactive` (the draft, else active; the default). */
  version?: string;
  /** The older side, as `version`; default: the newest numbered version before `version`. */
  baseVersion?: string;
  /** Unchanged lines around each change, default 3. */
  context?: number;
  /** Cap on the diff's lines; `truncated` says it cut. */
  maxLines?: number;
}

export interface DiffVersionsResult {
  via: 'rest-fallback';
  nativeAvailable: null;
  uri: string;
  include: string;
  base: ObjectVersion;
  version: ObjectVersion;
  /** Unified diff headed by the AFF file name; `''` when both sides are the same text. */
  diff: string;
  truncated?: true;
  notes: string[];
}

/** `active`/`inactive`/a number → the feed entry it names; `inactive` is the draft when there is one. */
function pick(entries: FeedEntry[], which: string): FeedEntry | undefined {
  if (which === 'active') return entries.find((e) => e.id === '00000');
  if (which === 'inactive') return entries.find((e) => e.id === '99999') ?? entries.find((e) => e.id === '00000');
  return entries.find((e) => e.id === which);
}

const isSide = (v: string) => v === 'active' || v === 'inactive' || /^\d{5}$/.test(v);

/**
 * Two versions of one source file as a unified diff: the feed and both contents, 3 requests.
 * Both sides come from the version store, so a class's main source is rebuilt on both alike.
 */
export async function diffVersions(deps: VersionsDeps, input: DiffVersionsInput): Promise<DiffVersionsResult> {
  const newer = input.version ?? 'inactive';
  for (const [key, v] of [['version', newer], ['baseVersion', input.baseVersion]] as const) {
    if (v !== undefined && !isSide(v)) throw new Error(`${key} "${v}": "active", "inactive" or a version number from \`versions\` (00001…)`);
  }
  const problem =
    checkInclude(input.objectType, input.include) ??
    checkNarrowing({ name: input.name, objectType: input.objectType, context: input.context, maxLines: input.maxLines });
  if (problem) throw new Error(problem);
  const ref: ObjectRef = { name: input.name, objectType: input.objectType };
  const fileUri = includeUri(await deps.adt.lifecycle.resolveAffUri(ref), input.include);
  const feed = feedOfFile(fileUri);
  if (!feed) throw noHistory(ref);
  const includeName = input.include ?? 'main';
  const what = `${input.name} ${includeName}`;
  const tag = isClass(input.objectType) ? includeName : undefined;

  const { base, version, texts } = await deps.withRest(async (client) => {
    const entries = await readFeed(client, feed, what);
    if (!entries) throw noHistory(ref);
    const numbered = entries.filter((e) => isVersionNumber(e.id)).sort((a, b) => (a.id < b.id ? 1 : -1));
    const version = pick(entries, newer);
    if (!version) throw missing(what, newer, entries);
    let base: FeedEntry | undefined;
    if (input.baseVersion !== undefined) {
      base = pick(entries, input.baseVersion);
      if (!base) throw missing(what, input.baseVersion, entries);
    } else if (isVersionNumber(version.id)) {
      // A number: the numbered version before it.
      base = numbered.find((e) => e.id < version.id);
      if (!base) throw new Error(`${what} has no numbered version before ${version.id}; give baseVersion`);
    } else {
      // The active version or the draft: the last release (a version stored by hand only when none was released).
      base = numbered.find((e) => e.request !== undefined) ?? numbered[0];
      if (!base) throw new Error(`${what} has no numbered version to compare ${version.id} with; give baseVersion`);
    }
    if (base.id === version.id) throw new Error(`version and baseVersion both name ${base.id}`);
    // One after the other, like a class's feeds: one call keeps one request in flight.
    const texts = [await readContent(client, base, what), await readContent(client, version, what)] as const;
    return { base, version, texts };
  });

  const notes: string[] = notesOf(deps.clock, 'feed').notes ?? [];
  let diff = unifiedDiff(affFileName(fileUri), texts[0], texts[1], input.context ?? DIFF_DEFAULT_CONTEXT);
  if (diff === '') notes.push(`${base.id} and ${version.id} are the same text`);
  let truncated = false;
  if (input.maxLines !== undefined) {
    // The diff ends with a line break, which starts no line.
    const lines = diff.replace(/\n$/, '').split('\n');
    if (lines.length > input.maxLines) {
      diff = `${lines.slice(0, input.maxLines).join('\n')}\n`;
      truncated = true;
    }
  }
  return {
    via: 'rest-fallback',
    nativeAvailable: null,
    uri: fileUri,
    include: includeName,
    base: toVersion(base, tag, deps.clock),
    version: toVersion(version, tag, deps.clock),
    diff,
    ...(truncated ? { truncated: true as const } : {}),
    notes,
  };
}
