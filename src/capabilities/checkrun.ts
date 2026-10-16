import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import { escapeXml, startTags, xmlAttr, type RawAdtClient } from '../backends/rawadt.js';
import type { NativeSupport } from '../core/capabilities.js';
import { searchType } from '../core/search-type.js';
import { checkInclude } from './object.js';
import { isServiceBinding, syntaxNotes, type NavigateResult } from './navigate.js';

// --- REST fallback ---------------------------------------------------------
//
// adt-ls checks an object's stored source only: `didOpen`/`didChange` with other text and then
// `textDocument/diagnostic` report nothing for it.
// ADT's check run takes the text as an artifact and changes nothing. Wire protocol:
//   POST /sap/bc/adt/checkruns?reporters=abapCheckRun, Content-Type
//        application/vnd.sap.adt.checkobjects+xml: a checkObjectList whose checkObject carries
//        the include's text, base64, under the include's source URI
//   → checkRunReports: checkMessage per finding, `uri` ending in `#start=<line>,<column>`
//     (line 1-based, column 0-based), `type` E/W/I, `shortText`.
//
// The same check run checks the JSON types adt-ls can't (CHDO, NROB, RONT, NONT, DESD): adt-ls 1.1.2's
// own JSON check throws "Json factory must be set as load option" before it checks anything.
// Their text goes as `application/json` (`text/plain` is not processed); a stored check without an artifact needs the version that
// exists. Retire the stored route when an adt-ls release checks these types itself.

const PATH = '/sap/bc/adt/checkruns';

export interface SyntaxTextInput {
  ref: ObjectRef;
  /** The include's whole text as it would be saved. */
  source: string;
  /** Classes only: definitions, implementations, macros, testclasses; omit for the main source. */
  include?: string;
}

/** One finding in adt-ls's diagnostic shape (0-based LSP positions), so both routes read alike. */
export interface TextDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** 1 error, 2 warning, 3 information, as LSP counts. */
  severity: 1 | 2 | 3;
  message: string;
  /** Set when the finding sits in another include or object than the one checked. */
  uri?: string;
}

/**
 * AFF JSON types: adt-ls answers its own exception instead of a check, and the check run takes
 * their source as `application/json`.
 */
const JSON_TYPES = new Set(['CHDO', 'NROB', 'RONT', 'NONT', 'DESD']);

const mainType = (ref: ObjectRef): string => ref.objectType.split('/')[0]?.toUpperCase() ?? '';
const isJsonType = (ref: ObjectRef): boolean => JSON_TYPES.has(mainType(ref));

/** The stored source of `ref` is checked through the check run, because adt-ls can't. */
export const checksThroughCheckRun = isJsonType;

/** A check run SAP did not process: nothing was checked. */
export class NotProcessedError extends Error {}

/** E error, A abort, X exit count as errors; W warning; I and anything else information. */
const SEVERITY: Record<string, 1 | 2 | 3> = { E: 1, A: 1, X: 1, W: 2 };

/**
 * The ADT object URI of `ref` from adt-ls's search: the one entry with its exact name. A type the
 * search doesn't know with its subtype is searched by its main type: the known ones at once
 * (`searchType`), any other JSON type after an empty search, as the SDK's `resolveAffUri` does.
 */
