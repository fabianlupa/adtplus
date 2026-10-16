import { type IRegistry, LanguageVersion, MemoryFile, Registry, Severity } from '@abaplint/core';
import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import { federatedResult } from '../core/federated.js';
import type { Destination } from '../core/destinations.js';
import { resolveObject } from '../core/resolve.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { isEndMethodLineComment } from '../core/class-regions.js';
import { abaplintVersion, isDroppedFinding, isErrorKey, stageOneConfig, type RuleSwitches } from '../mirror/lint.js';
import { isServiceBinding, syntaxNotes } from './navigate.js';
import { checksThroughCheckRun, type TextDiagnostic } from './checkrun.js';
import { lookupPackageChain } from '../core/placement.js';
import { assertObjectWritable, assertPackageWritable } from './policy.js';
import { inPool } from '../core/pool.js';

export async function listAtcVariants(adt: AdtLsClient, ref: ObjectRef): Promise<unknown> {
  return adt.quality.listAtcVariants(ref);
}

export interface RunAtcInput {
  ref: ObjectRef;
  checkVariant?: string;
  timeoutMs?: number;
}

/** adt+'s ATC timeout per object, over the SDK's 60 s: a default variant can take minutes on one object. */
export const ATC_DEFAULT_TIMEOUT_MS = 180_000;

export async function runAtc(adt: AdtLsClient, input: RunAtcInput): Promise<unknown> {
  return adt.quality.runAtc(input.ref, { checkVariant: input.checkVariant, timeoutMs: input.timeoutMs ?? ATC_DEFAULT_TIMEOUT_MS });
}

export interface AtcWorklistFinding {
  priority: number;
  check: string;
  message: string;
  messageId: string;
  /** `applyQuickfixes` can fix it without AI. */
  quickfix: boolean;
}

export interface AtcWorklistObject {
  name: string;
  /** Main type only, as the worklist names it ("CLAS"). */
  type: string;
  package: string;
  findings: AtcWorklistFinding[];
}

export interface AtcWorklist {
  /** Pass to `applyQuickfixes`. */
  worklistId: string;
  objects: AtcWorklistObject[];
  /** Findings `applyQuickfixes` would fix. */
  quickfixes: number;
  notes: string[];
}

interface RawWorklist {
  objects?: Array<{
    name?: string;
    type?: string;
    packageName?: string;
    findings?: Array<{
      priority?: number;
      checkTitle?: string;
      messageTitle?: string;
      messageId?: string;
      deterministicQuickfixAvailable?: boolean;
    }>;
  }>;
}

/**
 * The worklist, or undefined while the run goes on (an object without `objects`). A text is
 * the backend's last word on the run ("ATC run was cancelled. …") and throws.
 */
async function readWorklist(adt: AdtLsClient, worklistId: string): Promise<RawWorklist | undefined> {
  const data = federatedResult(
    await adt.raw.tool('abap_atc_get_result', { destination: adt.health().destination, worklistId }),
    'ATC result',
  ) as RawWorklist | string | null;
  if (typeof data === 'string') throw new Error(`ATC result for worklist ${worklistId}: ${data}`);
  return data && Array.isArray(data.objects) ? data : undefined;
}

function worklistOf(worklistId: string, raw: RawWorklist): AtcWorklist {
  const objects = (raw.objects ?? []).map((o) => ({
    name: o.name ?? '',
    type: o.type ?? '',
    package: o.packageName ?? '',
    findings: (o.findings ?? []).map((f) => ({
      priority: f.priority ?? 3,
      check: f.checkTitle ?? '',
      message: f.messageTitle ?? '',
      messageId: f.messageId ?? '',
      quickfix: f.deterministicQuickfixAvailable === true,
    })),
  }));
  const quickfixes = objects.reduce((n, o) => n + o.findings.filter((f) => f.quickfix).length, 0);
  return {
    worklistId,
    objects,
    quickfixes,
    notes: [
      'Worklist findings carry no line numbers; atc without quickfixes gives them.',
      ...(quickfixes > 0 ? [`${quickfixes} finding(s) have a quick fix: adtplus_object_write applyQuickfixes with this worklistId applies them all.`] : []),
    ],
  };
}

const WORKLIST_POLL_MS = 2_000;

