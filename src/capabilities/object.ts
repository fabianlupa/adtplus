import { Script, createContext } from 'node:vm';
import { Expressions, Statements } from '@abaplint/core';
import type { AdtLsClient, DirectoryEntry, ObjectRef } from '@arc-mcp/adt-ls';
import { abapStatements, implementedMethod } from '../core/abap-statements.js';
import { includeUri, type ActiveRead } from '../core/active-source.js';
import { classRegionProblem } from '../core/class-regions.js';
import type { Destination } from '../core/destinations.js';
import { deleteTargetUri, resolveForWrite, resolveObject, type ResolvedObject } from '../core/resolve.js';
import { lookupPackageChain } from '../core/placement.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { searchType } from '../core/search-type.js';
import { NOT_IN_TRANSPORT, assignForNextWrite, isNotInTransport, writeAssigning } from './transport.js';
import { assertConfirmed, assertObjectWritable, assertPackageWritable, assertPublishServiceAllowed } from './policy.js';

export interface CreateObjectInput extends ObjectRef {
  packageName: string;
  description: string;
  transportRequestNumber?: string;
  additionalFields?: Record<string, unknown>;
}

/**
 * Create via adt-ls. The matrix leaves catalog-type creation to ADT MCP for
 * Copilot; adt+ wraps it too for CLI/standalone use.
 */
export async function create(
  adt: AdtLsClient,
  destination: Destination,
  input: CreateObjectInput,
): Promise<unknown> {
  await assertPackageWritable(destination, input.packageName, { lookupChain: lookupPackageChain(adt) });
  await assertCreationFields(adt, input);
  return adt.lifecycle.create(input);
}

/** One field of an object type's creation form, as `getObjectTypeDetails` lists it. */
export interface CreationFieldSpec {
  tag: string;
  required?: boolean;
  maxLength?: number;
  values?: string[];
}

/** Fields adt+ fills from the create call itself, never from `additionalFields`. */
const BASE_FIELDS = new Set(['packageName', 'name', 'description']);

/**
 * Fields the form leaves optional but the backend refuses a create without (found live,
 * mirror baseline 2026-10-01): an SRVD without `sourceType` fails with "serviceDefinitionInfo.
 * sourceType is null"; an SRVB without an exact `bindingType` fails to deserialize.
 */
const NEEDED_ANYWAY: Record<string, string[]> = {
  'SRVD/SRV': ['sourceType'],
  'SRVB/SVB': ['bindingType'],
};

const formCache = new WeakMap<AdtLsClient, Map<string, CreationFieldSpec[] | null>>();

async function creationFields(adt: AdtLsClient, objectType: string): Promise<CreationFieldSpec[] | null> {
  let cache = formCache.get(adt);
  if (!cache) formCache.set(adt, (cache = new Map()));
  if (!cache.has(objectType)) {
    // No form (an old adt-ls, a failed read): nothing to check against, so SAP decides as before.
    // Only an answer is cached: a failed read is asked again on the next create.
    if (!adt.lifecycle.getObjectTypeDetails) return null;
    let details: { fields?: CreationFieldSpec[] };
    try {
      details = (await adt.lifecycle.getObjectTypeDetails(objectType)) as { fields?: CreationFieldSpec[] };
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      return null;
    }
    cache.set(objectType, Array.isArray(details?.fields) ? details.fields : null);
  }
  return cache.get(objectType) ?? null;
}

function describeField(f: CreationFieldSpec, required: boolean): string {
  const values = f.values?.length ? `: ${f.values.map((v) => JSON.stringify(v)).join(' | ')}` : '';
  return `${f.tag} (${required ? 'required' : 'optional'}${values})`;
}

/**
 * The type-specific fields of a create, checked against the system's own creation form before
 * the call: unknown keys, missing required ones and values outside the form's list (they are
 * case-sensitive) are refused with every field and value named, instead of SAP's "Data is
 * invalid" or an HTTP 500. Not a gate; it fails open when the form can't be read.
 */
export function checkCreationFields(
  objectType: string,
  name: string,
  fields: CreationFieldSpec[],
  given: Record<string, unknown> = {},
): string | undefined {
  const typeFields = fields.filter((f) => !BASE_FIELDS.has(f.tag));
  const needed = new Set([...typeFields.filter((f) => f.required).map((f) => f.tag), ...(NEEDED_ANYWAY[objectType] ?? [])]);
  const problems: string[] = [];
  const nameField = fields.find((f) => f.tag === 'name');
  if (nameField?.maxLength && name.length > nameField.maxLength) {
    problems.push(`name ${name} is ${name.length} characters, at most ${nameField.maxLength}`);
  }
  for (const key of Object.keys(given)) {
    if (!typeFields.some((f) => f.tag === key)) problems.push(`unknown field "${key}"`);
  }
  for (const f of typeFields) {
    const value = given[f.tag];
    if (value === undefined || value === '') {
      if (needed.has(f.tag)) problems.push(`"${f.tag}" is missing`);
    } else if (f.values?.length && !f.values.includes(String(value))) {
      problems.push(`"${f.tag}": ${JSON.stringify(value)} is not one of ${f.values.map((v) => JSON.stringify(v)).join(', ')}`);
    }
  }
  if (!problems.length) return undefined;
  const list = typeFields.map((f) => describeField(f, needed.has(f.tag))).join('; ');
  return `create ${objectType} ${name}: ${problems.join('; ')}. additionalFields for ${objectType}: ${list || 'none'}`;
}

async function assertCreationFields(adt: AdtLsClient, input: CreateObjectInput): Promise<void> {
  const fields = await creationFields(adt, input.objectType);
  if (!fields) return;
  const problem = checkCreationFields(input.objectType, input.name, fields, input.additionalFields);
  if (problem) throw new Error(problem);
}

export interface UpdateSourceInput extends ObjectRef {
  source: string;
  include?: string;
  /** The request to record the change in when the object is in no open request. */
  transport?: string;
}

/** A 1001 ("Object not assigned to a transport") without a transport to assign: say what to pass, keep the code. */
function notInTransportHint(err: unknown, param: string): never {
  if (!isNotInTransport(err)) throw err;
  throw Object.assign(
    new Error(
      `${err instanceof Error ? err.message : String(err)}: the object is in no open request; send it again with ` +
        `${param} (CLI --transport), the request to record it in`,
    ),
    { code: NOT_IN_TRANSPORT },
  );
}