async function objectUri(adt: AdtLsClient, ref: ObjectRef): Promise<string> {
  // The search matches by prefix: room for the names that start with this one.
  const search = async (type: string) => (await adt.repository.search(ref.name, { types: [type], maxResults: 100, cold: true })).references;
  const first = searchType(ref.objectType);
  let references = await search(first);
  // JSON types only: elsewhere the main type can name another object (FUGR/FF ZFOO → FUGR ZFOO).
  if (references.length === 0 && isJsonType(ref) && mainType(ref) !== first.toUpperCase()) references = await search(mainType(ref));
  const hit = references.find((r) => r.name.toUpperCase() === ref.name.toUpperCase() && r.uri);
  if (!hit?.uri) throw new Error(`${ref.objectType} ${ref.name} not found`);
  return hit.uri.replace(/^adt:\/\/[^/]+/, '').replace(/[?#].*$/, '');
}

export function sourceUri(objUri: string, include: string | undefined): string {
  return include ? `${objUri}/includes/${include}` : `${objUri}/source/main`;
}

/**
 * The check run's request: `source` as the artifact at `srcUri`, in `contentType`; without a
 * text the stored `version` is checked.
 */
export function checkObjectList(
  objUri: string,
  srcUri: string,
  source: string | undefined,
  { contentType = 'text/plain', version = 'inactive' }: { contentType?: string; version?: 'active' | 'inactive' } = {},
): string {
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">' +
    `<chkrun:checkObject adtcore:uri="${escapeXml(objUri)}" chkrun:version="${version}"`;
  if (source === undefined) return `${head}/></chkrun:checkObjectList>`;
  const content = Buffer.from(source, 'utf8').toString('base64');
  return (
    `${head}><chkrun:artifacts>` +
    `<chkrun:artifact chkrun:contentType="${contentType}; charset=utf-8" chkrun:uri="${escapeXml(srcUri)}">` +
    `<chkrun:content>${content}</chkrun:content></chkrun:artifact></chkrun:artifacts></chkrun:checkObject></chkrun:checkObjectList>`
  );
}

/**
 * The findings of a check run report; `srcUri` is the include checked, so others carry their `uri`.
 * A report that wasn't processed has no findings because nothing was checked: that is an error,
 * never a clean result. `json` (a JSON type's object URI): a finding on the object itself, without
 * a position, is the checked text's, and SAP's repeated findings count once.
 */
export function parseCheckMessages(xml: string, srcUri: string, json?: { objUri: string }): TextDiagnostic[] {
  if (!/<chkrun:checkRunReports\b/.test(xml)) throw new Error('not a check run report');
  const reports = [...xml.matchAll(startTags('chkrun:checkReport'))].map(([tag]) => tag);
  if (reports.length === 0) throw new Error('the check run returned no report');
  for (const report of reports) {
    const status = xmlAttr(report, 'chkrun:status');
    if (status !== 'processed') {
      throw new NotProcessedError(`the syntax check did not run (${status ?? 'no status'}): ${xmlAttr(report, 'chkrun:statusText') ?? ''}`.trim());
    }
  }
  const seen = new Set<string>();
  const items = [...xml.matchAll(startTags('chkrun:checkMessage'))].map(([tag]): TextDiagnostic => {
    const attr = (name: string) => xmlAttr(tag, name);
    const uri = attr('chkrun:uri') ?? '';
    const [path] = uri.split('#');
    const at = uri.match(/#start=(\d+),(\d+)/);
    const line = at ? Math.max(0, Number(at[1]) - 1) : 0;
    const character = at ? Number(at[2]) : 0;
    const position = { line, character };
    return {
      range: { start: position, end: position },
      severity: SEVERITY[attr('chkrun:type') ?? ''] ?? 3,
      message: attr('chkrun:shortText') ?? '',
      ...(path && path !== srcUri && path !== json?.objUri ? { uri: path } : {}),
    };
  });
  if (!json) return items;
  return items.filter((d) => {
    const key = JSON.stringify(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One check run over `objUri`: `source` as the main source or include, or the stored `version`. */
async function runCheck(
  rest: RawAdtClient,
  ref: ObjectRef,
  objUri: string,
  srcUri: string,
  source: string | undefined,
  version: 'active' | 'inactive',
): Promise<TextDiagnostic[]> {
  const res = await rest.expectOk('POST', PATH, 'syntax check', {
    changesNothing: true,
    query: { reporters: 'abapCheckRun' },
    headers: { 'Content-Type': 'application/vnd.sap.adt.checkobjects+xml', Accept: 'application/vnd.sap.adt.checkmessages+xml' },
    body: checkObjectList(objUri, srcUri, source, { contentType: isJsonType(ref) ? 'application/json' : 'text/plain', version }),
  });
  return parseCheckMessages(res.body, srcUri, isJsonType(ref) ? { objUri } : undefined);
}

/**
 * The stored source of `ref` through the check run, for a type adt-ls can't check
 * (`checksThroughCheckRun`): the inactive version, else the active one. SAP doesn't process the
 * inactive one when there is none ("Inactive version for … does not exist", in the logon
 * language), so any unprocessed inactive check tries the active version; its failure is final.
 */
export async function checkStoredItems(
  adt: AdtLsClient,
  rest: RawAdtClient,
  ref: ObjectRef,
): Promise<{ items: TextDiagnostic[]; version: 'active' | 'inactive' }> {
  const objUri = await objectUri(adt, ref);
  const srcUri = sourceUri(objUri, undefined);
  try {
    return { items: await runCheck(rest, ref, objUri, srcUri, undefined, 'inactive'), version: 'inactive' };
  } catch (err) {
    if (!(err instanceof NotProcessedError)) throw err;
    return { items: await runCheck(rest, ref, objUri, srcUri, undefined, 'active'), version: 'active' };
  }
}

/** `navigate syntax`'s stored check for a type adt-ls can't check, as a REST fallback. */
export async function checkStoredSyntax(
  adt: AdtLsClient,
  rest: RawAdtClient,
  ref: ObjectRef,
): Promise<NavigateResult & { via: 'rest-fallback'; nativeAvailable: null }> {
  const { items, version } = await checkStoredItems(adt, rest, ref);
  const which = version === 'inactive' ? 'as last saved, including unactivated changes' : 'as last activated (no unactivated changes)';
  return {
    result: { kind: 'full', items },
    notes: [
      `Checked the stored source ${which}, through ADT's check run: adt-ls can't check ${mainType(ref)}. To check text before saving it, pass it as \`source\`.`,
      ...syntaxNotes([ref], items.map((d) => d.message)),
    ],
    via: 'rest-fallback',
    // adt-ls's failure shows in no session probe; an adt-ls update is retested by hand.
    nativeAvailable: null,
  };
}

/** Every check that needs no SAP call: a service binding has no source, an include must be a class's. */
export function checkTextInput(input: SyntaxTextInput): void {
  if (isServiceBinding(input.ref)) throw new Error(`SRVB ${input.ref.name} has no source to check; its errors show when it is activated or published`);
  const problem = checkInclude(input.ref.objectType, input.include);
  if (problem) throw new Error(problem);
}

/**
 * Syntax-check `source` as the text of `ref`'s main source or class include, without saving it:
 * ADT's check run with the text as artifact (REST, ADR-002).
 */
export async function checkSyntaxText(
  adt: AdtLsClient,
  rest: RawAdtClient,
  input: SyntaxTextInput,
  native: NativeSupport | undefined,
): Promise<NavigateResult & { via: 'rest-fallback'; nativeAvailable: boolean | null }> {
  checkTextInput(input);
  const objUri = await objectUri(adt, input.ref);
  const srcUri = sourceUri(objUri, input.include);
  const items = await runCheck(rest, input.ref, objUri, srcUri, input.source, 'inactive');
  return {
    result: { kind: 'full', items },
    notes: [
      `Checked the given text as ${input.include ? `include ${input.include}` : 'the main source'} of ${input.ref.name}; nothing was saved.`,
      ...syntaxNotes([input.ref], items.map((d) => d.message)),
    ],
    via: 'rest-fallback',
    nativeAvailable: native?.syntaxText ?? null,
  };
}