/**
 * ATC through SAP's worklist (the federated `abap_atc_run`): unlike `runAtc`'s check run, its
 * findings say whether a deterministic quick fix exists, and the worklist is what
 * `applyQuickfixes` fixes. Read-only.
 */
export async function runAtcWorklist(
  adt: AdtLsClient,
  input: { refs: ObjectRef[]; checkVariant?: string; /** Per object, as `runAtc`'s. */ timeoutMs?: number },
): Promise<AtcWorklist> {
  assertBatchSize(input.refs);
  const run = federatedResult(
    await adt.raw.tool('abap_atc_run', {
      destination: adt.health().destination,
      objects: input.refs.map((r) => ({ name: r.name.toUpperCase(), type: r.objectType.toUpperCase() })),
      ...(input.checkVariant ? { checkVariant: input.checkVariant } : {}),
    }),
    'ATC run',
  ) as { worklistId?: string };
  const worklistId = run?.worklistId;
  if (!worklistId) throw new Error('ATC run: the backend returned no worklist');
  // One run for all objects: its deadline grows with them, as runAtc's per-object timeout does.
  const deadline = Date.now() + (input.timeoutMs ?? ATC_DEFAULT_TIMEOUT_MS) * input.refs.length;
  for (;;) {
    const raw = await readWorklist(adt, worklistId);
    if (raw) return worklistOf(worklistId, raw);
    if (Date.now() > deadline) throw new Error(`ATC run ${worklistId} did not finish in time; a faster variant (atcVariants) may help`);
    await new Promise((resolve) => setTimeout(resolve, WORKLIST_POLL_MS));
  }
}

export interface ApplyQuickfixesInput {
  worklistId: string;
  transport?: string;
}

export interface ApplyQuickfixesResult {
  /** The objects the fixes changed, now inactive. */
  changed: ObjectRef[];
  messages: string[];
  notes: string[];
}

/**
 * A class include stands for its class: the class name padded with "=" to 30 characters, then
 * the include's suffix ("ZCL_X=====…CS", "…CCIMP"); a 30-character name has no padding.
 */
export function mainObjectName(name: string, objectType: string): string {
  if (objectType.split('/')[0]!.toUpperCase() !== 'CLAS' || name.length <= 30) return name;
  return name.slice(0, 30).replace(/=+$/, '');
}

/** Worklists `applyQuickfixes` sent, per system: the worklist still lists its fixes afterwards. */
const appliedWorklists = new Set<string>();

/**
 * Apply every deterministic quick fix of an ATC worklist (`runAtc` with `quickfixes`).
 * A write to every object in the worklist: each must pass the allowlist (ADR-003) and
 * `refuse` (ADR-009's mirror gate), or nothing is applied; `hold` keeps other commands off
 * them while the fixes run. The changed objects are left inactive. A worklist is applied
 * once: its findings still offer the fixes afterwards, and a second run would apply them to
 * the changed source.
 */
export async function applyQuickfixes(
  adt: AdtLsClient,
  destination: Destination,
  input: ApplyQuickfixesInput,
  refuse: (ref: ObjectRef) => Promise<string | undefined>,
  hold: <T>(refs: ObjectRef[], fn: () => Promise<T>) => Promise<T> = (_refs, fn) => fn(),
): Promise<ApplyQuickfixesResult> {
  const appliedKey = `${destination.id}:${input.worklistId}`;
  if (appliedWorklists.has(appliedKey)) {
    throw new Error(`ATC worklist ${input.worklistId} was applied already; run adtplus_quality atc with quickfixes again for a fresh one`);
  }
  const raw = await readWorklist(adt, input.worklistId);
  if (!raw) throw new Error(`ATC worklist ${input.worklistId} is not finished or unknown; run adtplus_quality atc with quickfixes first`);
  const worklist = worklistOf(input.worklistId, raw);
  if (worklist.quickfixes === 0) throw new Error(`ATC worklist ${input.worklistId} has no finding with a quick fix; nothing applied`);
  const lookupChain = lookupPackageChain(adt);
  for (const o of worklist.objects) {
    if (!o.package) throw new Error(`cannot tell which package ${o.type} ${o.name} is in, so the quick fixes are refused`);
  }
  for (const pkg of new Set(worklist.objects.map((o) => o.package.toUpperCase()))) {
    await assertPackageWritable(destination, pkg, { lookupChain });
  }
  const refs = worklist.objects.map((o) => ({ name: o.name, objectType: o.type }));
  for (const ref of refs) {
    const refusal = await refuse(ref);
    if (refusal) throw new Error(refusal);
  }
  return hold(refs, () => sendQuickfixes(adt, input, appliedKey));
}