/**
 * CLI/standalone only — Copilot already has this through the VFS.
 *
 * `resolveForWrite` resolves the ref for the write gate; `lifecycle.update`
 * writes to that same URI with the SDK's revive-and-retry-once. An object in
 * no open request is assigned `transport` on the file written and written
 * again, as `mirror push` does.
 */
export async function updateSource(adt: AdtLsClient, destination: Destination, input: UpdateSourceInput): Promise<void> {
  const includeProblem = checkInclude(input.objectType, input.include);
  if (includeProblem) throw new Error(includeProblem);
  const { transport, ...update } = input;
  const resolved = await resolveForWrite(adt, update);
  await assertObjectWritable(destination, resolved);
  // Only when the new text has a comment in the class frame: is it one the system has already?
  if (input.objectType.toUpperCase().startsWith('CLAS') && input.include === undefined && classRegionProblem(input.source)) {
    const regionProblem = classRegionProblem(input.source, await adt.repository.readFile(resolved.uri));
    if (regionProblem) throw new Error(`${input.name} not written: ${regionProblem}`);
  }
  const file = includeUri(resolved.uri, update.include);
  await writeAssigning(
    () => adt.lifecycle.update({ ...update, uri: resolved.uri }),
    transport,
    (t) => assignForNextWrite(adt, file, t),
  ).catch((err) => notInTransportHint(err, 'transportRequestNumber'));
}

/** A class's AFF include files (`zcl_x.clas.<include>.abap`), the only `include` values adt-ls writes. */
export const CLASS_INCLUDES = ['definitions', 'implementations', 'macros', 'testclasses'] as const;

/** abapGit's names for the same includes, which agents reach for (mirror baseline, 2026-10-01). */
const INCLUDE_ALIASES: Record<string, string> = { locals_def: 'definitions', locals_imp: 'implementations' };

/**
 * An `include` adt-ls can't write answers "Object type not supported: LOCA" after a lock cycle.
 * Refuse it up front with the valid names instead.
 */
export function checkInclude(objectType: string, include: string | undefined): string | undefined {
  if (include === undefined) return undefined;
  const valid = `${CLASS_INCLUDES.join(', ')} (omit include for the main source)`;
  if (!objectType.toUpperCase().startsWith('CLAS')) return `include "${include}": only classes have includes; omit it for ${objectType}`;
  if ((CLASS_INCLUDES as readonly string[]).includes(include)) return undefined;
  const alias = INCLUDE_ALIASES[include.toLowerCase()];
  return `include "${include}" is not a class include${alias ? ` here; abapGit's ${include} is "${alias}"` : ''}. Valid: ${valid}`;
}

export interface ReadSourceInput extends ObjectRef {
  /** Classes only, as `update` takes it; omit for the main source. */
  include?: string;
  /** `inactive` (default): what adt-ls serves, the user's draft if there is one. */
  version?: 'active' | 'inactive';
  /** Only `METHOD <method>.` … `ENDMETHOD.`; `INTF~meth` or just `meth`. */
  method?: string;
  /** Only the lines matching this regex (case-insensitive), with `context` lines around them. */
  grep?: string;
  context?: number;
  /** 1-based, inclusive. */
  fromLine?: number;
  toLine?: number;
  /** Cap on the lines returned; no cap unless given. */
  maxLines?: number;
}

/** A run of lines, 1-based, as an editor counts. */
export interface SourceLines {
  fromLine: number;
  toLine: number;
  text: string;
}

export interface MethodSource extends SourceLines {
  /** The method as the source names it, e.g. `zif_x~calc`. */
  method: string;
  /** The `CLASS … IMPLEMENTATION` it sits in; local classes can repeat a method name. */
  className?: string;
}

export interface ReadSourceResult {
  /** The file read: an include's own file for an include. */
  uri: string;
  /** `main` for the object's own source. */
  include: string;
  /** Which version the text is: `inactive` is the logged-on user's draft. Missing when adt-ls didn't say. */
  served?: 'active' | 'inactive';
  totalLines: number;
  /** The whole source, verbatim, when nothing narrows it: pass it back to `update` as it is. */
  source?: string;
  /** A line range, or a whole source cut by `maxLines`. */
  lines?: SourceLines;
  methods?: MethodSource[];
  /** `grep`: hunks of matching lines with their context. */
  matches?: SourceLines[];
  /** A class's main source read: its other includes that exist. SAP creates all four with a template comment, so listed ≠ used. */
  includes?: string[];
  /** `maxLines` cut the answer. */
  truncated?: boolean;
  notes: string[];
}

export const GREP_DEFAULT_CONTEXT = 2;

/** The SDK's error when adt-ls won't switch an object to its active version, as for one never activated. */
const NO_ACTIVE_VERSION = /did not switch .* to the active version/;

/** Reads `ref` at the active version, in the daemon's exclusive hold on the object (`core/active-source.ts`). */
export type ActiveIncludeReader = (ref: ObjectRef, includes: Array<string | undefined>) => Promise<ActiveRead>;

/**
 * Read an object's source through adt-ls, for clients without ADT for VS Code's `abap://`
 * file system (docs/decisions/010-object-source-read.md). One name search; the version
 * served comes from `abapStat` (0 units). `hold` keeps the read inside the daemon's shared
 * hold on the object; an active read takes it exclusively through `readActive` instead.
 * Narrowing is cut locally from the text read, never another SAP call.
 */
