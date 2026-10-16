/**
 * OData UI fallback (docs/decisions/019-translations-through-odata-ui-service.md): the unreleased
 * OData V2 UI service `UI_SMTR_PROJECT` behind the Fiori app "Maintain Translations" (F4950).
 * Every capability result built on it carries `via: "odata-ui"`.
 *
 * It runs on the REST fallback's session (`RawAdtClient`: cookies, CSRF token, `sap-language`, the
 * call's rate limit), so every request here counts as one. adt+ sends its own user agent and none
 * of the app's identifying headers (ADR-005, "no disguise").
 */

import { RawAdtError, type RawAdtClient } from './rawadt.js';

export const SERVICE_NAME = 'UI_SMTR_PROJECT';
export const SERVICE_PATH = `/sap/opu/odata/sap/${SERVICE_NAME}`;

const HEADERS = { Accept: 'application/json', 'User-Agent': 'adtplus' };

/** One message of SAP's `sap-message` header: the first and its `details`, flattened. */
export interface SapMessage {
  code: string;
  message: string;
  severity: string;
}

export function parseSapMessages(header: string | null | undefined): SapMessage[] {
  if (!header) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return [{ code: '', message: header, severity: 'unknown' }];
  }
  const one = (m: Record<string, unknown>): SapMessage => ({
    code: String(m.code ?? ''),
    message: String(m.message ?? ''),
    severity: String(m.severity ?? ''),
  });
  const top = parsed as Record<string, unknown>;
  const details = Array.isArray(top.details) ? (top.details as Record<string, unknown>[]) : [];
  return [one(top), ...details.map(one)];
}

/** `ZADTPLUS_X` → `'ZADTPLUS_X'`: an OData V2 string literal for a key or a function import parameter. */
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** SAP's error code and text out of an OData V2 JSON error body. */
function parseODataError(body: string): { code?: string; message?: string } {
  try {
    const error = (JSON.parse(body) as { error?: { code?: string; message?: { value?: string } } }).error;
    return { code: error?.code, message: error?.message?.value };
  } catch {
    return {};
  }
}

/**
 * The `d` of a JSON answer and SAP's messages. Anything but a 200 with a JSON `d` throws: an
 * answer SAP hasn't given before is reported raw, never read as success (ADR-019 §6). A 401
 * stays a `RawAdtError` with `isAuthFailure`, so the session manager logs on again.
 */
function readAnswer(res: { status: number; headers: Headers; body: string }, context: string): { d: unknown; messages: SapMessage[] } {
  if (res.status !== 200) {
    const { code, message } = parseODataError(res.body);
    throw new RawAdtError(res.status, code, message ?? (res.body.slice(0, 300) || res.headers.get('location') || undefined), context);
  }
  let d: unknown;
  try {
    d = (JSON.parse(res.body) as { d?: unknown }).d;
  } catch {
    d = undefined;
  }
  if (d === undefined) throw new RawAdtError(res.status, undefined, `not an OData JSON answer: ${res.body.slice(0, 300)}`, context);
  return { d, messages: parseSapMessages(res.headers.get('sap-message')) };
}

/** `GET` of an entity set or entity (`/Project`, `/Project(ID='X',Type='5')`) with system query options. */
export async function getEntities(rest: RawAdtClient, path: string, query: Record<string, string> = {}): Promise<{ d: unknown; messages: SapMessage[] }> {
  const res = await rest.request('GET', `${SERVICE_PATH}${path}`, { query: { $format: 'json', ...query }, headers: HEADERS });
  return readAnswer(res, `${SERVICE_NAME} GET ${path}`);
}

/** A `GET` function import, its parameters sent as string literals. */
export async function callFunction(rest: RawAdtClient, name: string, params: Record<string, string>): Promise<{ d: unknown; messages: SapMessage[] }> {
  const query = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, literal(v)]));
  const res = await rest.request('GET', `${SERVICE_PATH}/${name}`, { query: { $format: 'json', ...query }, headers: HEADERS });
  return readAnswer(res, `${SERVICE_NAME} ${name}`);
}

