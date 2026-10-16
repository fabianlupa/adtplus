import type { ObjectRef } from '@arc-mcp/adt-ls';
import { assertServiceMatches, callFunction, checkService, getEntities, literal, type SapMessage, type ServiceCheck } from '../backends/odata-ui.js';
import { escapeXml, RawAdtError, xmlAttr, startTags, type RawAdtClient } from '../backends/rawadt.js';
import type { Destination } from '../core/destinations.js';
import { languageTag, sapLanguage } from '../core/languages.js';
import { matchingLines } from './object.js';
import { assertTranslationsAllowed } from './policy.js';

/**
 * Translations through translation projects (docs/decisions/019-translations-through-odata-ui-service.md):
 * `object translations` reads the texts of an object or a package from the projects that cover it,
 * `read TRPR` a project's definition and, on request, its texts. Read-only; the writes go through
 * `update TRPR`.
 */

export const TRANSLATION_STATUSES = ['translated', 'missing', 'outdated', 'empty'] as const;
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];

export const DEFAULT_MAX_RESULTS = 100;
export const MAX_RESULTS = 500;

/** Developer extensibility: the only project type adt+ reads (ADR-019 §6). */
export const PROJECT_TYPE = '5';

// --- Text sources and ADT types (ADR-019 §3) -----------------------------------

/** Text source type → ADT type, for the types whose source is the object itself. */
const SOURCE_TYPES: Record<string, string> = {
  PACKAGE: 'DEVC/K',
  DATA_DEF: 'DDLS/DF',
  MTDT_XTNSN: 'DDLX/EX',
  DATA_ELEM: 'DTEL/DE',
  DOMAIN: 'DOMA/DD',
  MESSAGE_CL: 'MSAG/N',
};

/** A text pool's source name: `CL_<class>`, `FG_<function group>`. */
const TEXT_POOL_PREFIXES: Record<string, string> = { CL_: 'CLAS/OC', FG_: 'FUGR/F' };

/** XLIFF group `datatype` → ADT type (`x-TEXT_POOL` goes through the `resname` prefix). */
const GROUP_TYPES: Record<string, string> = {
  'x-DATA_DEFINITION': 'DDLS/DF',
  'x-METADATA_EXTENSION': 'DDLX/EX',
  'x-DATA_ELEMENT': 'DTEL/DE',
  'x-DOMAIN': 'DOMA/DD',
  'x-MESSAGE_CLASS': 'MSAG/N',
};

export const mainType = (objectType: string): string => objectType.split('/')[0]!.toUpperCase();

/** A text source as an ADT object, where adt+ knows the mapping. */
export function sourceObject(type: string, name: string): ObjectRef | undefined {
  if (SOURCE_TYPES[type]) return { objectType: SOURCE_TYPES[type], name };
  if (type !== 'TEXT_POOL') return undefined;
  const prefix = Object.keys(TEXT_POOL_PREFIXES).find((p) => name.startsWith(p));
  return prefix ? { objectType: TEXT_POOL_PREFIXES[prefix]!, name: name.slice(prefix.length) } : undefined;
}

/** The text source that is the object itself; undefined for a type adt+ doesn't map. */
export function textSourceOf(ref: ObjectRef): { type: string; name: string } | undefined {
  const main = mainType(ref.objectType);
  const name = ref.name.toUpperCase();
  const type = Object.keys(SOURCE_TYPES).find((t) => mainType(SOURCE_TYPES[t]!) === main);
  if (type) return { type, name };
  const prefix = Object.keys(TEXT_POOL_PREFIXES).find((p) => mainType(TEXT_POOL_PREFIXES[p]!) === main);
  return prefix ? { type: 'TEXT_POOL', name: `${prefix}${name}` } : undefined;
}

const MAPPED_TYPES = [...Object.values(SOURCE_TYPES), ...Object.values(TEXT_POOL_PREFIXES)].map(mainType);

// --- XLIFF ---------------------------------------------------------------------