export async function readSource(
  adt: AdtLsClient,
  input: ReadSourceInput,
  deps: { hold: <T>(fn: () => Promise<T>) => Promise<T>; readActive: ActiveIncludeReader },
): Promise<ReadSourceResult> {
  const problem = checkInclude(input.objectType, input.include) ?? checkNarrowing(input);
  if (problem) throw new Error(problem);
  const ref: ObjectRef = { name: input.name, objectType: input.objectType };
  const uri = await adt.lifecycle.resolveAffUri(ref);
  const resolved = { ...ref, uri };
  const fileUri = includeUri(uri, input.include);
  const includeName = input.include ?? 'main';
  const notes: string[] = [];

  let activeText: string | undefined;
  let activeAsServed = false;
  if (input.version === 'active') {
    const active = await deps.readActive(resolved, [input.include]);
    if ('sameAsServed' in active) activeAsServed = true;
    else if (active.texts.has(includeName)) activeText = active.texts.get(includeName);
    else {
      const cause = active.errors?.get(includeName);
      // adt-ls keeps serving the draft of an object that was never activated: there is nothing to switch to.
      if (cause && NO_ACTIVE_VERSION.test(cause)) {
        throw new Error(
          `${input.name} has no active version: adt-ls serves only your draft, as for an object that was never ` +
            'activated. Read it without version "active", or activate it first',
        );
      }
      throw new Error(`the active version of ${input.name} ${includeName} could not be read${cause ? `: ${cause}` : ''}`);
    }
  }

  const wholeMain =
    isClass(input.objectType) &&
    input.include === undefined &&
    [input.method, input.grep, input.fromLine, input.toLine, input.maxLines].every((v) => v === undefined);
  const { text, served: stat, includes } = await deps.hold(async () => {
    const [text, served, includes] = await Promise.all([
      activeText ?? adt.source.read({ ...resolved, include: input.include }),
      activeText !== undefined ? ('active' as const) : statOrUndefined(adt, fileUri),
      wholeMain ? existingIncludes(adt, uri) : undefined,
    ]);
    return { text, served, includes };
  });
  // Between the exclusive check and this read a draft can have been saved: never label it active.
  if (activeAsServed && stat === 'inactive') {
    throw new Error(`${input.name} changed during the active read (a draft was saved meanwhile); read it again`);
  }
  const served = activeAsServed ? 'active' : stat;
  if (served === undefined) notes.push('adt-ls did not say which version it served (abapStat failed)');
  else if (served === 'inactive') notes.push('this is your inactive draft; version "active" reads what is active');

  return { uri: fileUri, include: includeName, served, includes, notes, ...narrowText(text, input, notes) };
}

/** What a read's narrowing gives: the whole text, or the part `method`, `grep` or a line range asks for. */
export type NarrowedText = Pick<ReadSourceResult, 'totalLines' | 'source' | 'lines' | 'methods' | 'matches' | 'truncated'>;

/** Cut `text` to what `input` asks for (checked by `checkNarrowing`); what it found nothing for goes to `notes`. */
export function narrowText(text: string, input: ReadSourceInput, notes: string[]): NarrowedText {
  const all = splitLines(text);
  const totalLines = all.length;
  if (input.method !== undefined) {
    const found = cutMethod(all, input.method);
    if (found.length === 0) {
      const hint =
        isClass(input.objectType) && input.include === undefined
          ? '; local classes are in include "implementations", test classes in "testclasses"'
          : '';
      throw new Error(`no METHOD ${input.method} in ${input.name} ${input.include ?? 'main'}${hint}`);
    }
    const capped = capRuns(found, input.maxLines);
    return { totalLines, methods: capped.runs, ...(capped.truncated && { truncated: true }) };
  }
  if (input.grep !== undefined) {
    const capped = capRuns(grepLines(all, input.grep, input.context ?? GREP_DEFAULT_CONTEXT), input.maxLines);
    if (capped.runs.length === 0) notes.push(`no line matches /${input.grep}/i`);
    return { totalLines, matches: capped.runs, ...(capped.truncated && { truncated: true }) };
  }
  if (input.fromLine === undefined && input.toLine === undefined && (input.maxLines === undefined || input.maxLines >= all.length)) {
    return { totalLines, source: text };
  }
  const range = sliceLines(all, input.fromLine ?? 1, input.toLine ?? all.length);
  if (!range) notes.push(`line ${input.fromLine ?? 1} is past the end: the source has ${all.length} lines`);
  const capped = capRuns(range ? [range] : [], input.maxLines);
  return { totalLines, ...(capped.runs[0] && { lines: capped.runs[0] }), ...(capped.truncated && { truncated: true }) };
}

export const isClass = (objectType: string): boolean => objectType.toUpperCase().startsWith('CLAS');