async function sendQuickfixes(adt: AdtLsClient, input: ApplyQuickfixesInput, appliedKey: string): Promise<ApplyQuickfixesResult> {
  // Marked before the call: a call that fails half way may have changed objects too.
  appliedWorklists.add(appliedKey);
  const unsure = 'The fixes may have changed objects anyway: list them with adtplus_object listInactive and activate them.';
  const data = federatedResult(
    await adt.raw.tool('abap_atc_execute_deterministic_quickfixes', {
      destination: adt.health().destination,
      worklistId: input.worklistId,
      useComments: false,
      useAuthor: false,
      activateAfterFix: false,
      ...(input.transport ? { transportId: input.transport } : {}),
    }),
    'apply quick fixes',
  ) as { messages?: string[]; affectedObjects?: Array<{ name?: string; type?: string }> } | string | null;
  if (!data || typeof data !== 'object') return { changed: [], messages: data ? [String(data)] : [], notes: [unsure] };
  const seen = new Set<string>();
  const changed = (data.affectedObjects ?? [])
    .map((o) => ({ name: mainObjectName(o.name ?? '', o.type ?? ''), objectType: o.type ?? '' }))
    .filter((o) => !seen.has(`${o.objectType} ${o.name}`) && seen.add(`${o.objectType} ${o.name}`));
  return {
    changed,
    messages: data.messages ?? [],
    notes: [changed.length > 0 ? 'The changed objects are inactive: activate them (adtplus_object_write activate with refs).' : unsure],
  };
}

export interface RunUnitTestsInput {
  ref: ObjectRef;
  coverage?: boolean;
}

/** Unit tests execute code, so like `run` they are limited to the write allowlist (docs/decisions/003-write-gates.md). */
export async function runUnitTests(adt: AdtLsClient, destination: Destination, input: RunUnitTestsInput): Promise<unknown> {
  const resolved = await resolveObject(adt, input.ref);
  await assertObjectWritable(destination, resolved);
  if (input.coverage) return adt.quality.runUnitTestsWithCoverage(resolved);
  return adt.lifecycle.runUnitTests(resolved);
}

export interface AbaplintFinding {
  message: string;
  key: string;
  severity: Severity;
  filename: string;
  row: number;
  col: number;
}

export interface AbaplintResult {
  filename: string;
  languageVersion: LanguageVersion;
  findings: AbaplintFinding[];
}

/**
 * adt+'s local abaplint pass over one object's main source, since the
 * system has no channel for this (neither adt-ls nor REST; ADR-012).
 *
 * The MemoryFile filename is the resolved AFF URI's own basename (e.g.
 * `zcl_adtplus_demo.clas.abap`, confirmed live), so adt+ never guesses a
 * type→extension mapping — abaplint infers the object type from the same
 * filename adt-ls already gave it.
 */
export async function runAbaplint(
  adt: AdtLsClient,
  destination: Destination,
  ref: ObjectRef,
  rules?: RuleSwitches,
): Promise<AbaplintResult> {
  const { uri } = await resolveObject(adt, ref);
  const filename = decodeURIComponent(uri.split('/').pop() ?? ref.name);
  const source = await adt.source.read(ref);

  const languageVersion = abaplintVersion(destination.languageVersion);
  // `mirror check`'s rules and per-type drops, so the two agree on what an error is.
  const config = stageOneConfig(languageVersion, rules);
  const registry = new Registry(config).addFile(new MemoryFile(filename, source));
  await registry.parseAsync();

  const findings = kept(registry).map((issue) => ({
    message: issue.getMessage(),
    key: issue.getKey(),
    severity: isErrorKey(issue.getKey()) ? Severity.Error : Severity.Warning,
    filename: issue.getFilename(),
    row: issue.getStart().getRow(),
    col: issue.getStart().getCol(),
  }));

  return { filename, languageVersion, findings };
}

/** The registry's findings without the ones `mirror check` drops (for the file's type, a comment on an ENDMETHOD line). */
function kept(registry: IRegistry) {
  return registry
    .findIssues()
    .filter((issue) => !isDroppedFinding(issue.getKey(), issue.getFilename()) && !isEndMethodLineComment(registry, issue));
}

