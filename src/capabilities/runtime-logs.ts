import { decodeXml, startTags, xmlAttr, type RawAdtClient } from '../backends/rawadt.js';
import type { NativeSupport } from '../core/capabilities.js';
import { feedTime, notesOf, type ClockRead } from '../core/clock.js';
import type { Destination } from '../core/destinations.js';
import { capTexts, listUser, prepareList, type ListDumpsInput, type PreparedList } from './dumps.js';
import { assertRuntimeLogsAllowed } from './policy.js';

// --- REST fallback (ADR-015) -------------------------------------------------
//
// adt-ls has no runtime feeds. Wire protocol:
//   GET /sap/bc/adt/gw/errorlog (Atom): every user's errors, newest first. `$top` caps it;
//       `from`/`to` are ignored, `$query=and(equals(username,X),greaterOrEquals(timestamp,T))`
//       filters (T UTC YYYYMMDDHHMMSS, the bounds inclusive). Without a `$query` SAP returns recent entries only, so
//       one is always sent.
//       Entry: atom:id `<Type>Error/<transaction id>`, title `<Type> Error: <short text>`, author
//       `USER (Full Name)`, updated, and the whole detail as an HTML summary (left unread).
//   GET /sap/bc/adt/gw/errorlog/<Type>Error/<id> (HTML): sections under `<h4 id="…">`: HEADER
//       (the transaction id only in a GW client link), SERVICE, CONTEXT (tables), SOURCE (line
//       numbers and `div.sourceline` apart; the raising line `highlight`, its number `>>`), STACK.
//   GET /sap/bc/adt/runtime/systemmessages (Atom): SM02 broadcasts; no filter attributes.

const GW = '/sap/bc/adt/gw/errorlog';
const SYSTEM_MESSAGES = '/sap/bc/adt/runtime/systemmessages';
const ATOM = { Accept: 'application/atom+xml;type=feed' };

/** Whose errors (default the logon user's own, `*` everyone's), a time window, how many. */
export type ListGatewayErrorsInput = ListDumpsInput;

export interface GatewayErrorEntry {
  /** For `gatewayError`. */
  id: string;
  /** UTC, ISO 8601: the log keeps UTC timestamps, so no correction (ADR-016). */
  time: string;
  /** Frontend, Backend, … as SAP names it. */
  type: string;
  shortText: string;
  user: string;
}

export interface GatewayErrorList {
  user: string;
  errors: GatewayErrorEntry[];
  mayHaveMore?: true;
  via: 'rest-fallback';
  nativeAvailable: boolean | null;
}

export interface GatewayErrorSection {
  /** SAP's anchor: HEADER, SERVICE, CONTEXT, SOURCE, STACK. */
  name: string;
  title: string;
  text: string;
}

export interface ReadGatewayErrorInput {
  id: string;
  /** Section names or titles to return instead of all of them. */
  sections?: string[];
}

export interface GatewayErrorDetail {
  id: string;
  sections: GatewayErrorSection[];
  /** Sections not returned whole, by name and title: pass them in `sections` to read them. */
  otherSections: Array<{ name: string; title: string }>;
  truncated?: true;
  via: 'rest-fallback';
  nativeAvailable: boolean | null;
}

export interface SystemMessage {
  id: string;
  title: string;
  text: string;
  author: string;
  published?: string;
  updated?: string;
}

/** Every check that needs no SAP call: the switch and the parameters, as for dumps. */
export const prepareGatewayList = prepareList;

/** Open lower bound: without any `$query` SAP returns only recent entries. */
const SINCE_EVER = '19700101000000';

/**
 * The feed's `$query`, always sent: SAP ignores `from`/`to` here (the `timestamp` attribute
 * filters), and a feed read without a query returns only recent entries.
 */
export function gatewayQuery(user: string, from: string | undefined, to: string | undefined): string {
  const conditions = [
    ...(user === '*' ? [] : [`equals(username,${user})`]),
    `greaterOrEquals(timestamp,${from ?? SINCE_EVER})`,
    ...(to ? [`lessOrEquals(timestamp,${to})`] : []),
  ];
  return `and(${conditions.join(',')})`;
}