export function checkNarrowing(input: ReadSourceInput): string | undefined {
  const given = [
    input.method !== undefined && 'method',
    input.grep !== undefined && 'grep',
    (input.fromLine !== undefined || input.toLine !== undefined) && 'fromLine/toLine',
  ].filter(Boolean);
  if (given.length > 1) return `give at most one of method, grep, fromLine/toLine (got ${given.join(', ')})`;
  for (const [key, value, min] of [
    ['fromLine', input.fromLine, 1],
    ['toLine', input.toLine, 1],
    ['maxLines', input.maxLines, 1],
    ['context', input.context, 0],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < min)) return `${key} must be a whole number of at least ${min}`;
  }
  if (input.fromLine !== undefined && input.toLine !== undefined && input.toLine < input.fromLine) {
    return `toLine ${input.toLine} is before fromLine ${input.fromLine}`;
  }
  if (input.grep !== undefined) {
    try {
      new RegExp(input.grep, 'i');
    } catch (err) {
      return `grep: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}

async function statOrUndefined(adt: AdtLsClient, fileUri: string): Promise<'active' | 'inactive' | undefined> {
  try {
    return await adt.repository.abapStat(fileUri);
  } catch (err) {
    if (err instanceof ThrottledError) throw err;
    return undefined;
  }
}

/** A class's includes that exist: an include the class doesn't have fails its stat. */
async function existingIncludes(adt: AdtLsClient, mainUri: string): Promise<string[]> {
  const stats = await Promise.all(CLASS_INCLUDES.map((include) => statOrUndefined(adt, includeUri(mainUri, include))));
  return CLASS_INCLUDES.filter((_, i) => stats[i] !== undefined);
}

/** Lines without their endings; a final line break ends the last line, it doesn't start another. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Lines `from`…`to` (1-based, inclusive, `to` clamped); undefined when `from` is past the end. */
export function sliceLines(lines: string[], from: number, to: number): SourceLines | undefined {
  if (from > lines.length) return undefined;
  const end = Math.min(to, lines.length);
  return { fromLine: from, toLine: end, text: lines.slice(from - 1, end).join('\n') };
}

/**
 * Every `METHOD <name>` … `ENDMETHOD.` block for `name`, case-insensitive, from abaplint's
 * statements (ADR-012). A name without `~` also finds an interface method implemented as
 * `intf~name`. A METHOD without its ENDMETHOD runs to the last line.
 */
export function cutMethod(lines: string[], name: string): MethodSource[] {
  const wanted = name.toLowerCase();
  const found: MethodSource[] = [];
  const statements = abapStatements(lines.join('\n'));
  let className: string | undefined;
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]!;
    if (statement.get() instanceof Statements.ClassImplementation) {
      className = statement.findFirstExpression(Expressions.ClassName)?.concatTokens();
    } else if (statement.get() instanceof Statements.EndClass) {
      className = undefined;
    }
    const method = implementedMethod(statement)?.getStr();
    if (!method) continue;
    const lower = method.toLowerCase();
    if (lower !== wanted && (wanted.includes('~') || !lower.endsWith(`~${wanted}`))) continue;
    let end = i;
    while (end < statements.length - 1 && !(statements[end]!.get() instanceof Statements.EndMethod)) end++;
    const toLine = statements[end]!.get() instanceof Statements.EndMethod ? statements[end]!.getEnd().getRow() : lines.length;
    found.push({ method, ...(className && { className }), ...sliceLines(lines, statement.getStart().getRow(), toLine)! });
    i = end;
  }
  return found;
}

/** How long one `grep` may match before it is refused. */
export const GREP_TIMEOUT_MS = 1000;

const grepScript = new Script(
  '(() => { const re = new RegExp(pattern, "i"); const out = []; for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push(i); return out; })()',
);
const grepContext = createContext({ pattern: '', lines: [] as string[] });

/**
 * The indexes of the lines matching `pattern` (case-insensitive). The caller's regex runs in a
 * `vm` context with a time limit: a pattern with catastrophic backtracking (`(a+)+$`) would
 * otherwise block the daemon's event loop, and every client with it.
 */
export function matchingLines(lines: string[], pattern: string, timeoutMs = GREP_TIMEOUT_MS): number[] {
  grepContext.pattern = pattern;
  grepContext.lines = lines;
  try {
    return [...(grepScript.runInContext(grepContext, { timeout: timeoutMs }) as number[])];
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(
        `grep: /${pattern}/i took over ${timeoutMs} ms and was stopped; narrow the pattern (nested quantifiers backtrack) or the lines (fromLine/toLine, include)`,
      );
    }
    throw err;
  } finally {
    grepContext.lines = [];
  }
}

/** Hunks of the lines matching `pattern`, each with `context` lines around it; overlapping hunks merge. */
export function grepLines(lines: string[], pattern: string, context: number): SourceLines[] {
  const hunks: Array<{ from: number; to: number }> = [];
  for (const i of matchingLines(lines, pattern)) {
    const from = Math.max(1, i + 1 - context);
    const to = Math.min(lines.length, i + 1 + context);
    const last = hunks[hunks.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else hunks.push({ from, to });
  }
  return hunks.map((h) => sliceLines(lines, h.from, h.to)!);
}

/** At most `maxLines` lines over all runs, the last one cut short; no cap without `maxLines`. */
export function capRuns<T extends SourceLines>(runs: T[], maxLines: number | undefined): { runs: T[]; truncated: boolean } {
  if (maxLines === undefined) return { runs, truncated: false };
  const out: T[] = [];
  let left = maxLines;
  for (const run of runs) {
    if (left <= 0) return { runs: out, truncated: true };
    const count = run.toLine - run.fromLine + 1;
    if (count <= left) {
      out.push(run);
      left -= count;
      continue;
    }
    out.push({ ...run, toLine: run.fromLine + left - 1, text: run.text.split('\n').slice(0, left).join('\n') });
    return { runs: out, truncated: true };
  }
  return { runs: out, truncated: false };
}

export interface ActivateBatchInput {
  refs: ObjectRef[];
  forceActivation?: boolean;
  /** Objects adt-ls can't activate (a domain), activated through ADT's REST API. */
  rest?: RestActivationLane;
}

/** Part of a batch activated through ADT's REST API: gated with the rest, activated before it (the rest may use it). */
export interface RestActivationLane {
  refs: ObjectRef[];
  /** What the lane's types are called in a refusal: "domains (DOMA)". */
  label: string;
  /** Gates every ref; returns the activation, run once every object of the batch has passed. */
  gate: () => Promise<() => Promise<ActivateBatchResult>>;
}

export interface ActivateBatchResult {
  checkExecuted: boolean;
  activationExecuted: boolean;
  generationExecuted: boolean;
  diagnostics: unknown[];
  refreshedUris: string[];
}

/** Most refs one `activate` takes: each costs two reads to resolve (ADR-005, bounded fan-out). */
export const ACTIVATE_MAX_REFS = 50;

/**
 * Batch-activate via the raw LSP request — the typed `lifecycle.activate`
 * only takes one ObjectRef, but native `adtLs/activation/activate` accepts
 * several `fileUris` in one call (`activateUris`). `rest`'s objects go through ADT's REST
 * API instead. Every object is gated before any is activated; one answer.
 */
export async function activateBatch(
  adt: AdtLsClient | (() => Promise<AdtLsClient>),
  destination: Destination,
  input: ActivateBatchInput,
): Promise<ActivateBatchResult> {
  const lane = input.rest?.refs.length ? input.rest : undefined;
  const total = input.refs.length + (lane?.refs.length ?? 0);
  if (total === 0) throw new Error('activate needs at least one object: "refs", or "name" and "objectType"');
  if (total > ACTIVATE_MAX_REFS) {
    throw new Error(`activate takes at most ${ACTIVATE_MAX_REFS} objects per call, got ${total}; split the batch.`);
  }
  const incomplete = [...input.refs, ...(lane?.refs ?? [])].find((r) => !r?.name || !r.objectType);
  if (incomplete) throw new Error(`activate: every object needs "name" and "objectType", got ${JSON.stringify(incomplete)}`);
  if (lane && input.forceActivation) throw new Error(`forceActivation is not available for ${lane.label}, which activate through ADT's REST API`);
  const client = async () => (typeof adt === 'function' ? adt() : adt);
  const activateLane = lane ? await lane.gate() : undefined;
  const resolved = input.refs.length > 0 ? await resolveForActivation(await client(), destination, input.refs) : [];
  const results: ActivateBatchResult[] = [];
  if (activateLane) results.push(await activateLane());
  if (resolved.length > 0) results.push(await activateResolved(await client(), resolved, input.forceActivation));
  return mergeActivations(results);
}

/** Resolve and gate every object of a batch, before any is activated: one outside the allowlist refuses the whole batch. */
async function resolveForActivation(adt: AdtLsClient, destination: Destination, refs: ObjectRef[]): Promise<ResolvedObject[]> {
  const resolved = await Promise.all(refs.map((ref) => resolveObject(adt, ref)));
  for (const object of resolved) await assertObjectWritable(destination, object);
  return resolved;
}

/** Activate objects `resolveForActivation` gated. */
async function activateResolved(adt: AdtLsClient, resolved: ResolvedObject[], forceActivation?: boolean): Promise<ActivateBatchResult> {
  const result = await activateUris(adt, resolved.map((r) => r.uri), forceActivation);
  // Neither check nor activation ran and nothing says why: the system found nothing inactive (`onprem`
  // still answers generationExecuted: true, a cloud system all three false). Not a success.
  if (!result.checkExecuted && !result.activationExecuted && result.diagnostics.length === 0) {
    throw new Error(await nothingActivated(adt, resolved));
  }
  return result;
}

/** One answer for a batch activated in parts (REST-activated types, then adt-ls): a phase ran only if it ran in every part. */
function mergeActivations(results: ActivateBatchResult[]): ActivateBatchResult {
  if (results.length === 1) return results[0]!;
  return {
    checkExecuted: results.every((r) => r.checkExecuted),
    activationExecuted: results.every((r) => r.activationExecuted),
    generationExecuted: results.every((r) => r.generationExecuted),
    diagnostics: results.flatMap((r) => r.diagnostics),
    refreshedUris: results.flatMap((r) => r.refreshedUris),
  };
}

/** Why an activation that ran no check activated nothing, from each object's stat (no backend request). */
async function nothingActivated(adt: AdtLsClient, objects: ResolvedObject[]): Promise<string> {
  const stats = await Promise.all(
    objects.map((o) =>
      adt.repository.abapStat(o.uri).catch((err: unknown) => {
        if (err instanceof ThrottledError) throw err;
        return 'unknown' as const;
      }),
    ),
  );
  const names = (keep: (stat: string) => boolean) =>
    objects.filter((_, i) => keep(stats[i]!)).map((o) => `${o.name} (${o.objectType})`).join(', ');
  const inactive = names((s) => s !== 'active');
  if (inactive) {
    return `nothing activated: adt-ls ran neither the check nor the activation and gave no reason; not served active: ${inactive}.`;
  }
  return (
    `nothing activated: there is no inactive version of ${names(() => true)}; what is stored is already active. ` +
    'If you wrote it with `update` (or the mirror), that text is active now, or it equalled the active one: nothing ' +
    'more to do, do not write again. A change made in an editor (an abap: file) is stored only once the editor is saved, ' +
    'and an agent cannot save it: write that source with `update`, then activate.'
  );
}

/**
 * One native `adtLs/activation/activate` over resolved main-file URIs, gated by
 * the caller. Shape verified live.
 */
export async function activateUris(adt: AdtLsClient, fileUris: string[], forceActivation = false): Promise<ActivateBatchResult> {
  const raw = await adt.raw.lsp<{
    isCheckExecuted: boolean;
    isActivationExecuted: boolean;
    isGenerationExecuted: boolean;
    objectDiagnostics?: unknown[];
    refreshFileUris?: string[];
  }>('adtLs/activation/activate', {
    destination: adt.health().destination,
    fileUris,
    references: [],
    forceActivation,
  });
  return {
    checkExecuted: raw.isCheckExecuted,
    activationExecuted: raw.isActivationExecuted,
    generationExecuted: raw.isGenerationExecuted,
    diagnostics: raw.objectDiagnostics ?? [],
    refreshedUris: raw.refreshFileUris ?? [],
  };
}

export async function listInactive(adt: AdtLsClient): Promise<unknown[]> {
  return adt.repository.listInactive();
}

export interface DeleteObjectInput {
  ref: ObjectRef;
  confirm?: boolean;
  /** The request to record the deletion in when the object is in no open request. */
  transport?: string;
}

/**
 * Delete via adt-ls (`fileSystem/delete` on the URI `deleteTargetUri` picks: the `.json` metadata
 * URI for most types). DDLX is a documented, unverified exception: the jars suggest (no live
 * test) that the metadata URI fails there and the source URI (`.ddlx.acds`) must be deleted
 * instead. The real fix is a proper `lifecycle.delete` for DDLX in @arc-mcp/adt-ls.
 *
 * A function group is the other exception (`deleteTargetUri`). `resolveForWrite` has read the
 * target, which a fresh session needs before it can delete it. The SDK's `lifecycle.delete`
 * always deletes the metadata URI, so it has neither branch.
 */
export async function deleteObject(adt: AdtLsClient, destination: Destination, input: DeleteObjectInput): Promise<void> {
  assertConfirmed('object delete', input.confirm);
  const { ref } = input;
  const resolved = await resolveForWrite(adt, ref);
  await assertObjectWritable(destination, resolved);
  const { uri } = resolved;
  const target = deleteTargetUri(ref.objectType, uri);
  // The delete reads its request from the file it deletes; the main source is assigned too, which
  // costs nothing (adt-ls only stores the assignment).
  await writeAssigning(
    () => adt.repository.delete(target),
    input.transport,
    async (t) => {
      for (const file of new Set([target, uri])) await assignForNextWrite(adt, file, t);
    },
  ).catch((err) => notInTransportHint(err, 'transport'));
}

export async function lockStatus(
  adt: AdtLsClient,
  ref: ObjectRef,
): Promise<{ lockingSupported: boolean; lockId: string | null }> {
  return adt.transport.getLockStatus(ref);
}

/**
 * Name → the repotree URI VS Code's VFS serves (`abap:/repotree-v1/...`). That
 * path embeds the package hierarchy and localized folder names, so Copilot
 * cannot construct it. Confirmed by a read, so a stale index cannot return a
 * deleted object.
 */
export async function resolve(adt: AdtLsClient, ref: ObjectRef): Promise<{ uri: string }> {
  const { uri } = await resolveObject(adt, ref);
  return { uri };
}

/** Re-root every adt-ls repotree URI in `text` onto the folder VS Code mounts the same system under. */
export function toVfsUri<T extends string | undefined>(text: T, fromDestination: string, vfsMount?: string): T {
  if (!text || !vfsMount) return text;
  return text.replaceAll(`/repotree-v1/${fromDestination}/`, `/repotree-v1/${encodeURIComponent(vfsMount)}/`) as T;
}

export const SEARCH_DEFAULT_MAX = 25;
export const SEARCH_HARD_MAX = 100;
const LS_URI_BATCH = 10;

export interface SearchInput {
  /** Name pattern; `*` wildcards. */
  query: string;
  /** ADT type filter, e.g. `CLAS/OC` or the bare `CLAS`. */
  objectType?: string;
  maxResults?: number;
}

export interface SearchHit {
  name: string;
  type?: string;
  description?: string;
  /** The URI to open through `abap://`; absent if it could not be derived. */
  uri?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** More objects matched than were returned; narrow the pattern or type. */
  truncated: boolean;
  limit: number;
}

/** Object search where every hit carries its openable URI. The hit count is capped. */
export async function search(adt: AdtLsClient, input: SearchInput): Promise<SearchResult> {
  const limit = Math.min(Math.max(1, Math.floor(input.maxResults ?? SEARCH_DEFAULT_MAX)), SEARCH_HARD_MAX);
  const found = await adt.repository.search(input.query, {
    maxResults: limit + 1,
    cold: true,
    ...(input.objectType ? { types: [searchType(input.objectType)] } : {}),
  });
  const refs = found.references ?? [];
  const page = refs.slice(0, limit);

  const hits: SearchHit[] = [];
  for (let i = 0; i < page.length; i += LS_URI_BATCH) {
    const batch = page.slice(i, i + LS_URI_BATCH);
    const uris = await Promise.all(
      batch.map((r) => (r.uri ? adt.repository.getLsUri(r.uri).catch(() => undefined) : Promise.resolve(undefined))),
    );
    batch.forEach((r, j) => {
      hits.push({ name: r.name, type: r.type, description: r.description, uri: uris[j] });
    });
  }
  return { hits, truncated: refs.length > limit, limit };
}

export interface ListInput {
  packageName: string;
  /** Folder names below the package (localized SAP labels, e.g. from a previous `list`). */
  path?: string[];
  /**
   * How many directory levels to read below `path`. Default 1 — one
   * `readDirectory`, the historical behaviour. Higher values walk the
   * localized category folders on the caller's behalf: the package listing
   * that cost twelve round trips through Copilot (M6.4c "what's in package X",
   * run 2) is a single call at depth 3.
   */
  depth?: number;
  /** Cap on `readDirectory` calls, so a wide or deep package cannot run away. */
  maxRequests?: number;
}

export interface ListEntry {
  name: string;
  kind: 'file' | 'directory';
  /** Folder names between the listed URI and this entry. Absent at the top level. */
  path?: string[];
}

export interface ListResult {
  uri: string;
  /** Breadth-first: every entry of one level before any of the next. `path` says where each sits. */
  entries: ListEntry[];
  /** How many `readDirectory` calls this took. */
  requests: number;
  /** Directories were left unread — `depth` or `maxRequests` stopped the walk. Raise one and call again. */
  truncated: boolean;
  /** Directories below the top level that failed to read, so an unread branch never looks like an empty one. */
  unreadable?: Array<{ path: string[]; message: string }>;
}

export const LIST_DEFAULT_DEPTH = 1;
export const LIST_MAX_DEPTH = 10;
export const LIST_DEFAULT_MAX_REQUESTS = 50;
export const LIST_HARD_MAX_REQUESTS = 200;
/** Sibling directories are read in parallel; this bounds how many are in flight at once. */
const READ_DIR_BATCH = 10;

const joinSegments = (path: string[]): string => path.map((s) => `${encodeURIComponent(s)}/`).join('');

/**
 * Package contents via `readDirectory`. The directory URI is the package
 * *file* URI minus its last segment — `readDirectory` on the file itself
 * silently returns `[]` (M6.0 finding 1). Category folder names are localized
 * and differ per system, so callers must discover them rather than assume —
 * which is what `depth` is for: it discovers them here instead of costing a
 * round trip each.
 *
 * Measured nesting (`onprem`, `ZADTPLUS_TEST_BADI`): package → category (`Source Code
 * Library`, `Enhancements`) → type (`Classes`, `Interfaces`) → **object** →
 * its source files. So depth 3 lists the objects (7 reads) and depth 4 their
 * files (12 reads). An object being a directory is why depth 3 still reports
 * `truncated`.
 */
export async function list(adt: AdtLsClient, input: ListInput): Promise<ListResult> {
  const found = await adt.repository.search(input.packageName, {
    maxResults: 5,
    cold: true,
    types: ['DEVC/K'],
  });
  const hit = found.references?.find(
    (r) => r.name?.toUpperCase() === input.packageName.toUpperCase() && r.uri,
  );
  if (!hit?.uri) throw new Error(`Package "${input.packageName}" was not found`);

  const fileUri = await adt.repository.getLsUri(hit.uri);
  const packageDir = fileUri.slice(0, fileUri.lastIndexOf('/') + 1);
  const uri = packageDir + joinSegments(input.path ?? []);

  const depth = Math.min(Math.max(1, Math.floor(input.depth ?? LIST_DEFAULT_DEPTH)), LIST_MAX_DEPTH);
  const maxRequests = Math.min(
    Math.max(1, Math.floor(input.maxRequests ?? LIST_DEFAULT_MAX_REQUESTS)),
    LIST_HARD_MAX_REQUESTS,
  );

  const readDir = (relative: string[]) =>
    adt.repository.readDirectory(uri + joinSegments(relative)).then((children) => ({ relative, children }));

  const entries: ListEntry[] = [];
  const unreadable: NonNullable<ListResult['unreadable']> = [];
  let requests = 0;
  let truncated = false;
  // One level at a time, siblings in parallel. `[]` is the requested directory itself.
  let frontier: string[][] = [[]];

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const toRead = frontier.slice(0, maxRequests - requests);
    if (toRead.length < frontier.length) truncated = true;
    const next: string[][] = [];

    for (let i = 0; i < toRead.length; i += READ_DIR_BATCH) {
      const batch = toRead.slice(i, i + READ_DIR_BATCH);
      const read = await Promise.all(
        batch.map((relative) =>
          readDir(relative).catch((err: unknown) => {
            // A failure on the requested directory itself is the caller's answer,
            // as it was before `depth` existed. Deeper ones are reported, not thrown:
            // one bad branch must not lose the rest of the tree.
            if (relative.length === 0) throw err;
            unreadable.push({ path: relative, message: err instanceof Error ? err.message : String(err) });
            return { relative, children: [] as DirectoryEntry[] };
          }),
        ),
      );
      requests += batch.length;

      for (const { relative, children } of read) {
        for (const { name, kind } of children) {
          entries.push(relative.length ? { name, kind, path: relative } : { name, kind });
          if (kind === 'directory') next.push([...relative, name]);
        }
      }
    }
    frontier = next;
  }

  if (frontier.length > 0) truncated = true;
  return { uri, entries, requests, truncated, ...(unreadable.length ? { unreadable } : {}) };
}