// --- batches ---------------------------------------------------------------
//
// ATC, syntax and abaplint over several objects in one call (backlog "Batch quality checks").
// adt-ls has no multi-object ATC run with lines, so
// ATC and syntax run per object, `concurrency` at a time; abaplint lints all sources in one
// registry, so references between the objects resolve.

/** Objects one batch call takes, as `activate`. */
export const MAX_BATCH_OBJECTS = 50;
/** Findings a batch result lists, errors first; the counts cover all. */
export const MAX_BATCH_FINDINGS = 100;

export type BatchSeverity = 'error' | 'warning' | 'info';

export interface BatchFinding {
  /** `CLAS ZCL_X`: the object checked. */
  object: string;
  severity: BatchSeverity;
  /** ATC check title, abaplint rule, or SAP's message code for syntax. */
  check: string;
  message: string;
  /** ATC/syntax: the file's repotree URI; it can be another object's (an ATC finding in SAP code). */
  uri?: string;
  /** abaplint: the file name. */
  file?: string;
  /** 1-based. */
  line?: number;
}

export interface BatchResult {
  objects: number;
  /** Objects whose check ran; the others are in `failed`. */
  checked: number;
  counts: Record<BatchSeverity, number>;
  /** Findings per check (ATC check title, abaplint rule, syntax message code), most first. */
  byCheck: Record<string, number>;
  /** At most MAX_BATCH_FINDINGS, errors first. */
  findings: BatchFinding[];
  /** Findings left out of `findings`. */
  omitted: number;
  failed: Array<{ object: string; message: string }>;
  /** What the findings can't say themselves (syntax only, `syntaxNotes`). */
  notes?: string[];
}

const objectId = (ref: ObjectRef): string => `${ref.objectType.split('/')[0]} ${ref.name.toUpperCase()}`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const RANK: Record<BatchSeverity, number> = { error: 0, warning: 1, info: 2 };

export function assertBatchSize(refs: ObjectRef[]): void {
  if (refs.length === 0) throw new Error('no objects to check');
  if (refs.length > MAX_BATCH_OBJECTS) {
    throw new Error(`${refs.length} objects; one call checks at most ${MAX_BATCH_OBJECTS}. Split them into several calls.`);
  }
}

function summarize(objects: number, findings: BatchFinding[], failed: BatchResult['failed']): BatchResult {
  const counts: Record<BatchSeverity, number> = { error: 0, warning: 0, info: 0 };
  const perCheck = new Map<string, number>();
  for (const f of findings) {
    counts[f.severity]++;
    perCheck.set(f.check, (perCheck.get(f.check) ?? 0) + 1);
  }
  const sorted = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return {
    objects,
    checked: objects - failed.length,
    counts,
    byCheck: Object.fromEntries([...perCheck].sort((a, b) => b[1] - a[1])),
    findings: sorted.slice(0, MAX_BATCH_FINDINGS),
    omitted: Math.max(0, sorted.length - MAX_BATCH_FINDINGS),
    failed,
  };
}

/** Per object: its findings, or the reason its check didn't run. */
async function perObject(
  refs: ObjectRef[],
  concurrency: number,
  check: (ref: ObjectRef) => Promise<BatchFinding[]>,
): Promise<BatchResult> {
  const failed: BatchResult['failed'] = [];
  const findings = (
    await inPool(refs, concurrency, async (ref) => {
      try {
        return await check(ref);
      } catch (err) {
        // A cooldown fails the whole call, so the client sees `throttled` and its wait.
        if (err instanceof ThrottledError) throw err;
        failed.push({ object: objectId(ref), message: errorText(err) });
        return [];
      }
    })
  ).flat();
  return summarize(refs.length, findings, failed);
}

interface AtcRunFinding {
  lineNumber?: number;
  priority?: number;
  location?: string;
  message?: string;
  checkTitle?: string;
}

const ATC_SEVERITY: Record<number, BatchSeverity> = { 1: 'error', 2: 'warning' };

export interface RunAtcBatchInput {
  refs: ObjectRef[];
  checkVariant?: string;
  /** Per object. */
  timeoutMs?: number;
  concurrency: number;
}