// --- Writes: $batch changesets ---------------------------------------------------

export interface ChangesetOperation {
  /** A POST function import. */
  name: string;
  params: Record<string, string>;
}

export interface OperationResult {
  name: string;
  status: number;
  /** Written, yet SAP said something went wrong: an error in `sap-message`, or `IsInvalid`. */
  errors: string[];
  warnings: string[];
}

/** The HTTP answers inside a `$batch` response, in order: status, headers, body. */
export function batchParts(body: string): Array<{ status: number; headers: Headers; body: string }> {
  const parts: Array<{ status: number; headers: Headers; body: string }> = [];
  for (const m of body.matchAll(/HTTP\/1\.1 (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*?)(?=\r?\n--)/g)) {
    const headers = new Headers();
    for (const line of m[2]!.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    parts.push({ status: Number(m[1]), headers, body: m[3]! });
  }
  return parts;
}

const isError = (m: SapMessage) => /^(error|abort)$/i.test(m.severity);

/**
 * POST function imports as one `$batch` changeset: all or nothing, and no URL limit on the
 * parameters (an upload's XLIFF). The operations don't see each other's writes (changesets
 * probe), so only independent calls go in one. Each operation counts once against the rate
 * limit. Throws `RawAdtError` with SAP's code when the changeset failed: then none of it was
 * written. A 2xx answer that still reports an error (`sap-message`, `IsInvalid`) was written: it
 * comes back in `errors`, for the caller to stop before the next changeset.
 */
export async function changeset(rest: RawAdtClient, ops: ChangesetOperation[], context: string): Promise<OperationResult[]> {
  if (ops.length === 0) return [];
  const parts = ops
    .map(({ name, params }) => {
      // `'` encoded too: `encodeURIComponent` leaves it, and the probes sent it encoded.
      const query = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(literal(v)).replace(/'/g, '%27')}`)
        .join('&');
      return (
        '--changeset\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n' +
        `POST ${name}?${query} HTTP/1.1\r\nAccept: application/json\r\nContent-Length: 0\r\n\r\n\r\n`
      );
    })
    .join('');
  const body = `--batch\r\nContent-Type: multipart/mixed; boundary=changeset\r\n\r\n${parts}--changeset--\r\n\r\n--batch--\r\n`;
  const res = await rest.request('POST', `${SERVICE_PATH}/$batch`, {
    headers: { 'Content-Type': 'multipart/mixed; boundary=batch', Accept: 'multipart/mixed', 'User-Agent': HEADERS['User-Agent'] },
    body,
    units: ops.length,
  });
  if (res.status !== 202) {
    const { code, message } = parseODataError(res.body);
    throw new RawAdtError(res.status, code, message ?? (res.body.slice(0, 300) || undefined), context);
  }
  const answers = batchParts(res.body);
  // A failed changeset answers with one error part in its place: everything in it was rolled back.
  const failed = answers.find((a) => a.status >= 400);
  if (failed) {
    const { code, message } = parseODataError(failed.body);
    throw new RawAdtError(failed.status, code, message ?? failed.body.slice(0, 300), context);
  }
  if (answers.length !== ops.length || answers.some((a) => a.status < 200 || a.status > 299)) {
    throw new RawAdtError(res.status, undefined, `${answers.length} answers to ${ops.length} operations, not read as success: ${res.body.slice(0, 300)}`, context);
  }
  return answers.map((a, i) => {
    const name = ops[i]!.name;
    let invalid = false;
    try {
      invalid = (JSON.parse(a.body) as { d?: Record<string, { IsInvalid?: boolean }> }).d?.[name]?.IsInvalid === true;
    } catch {
      // an answer without a body: its status speaks
    }
    const messages = parseSapMessages(a.headers.get('sap-message'));
    const text = (m: SapMessage) => (m.code ? `${m.code}: ${m.message}` : m.message);
    return {
      name,
      status: a.status,
      errors: [...messages.filter(isError).map(text), ...(invalid ? [`SAP marked ${name} invalid`] : [])],
      warnings: messages.filter((m) => !isError(m)).map(text),
    };
  });
}

// --- Service check (ADR-019 §6) -------------------------------------------------

interface Property {
  name: string;
  type: string;
}

/** What adt+ calls, as `$metadata` must declare it: entity sets with their properties, function imports with their parameters. */
const STRING = 'Edm.String';
const strings = (...names: string[]): Property[] => names.map((name) => ({ name, type: STRING }));

const ENTITY_SETS: Record<string, { properties: Property[]; navigation: string[] }> = {
  Project: { properties: strings('ID', 'Type', 'Description', 'PackageName'), navigation: ['to_TextSource', 'to_Translation'] },
  TextSource: { properties: strings('ProjectID', 'ProjectType', 'Type', 'Name'), navigation: [] },
  Translation: {
    properties: [
      ...strings('ProjectID', 'ProjectType', 'SourceLanguage', 'TargetLanguage', 'PublishStatus', 'LastPublishedBy', 'LastUploadedBy'),
      { name: 'LastPublishedAt', type: 'Edm.DateTimeOffset' },
      { name: 'LastUploadedAt', type: 'Edm.DateTimeOffset' },
    ],
    navigation: [],
  },
};

const PAIR = strings('ProjectID', 'ProjectType', 'SourceLanguage', 'TargetLanguage');
const PROJECT = strings('ID', 'Type');

const FUNCTION_IMPORTS: Record<string, { method: 'GET' | 'POST'; parameters: Property[] }> = {
  downloadTranslationFile: { method: 'GET', parameters: [...PAIR, ...strings('downloadType', 'fileType')] },
  getInstalledLanguages: { method: 'GET', parameters: [] },
  getAddableTextSources: { method: 'GET', parameters: PROJECT },
  createProject: { method: 'POST', parameters: [...PROJECT, ...strings('Name', 'Description', 'PackageName', 'transport')] },
  updateProject: { method: 'POST', parameters: [...PROJECT, ...strings('Description', 'transport')] },
  addTextSources: { method: 'POST', parameters: [...PROJECT, ...strings('textSources', 'transport')] },
  createTranslation: { method: 'POST', parameters: [...PROJECT, ...strings('sourceLanguage', 'targetLanguage', 'transport')] },
  uploadTranslationFile: { method: 'POST', parameters: [...PAIR, ...strings('fileType', 'fileContent', 'transport')] },
  publishTranslation: { method: 'POST', parameters: [...PAIR, ...strings('transport')] },
  deleteTranslation: { method: 'POST', parameters: [...PROJECT, ...strings('sourceLanguage', 'targetLanguage', 'transport')] },
  deleteTextSource: { method: 'POST', parameters: [...PROJECT, ...strings('Name', 'text_source_type', 'transport')] },
  deleteProject: { method: 'POST', parameters: [...PROJECT, ...strings('transport')] },
};

/** The parts of `$metadata` the check reads: element name, attributes, and (for a container) its children. */
interface Element {
  attrs: Record<string, string>;
  body: string;
}

function elements(xml: string, name: string): Element[] {
  const out: Element[] = [];
  const re = new RegExp(`<${name}\\b((?:[^>"]|"[^"]*")*?)(/>|>([\\s\\S]*?)</${name}>)`, 'g');
  for (const m of xml.matchAll(re)) {
    const attrs = Object.fromEntries([...m[1]!.matchAll(/([\w:]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!]));
    out.push({ attrs, body: m[3] ?? '' });
  }
  return out;
}

/** Every difference between `$metadata` and what adt+ calls; empty when it matches. */
export function checkMetadata(xml: string): string[] {
  const schema = xml.replace(/<Annotations\b[\s\S]*?<\/Annotations>/g, '');
  const findings: string[] = [];
  const types = new Map(elements(schema, 'EntityType').map((e) => [e.attrs.Name!, e]));
  const sets = new Map(elements(schema, 'EntitySet').map((e) => [e.attrs.Name!, e.attrs.EntityType ?? '']));
  for (const [set, want] of Object.entries(ENTITY_SETS)) {
    const typeName = sets.get(set);
    const type = typeName === undefined ? undefined : types.get(typeName.split('.').pop()!);
    if (!type) {
      findings.push(`entity set ${set} is missing`);
      continue;
    }
    const props = new Map(elements(type.body, 'Property').map((p) => [p.attrs.Name!, p.attrs.Type]));
    for (const p of want.properties) {
      const got = props.get(p.name);
      if (got === undefined) findings.push(`${set}.${p.name} is missing`);
      else if (got !== p.type) findings.push(`${set}.${p.name} is ${got}, not ${p.type}`);
    }
    const navigation = new Set(elements(type.body, 'NavigationProperty').map((n) => n.attrs.Name));
    for (const n of want.navigation) if (!navigation.has(n)) findings.push(`${set}.${n} (navigation) is missing`);
  }
  const imports = new Map(elements(schema, 'FunctionImport').map((f) => [f.attrs.Name!, f]));
  for (const [name, want] of Object.entries(FUNCTION_IMPORTS)) {
    const fi = imports.get(name);
    if (!fi) {
      findings.push(`function import ${name} is missing`);
      continue;
    }
    if (fi.attrs['m:HttpMethod'] !== want.method) findings.push(`${name} is ${fi.attrs['m:HttpMethod'] ?? 'without an HTTP method'}, not ${want.method}`);
    const params = elements(fi.body, 'Parameter');
    const byName = new Map(params.map((p) => [p.attrs.Name!, p.attrs]));
    for (const p of want.parameters) {
      const got = byName.get(p.name);
      if (!got) findings.push(`${name}(${p.name}) is missing`);
      else if (got.Type !== p.type) findings.push(`${name}(${p.name}) is ${got.Type}, not ${p.type}`);
    }
    // A parameter adt+ doesn't send is fine only if SAP doesn't need it.
    const known = new Set(want.parameters.map((p) => p.name));
    for (const p of params) {
      if (!known.has(p.attrs.Name!) && p.attrs.Nullable !== 'true') findings.push(`${name}(${p.attrs.Name}) is new and required`);
    }
  }
  return findings;
}

/** The service check's result, as `system status` shows it. */
export interface ServiceCheck {
  service: typeof SERVICE_NAME;
  ok: boolean;
  /** What differs from what adt+ calls; present when not `ok`. */
  mismatches?: string[];
  checkedAt: string;
}

/** One check per REST session: a new logon checks again. A failed read isn't kept. */
const checks = new WeakMap<RawAdtClient, Promise<ServiceCheck>>();

export function checkService(rest: RawAdtClient): Promise<ServiceCheck> {
  let check = checks.get(rest);
  if (!check) {
    check = (async () => {
      const res = await rest.request('GET', `${SERVICE_PATH}/$metadata`, { headers: { ...HEADERS, Accept: 'application/xml' } });
      if (res.status !== 200) throw new RawAdtError(res.status, undefined, res.body.slice(0, 300) || undefined, `${SERVICE_NAME} $metadata`);
      const mismatches = checkMetadata(res.body);
      return {
        service: SERVICE_NAME,
        ok: mismatches.length === 0,
        ...(mismatches.length > 0 ? { mismatches } : {}),
        checkedAt: new Date().toISOString(),
      } satisfies ServiceCheck;
    })();
    checks.set(rest, check);
    check.catch(() => checks.delete(rest));
  }
  return check;
}

/** Refuse when the service differs from what adt+ calls: adt+ never guesses and never switches to other calls. */
export function assertServiceMatches(check: ServiceCheck, system: string): void {
  if (!check.ok) throw new Error(`${SERVICE_NAME} changed on ${system}: ${check.mismatches!.join('; ')}`);
}