export interface PublishServiceInput {
  ref: ObjectRef;
  /** The state asked for (ADR-018): refused, with nothing sent, when the binding is already there. */
  target: 'PUBLISH' | 'UNPUBLISH';
  confirm?: boolean;
  /** How long to wait for the published state to flip. Default 5 min: on cloud the job itself takes ~132 s either way. */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * How long to keep re-sending a toggle the backend refuses instantly — the
   * cloud settling window documented on `sendToggle`. Default 0: refusing fast
   * beats blocking a tool call for minutes, so the caller opts in.
   */
  settleTimeoutMs?: number;
  settleIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PublishServiceResult {
  wasPublished: boolean;
  isPublished: boolean;
  /** The direction sent: the backend's `allowedAction`, or `published` where that is not usable. */
  action: 'PUBLISH' | 'UNPUBLISH';
  statusMessage?: string;
  /** Where the final state was read from. */
  verifiedVia: 'fetch_services' | 'serviceBindingDetails';
  waitedMs: number;
}

/** `adtLs/businessservice/srvb/getServiceBindingDetails`; shapes as `onprem` and `cloud-erp` sent them. */
interface ServiceBindingDetails {
  /** Lower-case `v` — this is the string the publish action needs, and a null NPEs adt-ls. */
  odataversion?: string;
  /** Service definition names. For OData V2 the toggle acts on the one sent as `serviceName`. */
  services?: string[];
  objectData?: BindingObjectData;
  srvbObjectData?: BindingObjectData;
}

interface BindingObjectData {
  published?: boolean;
  /** `PUBLISH` or `UNPUBLISH` — the backend's own view of what may happen next. */
  allowedAction?: string;
  /** 0 = active, 1 = inactive (the VS Code extension refuses to publish on 1). */
  version?: number;
}

export const PUBLISH_POLL_TIMEOUT_MS = 5 * 60_000;
export const PUBLISH_POLL_INTERVAL_MS = 5_000;
/** How often to re-send a refused toggle while a settle budget is open. */
export const PUBLISH_SETTLE_INTERVAL_MS = 60_000;
/**
 * A refusal faster than this ran no job at all — the accepted toggle takes
 * ~132 s on `cloud-erp` — so it is safe to send again: nothing was executed.
 */
const FAST_REFUSAL_MS = 5_000;

/**
 * Toggle a service binding's published state. adt-ls sends one action with no
 * direction parameter, so this asks the binding first — `getServiceBindingDetails`
 * returns `allowedAction` (PUBLISH or UNPUBLISH), the backend's own statement of
 * which way the toggle will go — requires `confirm`, sends the action, then polls
 * `fetch_services` and fails if the state never flipped. The write allowlist
 * applies to the binding's package (`assertObjectWritable`, ADR-003).
 *
 * The details call is not a fix for `cloud-erp`'s un-publish refusal — see the note below
 * — but it is the call the VS Code extension makes first, and it carries the two
 * guards that extension has (an inactive binding, a binding with no services)
 * plus the exact `odataversion` string the action needs.
 *
 * The SDK's `publishServiceBinding` sends the request the VS Code extension builds
 * from the details (adt-ls#14). On V2 it toggles the service definition passed as
 * `service`; adt+ passes the first one, the same one its guards looked at.
 */
export async function publishService(
  adt: AdtLsClient,
  destination: Destination,
  input: PublishServiceInput,
): Promise<PublishServiceResult> {
  assertConfirmed(`object ${input.target === 'PUBLISH' ? 'publish' : 'unpublish'}`, input.confirm);
  assertPublishServiceAllowed(destination);

  const { uri } = await resolveObject(adt, input.ref);
  await assertObjectWritable(destination, { ...input.ref, uri });
  const details = (await adt.services.serviceBindingDetails(input.ref)) as ServiceBindingDetails;
  const objectData = details.objectData ?? details.srvbObjectData ?? {};

  if (objectData.version === 1) {
    throw new Error(
      `${input.ref.name} is inactive; activate the service binding before publishing its local service endpoint`,
    );
  }
  const serviceName = details.services?.[0];
  if (!serviceName) {
    throw new Error(`${input.ref.name} exposes no services, so there is nothing to publish`);
  }
  if (!details.odataversion) {
    throw new Error(`Could not read the OData version of ${input.ref.name}; adt-ls needs it to publish`);
  }
  // `allowedAction` is the backend's own statement of the direction, but only
  // newer releases send it: S/4HANA 2023 (`onprem`) omits it and reports `published`
  // alone, so fall back to that.
  // On OData V2 it is no statement at all: `cloud-erp` reads PUBLISH both before and after
  // a publish while `published` flips, so V2 takes the direction from `published` alone.
  const declared = details.odataversion === 'V2' ? undefined : objectData.allowedAction;
  const allowed: 'PUBLISH' | 'UNPUBLISH' | undefined =
    declared === 'PUBLISH' || declared === 'UNPUBLISH'
      ? declared
      : objectData.published === undefined
        ? undefined
        : objectData.published
          ? 'UNPUBLISH'
          : 'PUBLISH';
  if (!allowed) {
    throw new Error(
      `${input.ref.name} reports neither a published state nor an allowedAction; refusing to toggle blind`,
    );
  }
  if (declared && declared !== allowed) {
    throw new Error(
      `${input.ref.name} reports allowedAction=${declared}, which is not a toggle direction; refusing`,
    );
  }
  // SAP's one action toggles: sending it in the other direction would undo what the caller asked for.
  if (allowed !== input.target) {
    throw new Error(`${input.ref.name} is already ${input.target === 'PUBLISH' ? 'published' : 'unpublished'}; nothing sent`);
  }
  const wasPublished = objectData.published ?? allowed === 'UNPUBLISH';
  const expected = allowed === 'PUBLISH';

  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const action = await sendToggle({
    send: async () => (await adt.services.publishServiceBinding(input.ref, { service: serviceName })) as ToggleAction,
    name: input.ref.name,
    allowed,
    destination,
    settleTimeoutMs: input.settleTimeoutMs ?? 0,
    settleIntervalMs: input.settleIntervalMs ?? PUBLISH_SETTLE_INTERVAL_MS,
    sleep,
    expected,
    readState: async () => (await readPublishState(adt, input.ref)).isPublished,
  });

  const timeoutMs = input.pollTimeoutMs ?? PUBLISH_POLL_TIMEOUT_MS;
  const intervalMs = input.pollIntervalMs ?? PUBLISH_POLL_INTERVAL_MS;
  const started = Date.now();
  let last: boolean | undefined;
  let via: PublishServiceResult['verifiedVia'] = 'fetch_services';
  let lastError: string | undefined;
  for (;;) {
    try {
      ({ isPublished: last, via } = await readPublishState(adt, input.ref));
      lastError = undefined;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (last === expected) {
      return {
        wasPublished,
        isPublished: last,
        action: allowed,
        statusMessage: action.statusMessage,
        verifiedVia: via,
        waitedMs: Date.now() - started,
      };
    }
    if (Date.now() - started >= timeoutMs) break;
    await sleep(intervalMs);
  }
  throw new Error(
    `${input.ref.name} still reads isPublished=${String(last)} ${Math.round(timeoutMs / 1000)} s after ` +
      `adt-ls reported ${allowed} success (${action.statusMessage ?? 'no message'}); the toggle is not confirmed.` +
      (lastError ? ` Last read error: ${lastError}` : ''),
  );
}

interface ToggleOptions {
  /** Sends the identical toggle request on every attempt. */
  send: () => Promise<ToggleAction>;
  name: string;
  allowed: 'PUBLISH' | 'UNPUBLISH';
  destination: Destination;
  settleTimeoutMs: number;
  settleIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  /** The state this toggle is heading for, and how to read the current one. */
  expected: boolean;
  readState: () => Promise<boolean | undefined>;
}

interface ToggleAction {
  isExecuted?: boolean;
  isPublishSuccess?: boolean;
  statusMessage?: string;
}

/**
 * Send the toggle, and re-send it while a settle budget is open and the backend
 * keeps refusing it instantly.
 *
 * **The cloud un-publish refusal (measured on `cloud-erp`, 2026-09-20).** For a while after
 * a publish job, the backend refuses the un-publish in ~0.1 s with "Local un-publish
 * of X failed" — and then accepts the byte-identical request and runs the real
 * ~132 s job. The refusal is the backend's, not a request adt+ gets wrong: the
 * decompiled jars show the V4 path reads only `lsUri` + `odataVersion` and POSTs one
 * `{type: SCGR, name: <binding>}` to `businessservices/odatav4/unpublishjobs`, which
 * is exactly what ADT for VS Code's command sends. A stale chain, the missing
 * `getServiceBindingDetails`, the server-driven editor path, session freshness and
 * an async job hidden behind a too-early read-back were each tested and refused, and
 * `allowedAction` read UNPUBLISH one second after the publish, so it is no readiness
 * flag. What *has* been observed to work is the same request minutes later:
 * accepted at +10, +21 (twice) and +62 min after a publish — once from the very
 * session that had published, which rules session identity out — while other cycles
 * were still refused at +16. How long the refusal lasts is not fixed, so adt+
 * reports it rather than promising a wait.
 *
 * Retrying is safe precisely because the refusal is instant: a call that ran the
 * job takes minutes, so a fast refusal executed nothing and cannot have toggled
 * anything. A slow failure is never retried.
 */
async function sendToggle(opts: ToggleOptions): Promise<ToggleAction> {
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const sentAt = Date.now();
    const action = await opts.send();
    if (action.isExecuted && action.isPublishSuccess) return action;

    const refusedFast = Date.now() - sentAt < FAST_REFUSAL_MS;
    const budgetLeft = Date.now() - started + opts.settleIntervalMs <= opts.settleTimeoutMs;
    if (refusedFast && budgetLeft) {
      await opts.sleep(opts.settleIntervalMs);
      // Someone else may have toggled it while we waited; re-sending then would
      // toggle it back, since the action carries no direction.
      const state = await opts.readState().catch(() => undefined);
      if (state === opts.expected) {
        return {
          isExecuted: true,
          isPublishSuccess: true,
          statusMessage: `${opts.name} already reads isPublished=${state}; another session ran the ${opts.allowed}`,
        };
      }
      continue;
    }
    const verb = opts.allowed === 'UNPUBLISH' ? 'Un-publish' : 'Publish';
    const tried =
      attempts > 1 ? ` after ${attempts} attempts over ${Math.round((Date.now() - started) / 1000)} s` : '';
    const hint =
      refusedFast && opts.allowed === 'UNPUBLISH' && opts.destination.kind === 'cloud'
        ? ' The backend refused it instantly, which is what a recent publish looks like on this system: the ' +
          'identical request keeps being refused for a while afterwards and then goes through. Nothing was ' +
          'executed. Retry in a few minutes, or pass a settle budget (CLI --settle-timeout).'
        : '';
    throw new Error(
      `${verb} of ${opts.name} failed${tried}: ${action.statusMessage ?? JSON.stringify(action)}.${hint}`,
    );
  }
}

/**
 * The published state as the *other* channel sees it: `fetch_services` is an
 * adt-ls MCP tool, not the LSP srvb segment the toggle and `allowedAction` come
 * from, so the read-back confirms the flip independently. `isPublished` sits at
 * its top level, not on `services[0]` (M6.0).
 *
 * `fetch_services` sends no `isPublished` for an OData V2 binding (`cloud-erp`) nor on
 * S/4HANA 2023 (`onprem`); there the details' `objectData.published` is read instead,
 * which follows the real state on V2.
 */
async function readPublishState(
  adt: AdtLsClient,
  ref: ObjectRef,
): Promise<{ isPublished: boolean | undefined; via: PublishServiceResult['verifiedVia'] }> {
  const r = (await adt.services.listServices(ref)) as {
    isPublished?: boolean;
    services?: Array<{ isPublished?: boolean }>;
  };
  const listed = r.isPublished ?? r.services?.[0]?.isPublished;
  if (listed !== undefined) return { isPublished: listed, via: 'fetch_services' };
  const details = (await adt.services.serviceBindingDetails(ref)) as ServiceBindingDetails;
  return {
    isPublished: (details.objectData ?? details.srvbObjectData)?.published,
    via: 'serviceBindingDetails',
  };
}