function element(entry: string, name: string): string | undefined {
  const value = entry.match(new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`))?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

/** The feed's entries as metadata only; the HTML summary, the error itself, is never read. */
export function parseGatewayFeed(xml: string): GatewayErrorEntry[] {
  if (!/<atom:feed\b/.test(xml)) throw new Error('not an Atom feed');
  return [...xml.matchAll(/<atom:entry\b[\s\S]*?<\/atom:entry>/g)].flatMap(([entry]) => {
    const id = element(entry, 'atom:id');
    if (!id) return [];
    const title = element(entry, 'atom:title') ?? '';
    const colon = title.indexOf(': ');
    const author = entry.match(/<atom:author\b[^>]*>\s*<atom:name>([^<]*)<\/atom:name>/)?.[1] ?? '';
    return [
      {
        id,
        time: element(entry, 'atom:updated') ?? '',
        type: colon > 0 ? title.slice(0, colon).replace(/\s*Error$/i, '') : id.split('/')[0]!.replace(/Error$/, ''),
        shortText: colon > 0 ? title.slice(colon + 2) : title,
        // `USER (Full Name)`: the user name only.
        user: decodeXml(author).split(' (')[0]!.trim(),
      },
    ];
  });
}

/** List gateway errors, own by default, metadata only (ADR-015). One feed request. */
export async function listGatewayErrors(
  rest: RawAdtClient,
  destination: Destination,
  prepared: PreparedList,
  native: NativeSupport | undefined,
): Promise<GatewayErrorList> {
  const user = await listUser(rest, destination, prepared);
  const query = { $top: String(prepared.top), $query: gatewayQuery(user, prepared.from, prepared.to) };
  const res = await rest.expectOk('GET', GW, 'list gateway errors', { query, headers: ATOM });
  const errors = parseGatewayFeed(res.body).slice(0, prepared.top);
  return {
    user,
    errors,
    ...(errors.length >= prepared.top ? { mayHaveMore: true as const } : {}),
    via: 'rest-fallback',
    nativeAvailable: native?.runtimeFeeds ?? null,
  };
}

/** A gateway error id from `gatewayErrors`: `<Type>Error/<transaction id>`, nothing else. */
export function gatewayErrorPath(id: string): string {
  const trimmed = id.trim();
  if (!/^[A-Za-z]+\/[A-Za-z0-9]+$/.test(trimmed)) throw new Error(`"${id}" is not a gateway error id from "gatewayErrors"`);
  return `${GW}/${trimmed}`;
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—' };

/** Text of an HTML fragment: tags dropped, entities decoded, `&nbsp;` indentation kept. */
export function htmlText(fragment: string): string {
  return fragment
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (whole, code: string) => {
      if (!code.startsWith('#')) return ENTITIES[code.toLowerCase()] ?? whole;
      const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      // Past Unicode's range fromCodePoint throws: such an entity stays as written.
      return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    });
}

/** A link whose text says nothing (`(Replay in GW Client)`) where the value is in the target: the transaction id. */
const GW_CLIENT_LINK = /<a\b[^>]*href="[^"]*\/gw\/client\/project\/([0-9A-Za-z]+)[^"]*"[^>]*>[\s\S]*?<\/a>/gi;

/**
 * A table as lines: a key and one value as `key: value`, more cells joined by ` | `, empty cells
 * left out. The first cell's indentation, SAP's nesting, stays.
 */
function tableText(html: string): string {
  return [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)]
    .map(([row]) => {
      const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, c]) => htmlText(c!.replace(GW_CLIENT_LINK, '$1')));
      const indent = cells[0]?.match(/^\s*/)?.[0] ?? '';
      const filled = cells.map((c) => c.trim()).filter(Boolean);
      if (filled.length === 0) return '';
      const text = filled.length === 2 && cells[0]!.trim() !== '' ? `${filled[0]}: ${filled[1]}` : filled.join(' | ');
      return cells[0]!.trim() !== '' ? `${indent}${text}` : text;
    })
    .filter((line) => line !== '')
    .join('\n');
}

/** The source extract: SAP renders line numbers and code in separate cells; zipped, the termination line marked. */
function sourceText(html: string): string {
  const given = [...html.matchAll(/<span class="linenumber[^>]*>([\s\S]*?)<\/span>/gi)].map(([, n]) => htmlText(n!).trim());
  const lines = [...html.matchAll(/<div class="sourceline([^"]*)"[^>]*>([\s\S]*?)<\/div>/gi)];
  // The raising line's number shows as `>>`: counted from the nearest numbered line, before or after.
  const numbered = (i: number) => (/^\d+$/.test(given[i] ?? '') ? Number(given[i]) : undefined);
  const numberOf = (i: number): number => {
    for (let d = 1; d < lines.length; d++) {
      const before = numbered(i - d);
      if (before !== undefined) return before + d;
      const after = numbered(i + d);
      if (after !== undefined) return after - d;
    }
    return i + 1;
  };
  return lines
    .map(([, cls, code], i) => {
      const n = numbered(i) ?? numberOf(i);
      const mark = /highlight/.test(cls!) ? '>>' : '  ';
      return `${String(n).padStart(4)} ${mark} ${htmlText(code!).replace(/\s+$/, '')}`;
    })
    .join('\n');
}

/** The detail page's sections as text, the contents list left out. */
export function parseGatewayDetail(html: string): GatewayErrorSection[] {
  const heads = [...html.matchAll(/<h4 id="([^"]+)"[^>]*>([\s\S]*?)<\/h4>/gi)];
  if (heads.length === 0) throw new Error('not a gateway error page');
  return heads.flatMap((head, i) => {
    const [, id, title] = head;
    if (id === 'OVERVIEW') return [];
    const body = html.slice(head.index! + head[0].length, heads[i + 1]?.index ?? html.length);
    const text = id === 'SOURCE' ? sourceText(body) : /<table\b/i.test(body) ? tableText(body) : htmlText(body).trim();
    return [{ name: id!, title: htmlText(title!).trim(), text }];
  });
}

/** Pick sections by name or title, case-insensitive; an unknown one is an error naming the valid ones. */
function pickSections(all: GatewayErrorSection[], wanted: string[] | undefined): GatewayErrorSection[] {
  const keys = (wanted ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (keys.length === 0) return all;
  for (const key of keys) {
    if (!all.some((s) => s.name.toLowerCase() === key || s.title.toLowerCase() === key)) {
      throw new Error(`this error has no section "${key}"; it has: ${all.map((s) => `${s.name} (${s.title})`).join(', ')}`);
    }
  }
  return all.filter((s) => keys.includes(s.name.toLowerCase()) || keys.includes(s.title.toLowerCase()));
}

/** One gateway error: its sections as text, cut at the dumps' size limit, the rest by name (ADR-015). */
export async function readGatewayError(
  rest: RawAdtClient,
  destination: Destination,
  input: ReadGatewayErrorInput,
  native: NativeSupport | undefined,
): Promise<GatewayErrorDetail> {
  assertRuntimeLogsAllowed(destination);
  const path = gatewayErrorPath(input.id);
  const res = await rest.expectOk('GET', path, 'read a gateway error', { headers: { Accept: 'text/html' } });
  const all = parseGatewayDetail(res.body);
  const chosen = pickSections(all, input.sections);
  const { kept, truncated, whole } = capTexts(chosen);
  const returned = new Set([...whole].map((i) => chosen[i]!.name));
  return {
    id: input.id.trim(),
    sections: kept,
    otherSections: all.filter((s) => !returned.has(s.name)).map(({ name, title }) => ({ name, title })),
    ...(truncated ? { truncated: true as const } : {}),
    via: 'rest-fallback',
    nativeAvailable: native?.runtimeFeeds ?? null,
  };
}

/** The feed's messages: no filter to apply, no business data (ADR-015). */
export function parseSystemMessages(xml: string): SystemMessage[] {
  if (!/<atom:feed\b/.test(xml)) throw new Error('not an Atom feed');
  return [...xml.matchAll(/<atom:entry\b[\s\S]*?<\/atom:entry>/g)].map(([entry]) => {
    // The text in `summary`, else `content`; its own `type` says whether it is HTML.
    const body = ['atom:summary', 'atom:content']
      .map((name) => ({ tag: entry.match(startTags(name))?.[0], text: entry.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1] }))
      .find((b) => b.text !== undefined);
    const summaryTag = body?.tag ?? '';
    const decoded = decodeXml(body?.text ?? '');
    return {
      id: element(entry, 'atom:id') ?? '',
      title: element(entry, 'atom:title') ?? '',
      text: (xmlAttr(summaryTag, 'type') === 'html' ? htmlText(decoded) : decoded).trim(),
      author: decodeXml(entry.match(/<atom:author\b[^>]*>\s*<atom:name>([^<]*)<\/atom:name>/)?.[1] ?? ''),
      ...(element(entry, 'atom:published') ? { published: element(entry, 'atom:published') } : {}),
      ...(element(entry, 'atom:updated') ? { updated: element(entry, 'atom:updated') } : {}),
    };
  });
}

export async function listSystemMessages(
  rest: RawAdtClient,
  native: NativeSupport | undefined,
  clock?: ClockRead,
): Promise<{ messages: SystemMessage[]; notes?: string[]; via: 'rest-fallback'; nativeAvailable: boolean | null }> {
  const res = await rest.expectOk('GET', SYSTEM_MESSAGES, 'list system messages', { headers: ATOM });
  const messages = parseSystemMessages(res.body).map((m) => ({
    ...m,
    ...(m.published !== undefined ? { published: feedTime(m.published, clock) } : {}),
    ...(m.updated !== undefined ? { updated: feedTime(m.updated, clock) } : {}),
  }));
  return { messages, ...notesOf(clock, 'feed'), via: 'rest-fallback', nativeAvailable: native?.runtimeFeeds ?? null };
}