/** One `trans-unit` with its object: adt+'s type where mapped, the group's own type otherwise. */
export interface XliffUnit {
  /** `DTEL/DE`, or the raw type without `x-` (`LTO_DRTY`, `IAM_BUSINESS_CATALOG`). */
  objectType: string;
  name: string;
  /** The unit id without `<type>:<source name>:`; the whole id when it doesn't start so. */
  key: string;
  id: string;
  /** The unit's group as SAP wrote it, for an upload. */
  group: { datatype: string; resname: string };
  source: string;
  /** Absent: no translation. `''`: an empty translation was published. */
  target?: string;
  maxwidth?: number;
  note?: string;
}

export interface XliffFile {
  units: XliffUnit[];
  /** `<file>`'s `source-language` and `target-language` as SAP wrote them (`en-US`), for an upload. */
  languages: { source: string; target: string };
  /** What doesn't have the expected structure. */
  problems: string[];
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Text content: XML's entities and character references decoded in one pass, so `&amp;#38;` stays `&#38;`. */
function text(raw: string): string {
  return raw.replace(/&(#\d+|#x[0-9a-f]+|lt|gt|amp|quot|apos);/gi, (whole, code: string) => {
    if (!code.startsWith('#')) return XML_ENTITIES[code] ?? whole;
    const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    // Past Unicode's range fromCodePoint throws: such a reference stays as written.
    return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

/** The content of child element `name`: undefined when absent, `''` for `<name/>`. */
function child(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`<${name}\\b(?:[^>"]|"[^"]*")*?(?:/>|>([\\s\\S]*?)</${name}>)`));
  return m ? text(m[1] ?? '') : undefined;
}

/**
 * An XLIFF 1.2 file as SAP's download writes it: one `<file>`, a `<group datatype resname>` per
 * object, `trans-unit`s inside. Parsed as XML structure (ADR-019 §6; ADR-012 is about ABAP).
 */
export function parseXliff(xml: string): XliffFile {
  const problems: string[] = [];
  const none = { source: '', target: '' };
  if (!/<xliff\b/.test(xml)) return { units: [], languages: none, problems: ['not an XLIFF file: no <xliff> element'] };
  const fileTag = xml.match(startTags('file'))?.[0];
  if (!fileTag) return { units: [], languages: none, problems: ['no <file> element'] };
  const languages = { source: xmlAttr(fileTag, 'source-language') ?? '', target: xmlAttr(fileTag, 'target-language') ?? '' };
  const units: XliffUnit[] = [];
  const groupRe = /<group\b((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/group>/g;
  const unitRe = /<trans-unit\b((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/trans-unit>/g;
  for (const g of xml.matchAll(groupRe)) {
    const tag = `<group${g[1]}>`;
    const datatype = xmlAttr(tag, 'datatype') ?? '';
    const resname = xmlAttr(tag, 'resname') ?? '';
    let object: ObjectRef = { objectType: datatype.replace(/^x-/, ''), name: resname };
    if (GROUP_TYPES[datatype]) object = { objectType: GROUP_TYPES[datatype], name: resname };
    else if (datatype === 'x-TEXT_POOL') object = sourceObject('TEXT_POOL', resname) ?? object;
    if (!datatype || !resname) problems.push(`a group without datatype or resname: ${tag}`);
    const prefix = `${datatype.replace(/^x-/, '')}:${resname}:`;
    for (const u of g[2]!.matchAll(unitRe)) {
      const unitTag = `<trans-unit${u[1]}>`;
      const id = xmlAttr(unitTag, 'id') ?? '';
      const width = xmlAttr(unitTag, 'maxwidth');
      if (width === undefined) problems.push(`unit ${id} has no maxwidth`);
      const target = child(u[2]!, 'target');
      const note = child(u[2]!, 'note');
      units.push({
        ...object,
        key: id.startsWith(prefix) ? id.slice(prefix.length) : id,
        id,
        group: { datatype, resname },
        source: child(u[2]!, 'source') ?? '',
        ...(target !== undefined ? { target } : {}),
        ...(width !== undefined ? { maxwidth: Number(width) } : {}),
        ...(note !== undefined ? { note } : {}),
      });
    }
  }
  const all = [...xml.matchAll(startTags('trans-unit'))].length;
  if (all !== units.length) problems.push(`${all - units.length} trans-unit(s) outside a group`);
  return { units, languages, problems };
}

/**
 * An upload: only the units being written, each with its target (a unit left out keeps its
 * published translation, changesets probe E1), grouped and with the languages as SAP's download
 * wrote them; the tool element names adt+, not SAP's app
 * (ADR-005, no disguise).
 */
export function buildXliff(project: string, languages: XliffFile['languages'], units: Array<XliffUnit & { target: string }>): string {
  const groups = new Map<string, Array<XliffUnit & { target: string }>>();
  for (const u of units) {
    const key = `${u.group.datatype}\0${u.group.resname}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  const body = [...groups.values()]
    .map(
      (us) =>
        `      <group datatype="${escapeXml(us[0]!.group.datatype)}" resname="${escapeXml(us[0]!.group.resname)}">\n` +
        us
          .map(
            (u) =>
              `        <trans-unit id="${escapeXml(u.id)}"${u.maxwidth !== undefined ? ` maxwidth="${u.maxwidth}" size-unit="char"` : ''}>\n` +
              `          <source>${escapeXml(u.source)}</source>\n          <target>${escapeXml(u.target)}</target>\n` +
              (u.note !== undefined ? `          <note>${escapeXml(u.note)}</note>\n` : '') +
              '        </trans-unit>\n',
          )
          .join('') +
        '      </group>\n',
    )
    .join('');
  return (
    '<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">\n' +
    `  <file datatype="plaintext" original="${escapeXml(project)}" source-language="${escapeXml(languages.source)}" target-language="${escapeXml(languages.target)}">\n` +
    '    <header>\n      <tool tool-id="adtplus" tool-name="adt+"/>\n    </header>\n' +
    `    <body>\n${body}    </body>\n  </file>\n</xliff>\n`
  );
}

// --- Projects ------------------------------------------------------------------

export interface LanguagePair {
  /** SAP's codes, as the service takes them. */
  source: string;
  target: string;
  publishStatus: string;
  lastUploaded?: { at: string; by: string };
  lastPublished?: { at: string; by: string };
}

export interface Project {
  id: string;
  description: string;
  package: string;
  textSources: Array<{ type: string; name: string }>;
  languages: LanguagePair[];
}

/** `/Date(1788480645634+0000)/` → ISO; undefined for null. */
function odataDate(value: unknown): string | undefined {
  const ms = typeof value === 'string' ? value.match(/\/Date\((-?\d+)/)?.[1] : undefined;
  return ms === undefined ? undefined : new Date(Number(ms)).toISOString();
}

type Row = Record<string, unknown>;
/** An OData V2 collection's rows (`d.results`); none when it isn't one. */
export const results = (v: unknown): Row[] => {
  const r = typeof v === 'object' && v !== null ? (v as { results?: unknown }).results : undefined;
  return Array.isArray(r) ? r.filter((x): x is Row => typeof x === 'object' && x !== null) : [];
};

function projectOf(row: Row): Project {
  const stamp = (at: unknown, by: unknown) => {
    const iso = odataDate(at);
    return iso ? { at: iso, by: String(by ?? '') } : undefined;
  };
  return {
    id: String(row.ID),
    description: String(row.Description ?? ''),
    package: String(row.PackageName ?? ''),
    textSources: results(row.to_TextSource).map((s) => ({ type: String(s.Type), name: String(s.Name) })),
    languages: results(row.to_Translation).map((t) => {
      const uploaded = stamp(t.LastUploadedAt, t.LastUploadedBy);
      const published = stamp(t.LastPublishedAt, t.LastPublishedBy);
      return {
        source: String(t.SourceLanguage),
        target: String(t.TargetLanguage),
        publishStatus: String(t.PublishStatus ?? ''),
        ...(uploaded ? { lastUploaded: uploaded } : {}),
        ...(published ? { lastPublished: published } : {}),
      };
    }),
  };
}

const EXPAND = { $expand: 'to_TextSource,to_Translation' };

/** Every developer project with its sources and pairs, in one call; not cached (ADR-019 §3). */
export async function readProjects(rest: RawAdtClient): Promise<Project[]> {
  const { d } = await getEntities(rest, '/Project', { $filter: `Type eq ${literal(PROJECT_TYPE)}`, ...EXPAND });
  return results(d).map(projectOf);
}

/** One project; undefined when it doesn't exist. */
export async function readProject(rest: RawAdtClient, id: string): Promise<Project | undefined> {
  // In the path: encoded, so a name can't leave the entity (`/`, `..`, `?`, `#`).
  const key = `ID=${encodeURIComponent(literal(id))},Type=${literal(PROJECT_TYPE)}`;
  try {
    const { d } = await getEntities(rest, `/Project(${key})`, EXPAND);
    return projectOf(d as Row);
  } catch (err) {
    if (err instanceof RawAdtError && err.status === 404) return undefined;
    throw err;
  }
}

/** One pair's file: `ALL` (every unit) or `DELTA` (missing and outdated), with SAP's messages. */
export async function download(rest: RawAdtClient, project: string, pair: LanguagePair, type: 'ALL' | 'DELTA'): Promise<XliffFile & { messages: SapMessage[] }> {
  const { d, messages } = await callFunction(rest, 'downloadTranslationFile', {
    ProjectID: project,
    ProjectType: PROJECT_TYPE,
    SourceLanguage: pair.source,
    TargetLanguage: pair.target,
    downloadType: type,
    fileType: 'XLIFF',
  });
  const content = (d as { downloadTranslationFile?: { fileContent?: unknown } }).downloadTranslationFile?.fileContent;
  if (typeof content !== 'string') throw new Error(`downloadTranslationFile (${project}, ${pair.source}→${pair.target}, ${type}) answered without fileContent`);
  return { ...parseXliff(content), messages };
}

// --- Entries, narrowing, paging ------------------------------------------------

export interface TranslationEntry {
  /** Absent in `read TRPR`, where the project is the object read. */
  project?: string;
  /** BCP 47. */
  sourceLanguage: string;
  /** The target language, BCP 47. */
  language: string;
  objectType: string;
  name: string;
  key: string;
  source: string;
  target?: string;
  maxwidth?: number;
  note?: string;
  status: TranslationStatus;
}

export type StatusCounts = Record<TranslationStatus, number>;

/**
 * The entries of one pair. A unit is missing without a target, empty with `<target/>` (an empty
 * translation was published, and `DELTA` doesn't list it), outdated with a target in this
 * project's `DELTA`, else translated (ADR-019 §3).
 */
export function entriesOf(project: string, pair: LanguagePair, all: XliffUnit[], delta: Set<string> | undefined): TranslationEntry[] {
  return all.map((u) => {
    const status: TranslationStatus =
      u.target === undefined ? 'missing' : u.target === '' ? 'empty' : delta?.has(u.id) ? 'outdated' : 'translated';
    return {
      project,
      sourceLanguage: languageTag(pair.source),
      language: languageTag(pair.target),
      objectType: u.objectType,
      name: u.name,
      key: u.key,
      source: u.source,
      ...(u.target !== undefined ? { target: u.target } : {}),
      ...(u.maxwidth !== undefined ? { maxwidth: u.maxwidth } : {}),
      ...(u.note !== undefined ? { note: u.note } : {}),
      status,
    };
  });
}

export function countStatuses(entries: TranslationEntry[]): StatusCounts {
  const counts: StatusCounts = { translated: 0, missing: 0, outdated: 0, empty: 0 };
  for (const e of entries) counts[e.status]++;
  return counts;
}

type SortKey = [string, string, string, string, string, string];
const sortKey = (e: TranslationEntry): SortKey => [e.project ?? '', e.sourceLanguage, e.language, e.objectType, e.name, e.key];

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

function encodeCursor(e: TranslationEntry): string {
  return Buffer.from(JSON.stringify(sortKey(e))).toString('base64url');
}

function decodeCursor(cursor: string): SortKey {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(key) && key.length === 6 && key.every((k) => typeof k === 'string')) return key as SortKey;
  } catch {
    // refused below
  }
  throw new Error('"cursor" is not one a translation read gave as nextCursor');
}

/** What a translation read takes besides its object, checked before any call. */
export interface TranslationFilter {
  /** Target language, BCP 47. */
  language?: string;
  translationStatus?: TranslationStatus[];
  grep?: string;
  maxResults?: number;
  cursor?: string;
}

export interface PreparedFilter {
  /** SAP's code of `language`. */
  target?: string;
  statuses?: Set<TranslationStatus>;
  grep?: string;
  maxResults: number;
  after?: SortKey;
}

export function prepareFilter(input: TranslationFilter): PreparedFilter {
  const statuses = input.translationStatus;
  if (statuses !== undefined) {
    if (!Array.isArray(statuses) || statuses.length === 0) throw new Error(`"translationStatus" is a list of ${TRANSLATION_STATUSES.join(', ')}`);
    const unknown = statuses.filter((s) => !(TRANSLATION_STATUSES as readonly string[]).includes(s));
    if (unknown.length > 0) throw new Error(`"translationStatus" takes ${TRANSLATION_STATUSES.join(', ')}, not ${unknown.join(', ')}`);
  }
  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < 0 || maxResults > MAX_RESULTS) throw new Error(`"maxResults" is 0 to ${MAX_RESULTS} (default ${DEFAULT_MAX_RESULTS})`);
  if (input.grep !== undefined) {
    try {
      new RegExp(input.grep, 'i');
    } catch (err) {
      throw new Error(`"grep" is not a regular expression: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    ...(input.language !== undefined ? { target: sapLanguage(input.language) } : {}),
    ...(statuses ? { statuses: new Set(statuses) } : {}),
    ...(input.grep !== undefined ? { grep: input.grep } : {}),
    maxResults,
    ...(input.cursor !== undefined ? { after: decodeCursor(input.cursor) } : {}),
  };
}

export interface Page {
  translations: TranslationEntry[];
  /** Entries matching the filter, on every page. */
  total: number;
  truncated?: true;
  nextCursor?: string;
}

/**
 * Narrowed by status and `grep` (over "<objectType> <name> <key> <source> <target>"), sorted by
 * project, language pair, object and key, from after the cursor's entry: a text published
 * between two pages doesn't shift the rest.
 */
export function narrowAndPage(entries: TranslationEntry[], filter: PreparedFilter): Page {
  let kept = filter.statuses ? entries.filter((e) => filter.statuses!.has(e.status)) : entries;
  if (filter.grep !== undefined) {
    const lines = kept.map((e) => [e.objectType, e.name, e.key, e.source, e.target ?? ''].join(' '));
    const hits = new Set(matchingLines(lines, filter.grep));
    kept = kept.filter((_, i) => hits.has(i));
  }
  const sorted = [...kept].sort((a, b) => compareKeys(sortKey(a), sortKey(b)));
  const rest = filter.after ? sorted.filter((e) => compareKeys(sortKey(e), filter.after!) > 0) : sorted;
  if (filter.maxResults === 0) return { translations: [], total: sorted.length };
  const translations = rest.slice(0, filter.maxResults);
  if (rest.length <= filter.maxResults) return { translations, total: sorted.length };
  return { translations, total: sorted.length, truncated: true, nextCursor: encodeCursor(translations[translations.length - 1]!) };
}

/** Whether `DELTA` is needed: it tells translated from outdated, nothing else. */
const needsDelta = (filter: PreparedFilter): boolean => !filter.statuses || filter.statuses.has('translated') || filter.statuses.has('outdated');

/** One pair's entries (`ALL`, and `DELTA` when the filter needs it), with SAP's messages and the files' problems. */
async function pairEntries(
  rest: RawAdtClient,
  project: string,
  pair: LanguagePair,
  filter: PreparedFilter,
): Promise<{ entries: TranslationEntry[]; messages: SapMessage[]; problems: string[] }> {
  const [all, delta] = await Promise.all([
    download(rest, project, pair, 'ALL'),
    needsDelta(filter) ? download(rest, project, pair, 'DELTA') : undefined,
  ]);
  const ids = delta ? new Set(delta.units.filter((u) => u.target !== undefined).map((u) => u.id)) : undefined;
  const where = `${project} ${languageTag(pair.source)}→${languageTag(pair.target)}`;
  return {
    entries: entriesOf(project, pair, all.units, ids),
    messages: all.messages,
    problems: [...all.problems, ...(delta?.problems ?? [])].map((p) => `${where}: ${p}`),
  };
}

const pairsOf = (project: Project, filter: PreparedFilter): LanguagePair[] =>
  filter.target ? project.languages.filter((l) => l.target === filter.target) : project.languages;

// --- object translations -------------------------------------------------------

export interface TranslationsDeps {
  withRest<T>(fn: (rest: RawAdtClient) => Promise<T>): Promise<T>;
  /** The object's own package. */
  objectPackage(ref: ObjectRef): Promise<string>;
  /** A package's own objects, without its subpackages'. */
  packageObjects(name: string): Promise<ObjectRef[]>;
  /** Record the service check for `system status`. */
  onServiceCheck?(check: ServiceCheck): void;
}

export interface TranslationsInput extends TranslationFilter {
  /** An object, or a package (`DEVC/K`). */
  ref: ObjectRef;
}

/** Everything checked before a session: the switch, the type, the filter. */
export function prepareTranslations(destination: Destination, input: TranslationsInput): { ref: ObjectRef; filter: PreparedFilter } {
  assertTranslationsAllowed(destination);
  const ref = { objectType: input.ref.objectType, name: input.ref.name.toUpperCase() };
  if (!MAPPED_TYPES.includes(mainType(ref.objectType))) {
    throw new Error(`translations reads ${MAPPED_TYPES.join(', ')} (the text sources adt+ maps to an ADT type), not ${ref.objectType}`);
  }
  return { ref, filter: prepareFilter(input) };
}

export interface TranslationsResult extends Page {
  objectType: string;
  name: string;
  /** The projects that cover it, with the pairs read. */
  projects: Array<{ project: string; package: string; languages: Array<{ sourceLanguage: string; language: string }> }>;
  warnings: string[];
  via: 'odata-ui';
}

/** The service check, once per REST session, refusing when the service changed. */
export async function checked(rest: RawAdtClient, system: string, onCheck?: (c: ServiceCheck) => void): Promise<void> {
  const check = await checkService(rest);
  onCheck?.(check);
  assertServiceMatches(check, system);
}

/** SAP's warnings that name the object. */
const aboutObject = (messages: SapMessage[], name: string): string[] =>
  messages.filter((m) => m.message.toUpperCase().includes(name)).map((m) => `${m.code}: ${m.message}`);

/**
 * The texts of an object or a package from every project that covers it (ADR-019 §3). A project
 * covers an object through the object's own text source or a `PACKAGE` source of its own package
 * (not of a superpackage); a package through its own `PACKAGE` source or a source of one of its
 * objects. Only the units of the asked-for objects are kept.
 */
export async function readTranslations(
  deps: TranslationsDeps,
  destination: Destination,
  prepared: { ref: ObjectRef; filter: PreparedFilter },
): Promise<TranslationsResult> {
  const { ref, filter } = prepared;
  const isPackage = mainType(ref.objectType) === 'DEVC';

  return deps.withRest(async (rest) => {
    // The service first: a changed one refuses before adt-ls is asked anything.
    await checked(rest, destination.id, deps.onServiceCheck);
    const all = await readProjects(rest);
    const own = isPackage ? await deps.packageObjects(ref.name) : [ref];
    const objectPackage = isPackage ? ref.name : (await deps.objectPackage(ref)).toUpperCase();
    const wanted = new Set(own.map((o) => `${mainType(o.objectType)} ${o.name.toUpperCase()}`));
    const ownSources = new Set(own.map(textSourceOf).filter((s) => s !== undefined).map((s) => `${s.type} ${s.name}`));
    const covering = all.filter((p) =>
      p.textSources.some((s) => (s.type === 'PACKAGE' && s.name === objectPackage) || ownSources.has(`${s.type} ${s.name}`)),
    );
    const warnings: string[] = [];
    const label = `${ref.objectType} ${ref.name}`;
    if (covering.length === 0) {
      warnings.push(`no translation project covers ${label}${isPackage ? '' : ` (or its package ${objectPackage})`}; adt+ never creates one to read`);
    }

    // Projects that overlap: the same pair in several projects, each with its own "outdated".
    const byPair = new Map<string, string[]>();
    for (const p of covering) for (const l of pairsOf(p, filter)) byPair.set(`${l.source}→${l.target}`, [...(byPair.get(`${l.source}→${l.target}`) ?? []), p.id]);
    for (const [pair, ids] of byPair) {
      if (ids.length < 2) continue;
      const [s, t] = pair.split('→') as [string, string];
      warnings.push(
        `projects ${ids.join(', ')} all cover ${label} for ${languageTag(s)}→${languageTag(t)}: each has its own "outdated" ` +
          `(a text published through one stays outdated in the others), so their entries are listed separately`,
      );
    }

    const projects: TranslationsResult['projects'] = covering.map((p) => ({
      project: p.id,
      package: p.package,
      languages: pairsOf(p, filter).map((l) => ({ sourceLanguage: languageTag(l.source), language: languageTag(l.target) })),
    }));
    for (const p of covering) if (pairsOf(p, filter).length === 0) warnings.push(`${p.id} has no language pair${filter.target ? ` with target ${languageTag(filter.target)}` : ''}`);

    // Every pair at once; the rate limit decides how many requests run.
    const reads = await Promise.all(covering.flatMap((p) => pairsOf(p, filter).map(async (pair) => ({ p, pair, read: await pairEntries(rest, p.id, pair, filter) }))));
    const entries: TranslationEntry[] = [];
    for (const { p, pair, read } of reads) {
      const where = `${p.id} ${languageTag(pair.source)}→${languageTag(pair.target)}`;
      warnings.push(...read.problems);
      const mine = read.entries.filter((e) => wanted.has(`${mainType(e.objectType)} ${e.name}`));
      if (mine.length === 0) {
        const sap = isPackage ? [] : aboutObject(read.messages, ref.name);
        warnings.push(`${where} has no text of ${label}: no translatable text in ${languageTag(pair.source)}${sap.length > 0 ? ` (${sap.join('; ')})` : ''}`);
      }
      // A type without an ADT type (LTO_DRTY, IAM_BUSINESS_CATALOG …) can't be matched to a package's objects.
      const unplaced = isPackage && p.textSources.some((s) => s.type === 'PACKAGE' && s.name === objectPackage)
        ? [...new Set(read.entries.filter((e) => !e.objectType.includes('/')).map((e) => e.objectType))]
        : [];
      if (unplaced.length > 0) {
        warnings.push(`${where}: texts of ${unplaced.join(', ')} are left out, since adt+ can't tell which package they belong to; read TRPR ${p.id} with translationStatus lists them`);
      }
      entries.push(...mine);
    }

    return { objectType: ref.objectType, name: ref.name, projects, ...narrowAndPage(entries, filter), warnings, via: 'odata-ui' as const };
  });
}

// --- read TRPR -----------------------------------------------------------------

/** A translation project goes through the OData UI service, never adt-ls's generic path. */
export function isTranslationProjectType(objectType: string): boolean {
  return mainType(objectType) === 'TRPR';
}

/** `read TRPR` without `translationStatus` takes no text narrowing. */
export function prepareProjectRead(destination: Destination, input: TranslationFilter): PreparedFilter | undefined {
  assertTranslationsAllowed(destination);
  if (input.translationStatus === undefined) {
    const given = (['grep', 'maxResults', 'cursor'] as const).filter((k) => input[k] !== undefined);
    if (given.length > 0) throw new Error(`${given.map((k) => `"${k}"`).join(', ')} narrow a project's texts: add "translationStatus" to read them`);
    return input.language === undefined ? undefined : { target: sapLanguage(input.language), maxResults: 0 };
  }
  return prepareFilter(input);
}

export interface TranslationProjectRead {
  name: string;
  objectType: string;
  package: string;
  properties: {
    header: { description: string };
    package: string;
    textSources: Array<{ type: string; name: string; objectType?: string; objectName?: string }>;
    languages: Array<{
      source: string;
      target: string;
      publishStatus: string;
      lastUploaded?: { at: string; by: string };
      lastPublished?: { at: string; by: string };
      counts?: StatusCounts;
    }>;
    translations?: TranslationEntry[];
  };
  total?: number;
  truncated?: true;
  nextCursor?: string;
  warnings?: string[];
  via: 'odata-ui';
}

/**
 * A project's definition (ADR-019 §4), read without downloading anything; with
 * `translationStatus` also its texts and the counts per status of each pair read.
 * `language` alone narrows the pairs listed.
 */
export async function readTranslationProject(
  rest: RawAdtClient,
  destination: Destination,
  input: { name: string; objectType: string },
  filter: PreparedFilter | undefined,
  onCheck?: (c: ServiceCheck) => void,
): Promise<TranslationProjectRead> {
  await checked(rest, destination.id, onCheck);
  const name = input.name.toUpperCase();
  const project = await readProject(rest, name);
  if (!project) throw new Error(`translation project ${name} does not exist (adt+ reads developer projects, type 5)`);
  const pairs = filter ? pairsOf(project, filter) : project.languages;
  const properties: TranslationProjectRead['properties'] = {
    header: { description: project.description },
    package: project.package,
    textSources: project.textSources.map((s) => {
      const object = sourceObject(s.type, s.name);
      return { ...s, ...(object ? { objectType: object.objectType, ...(object.name !== s.name ? { objectName: object.name } : {}) } : {}) };
    }),
    languages: pairs.map((l) => ({ ...l, source: languageTag(l.source), target: languageTag(l.target) })),
  };
  if (!filter?.statuses) return { name: project.id, objectType: input.objectType, package: project.package, properties, via: 'odata-ui' };

  const entries: TranslationEntry[] = [];
  const warnings: string[] = [];
  // Counts need every status, so DELTA is always read here; every pair at once.
  const reads = await Promise.all(pairs.map((pair) => pairEntries(rest, project.id, pair, { ...filter, statuses: undefined })));
  for (const [i, read] of reads.entries()) {
    warnings.push(...read.problems);
    properties.languages[i]!.counts = countStatuses(read.entries);
    entries.push(...read.entries.map(({ project: _, ...e }) => e));
  }
  const page = narrowAndPage(entries, filter);
  properties.translations = page.translations;
  return {
    name: project.id,
    objectType: input.objectType,
    package: project.package,
    properties,
    total: page.total,
    ...(page.truncated ? { truncated: true as const, nextCursor: page.nextCursor } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    via: 'odata-ui',
  };
}