export async function runAtcBatch(adt: AdtLsClient, input: RunAtcBatchInput): Promise<BatchResult> {
  assertBatchSize(input.refs);
  return perObject(input.refs, input.concurrency, async (ref) => {
    const res = (await adt.quality.runAtc(ref, {
      checkVariant: input.checkVariant,
      timeoutMs: input.timeoutMs ?? ATC_DEFAULT_TIMEOUT_MS,
    })) as {
      atcRunCheckResults?: AtcRunFinding[];
    };
    return (res?.atcRunCheckResults ?? []).map((f) => ({
      object: objectId(ref),
      severity: ATC_SEVERITY[f.priority ?? 3] ?? 'info',
      check: f.checkTitle ?? '',
      message: f.message ?? '',
      uri: f.location,
      line: f.lineNumber,
    }));
  });
}

interface LspDiagnostic {
  range?: { start?: { line?: number } };
  severity?: number;
  code?: string | number;
  message?: string;
}

const LSP_SEVERITY: Record<number, BatchSeverity> = { 1: 'error', 2: 'warning' };

/**
 * Syntax check of each object's stored source, as `navigate syntax`. `checkRun` checks the types
 * adt-ls can't (`checksThroughCheckRun`).
 */
export async function checkSyntaxBatch(
  adt: AdtLsClient,
  refs: ObjectRef[],
  concurrency: number,
  checkRun: (ref: ObjectRef) => Promise<TextDiagnostic[]>,
): Promise<BatchResult> {
  assertBatchSize(refs);
  const messages: string[] = [];
  // Not sent and not counted as `checked`; the note names them.
  const sources = refs.filter((ref) => !isServiceBinding(ref));
  const checked = await perObject(sources, concurrency, async (ref) => {
    // Resolved once here so the check reuses the URI and the findings can name the file.
    const uri = await adt.lifecycle.resolveAffUri(ref);
    const report: { items?: LspDiagnostic[] } =
      checksThroughCheckRun(ref)
        ? { items: await checkRun(ref) }
        : ((await adt.navigation.checkSyntax({ ...ref, uri })) as { items?: LspDiagnostic[] });
    return (report?.items ?? []).map((d) => {
      messages.push(d.message ?? '');
      return {
        object: objectId(ref),
        severity: LSP_SEVERITY[d.severity ?? 3] ?? 'info',
        check: d.code === undefined ? '' : String(d.code),
        message: d.message ?? '',
        uri,
        line: (d.range?.start?.line ?? 0) + 1,
      };
    });
  });
  const result = { ...checked, objects: refs.length };
  // Every finding counts, also those beyond MAX_BATCH_FINDINGS.
  const notes = syntaxNotes(refs, messages);
  return notes.length > 0 ? { ...result, notes } : result;
}


/**
 * abaplint over the objects' main sources in one registry, with `runAbaplint`'s
 * rules: with `check_syntax` switched on, a call from one object to another in
 * the batch is checked (a reference outside it is void).
 */
export async function runAbaplintBatch(
  adt: AdtLsClient,
  destination: Destination,
  refs: ObjectRef[],
  concurrency: number,
  rules?: RuleSwitches,
): Promise<BatchResult & { languageVersion: LanguageVersion }> {
  assertBatchSize(refs);
  const failed: BatchResult['failed'] = [];
  const read = await inPool(refs, concurrency, async (ref) => {
    try {
      const uri = await adt.lifecycle.resolveAffUri(ref);
      const filename = decodeURIComponent(uri.split('/').pop() ?? ref.name);
      return { ref, filename, source: await adt.source.read({ ...ref, uri }) };
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      failed.push({ object: objectId(ref), message: errorText(err) });
      return undefined;
    }
  });

  const languageVersion = abaplintVersion(destination.languageVersion);
  const registry = new Registry(stageOneConfig(languageVersion, rules));
  const owner = new Map<string, string>();
  for (const r of read) {
    if (!r) continue;
    owner.set(r.filename, objectId(r.ref));
    registry.addFile(new MemoryFile(r.filename, r.source));
  }
  await registry.parseAsync();

  const findings = kept(registry).map((issue) => ({
    object: owner.get(issue.getFilename()) ?? issue.getFilename(),
    severity: (isErrorKey(issue.getKey()) ? 'error' : 'warning') as BatchSeverity,
    check: issue.getKey(),
    message: issue.getMessage(),
    file: issue.getFilename(),
    line: issue.getStart().getRow(),
  }));
  return { ...summarize(refs.length, findings, failed), languageVersion };
}
