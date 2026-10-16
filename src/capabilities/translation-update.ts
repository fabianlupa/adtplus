/**
 * Changing translation projects (`TRPR`, docs/decisions/019-translations-through-odata-ui-service.md
 * §4, §5): `create`, `update` and `deleteObject`. An update changes the description, adds text
 * sources and language pairs, and writes texts (`properties.translations`). Everything is checked
 * before the first write: the switch (the daemon), the allowlist for the project's package and every
 * translated object's, the new sources and languages against SAP's lists, the language pairs, and
 * each text against the pair's `ALL` download (SAP would silently ignore an unknown unit and cut a
 * target longer than `maxwidth`). Then one `$batch` changeset for the definition, one of uploads,
 * one of publishes, and a verifying read.
 */

import type { ObjectRef } from '@arc-mcp/adt-ls';
import { callFunction, changeset, type ChangesetOperation, type OperationResult, type ServiceCheck } from '../backends/odata-ui.js';
import { RawAdtError, RawAdtTimeoutError, type RawAdtClient } from '../backends/rawadt.js';
import type { Destination } from '../core/destinations.js';
import { languageTag, sapLanguage } from '../core/languages.js';
import type { PackageChainLookup } from '../core/placement.js';
import { assertPackageWritable } from './policy.js';
import {
  buildXliff,
  checked,
  download,
  entriesOf,
  mainType,
  PROJECT_TYPE,
  readProject,
  results,
  sourceObject,
  textSourceOf,
  TRANSLATION_STATUSES,
  type LanguagePair,
  type Project,
  type TranslationEntry,
  type TranslationStatus,
  type XliffFile,
  type XliffUnit,
} from './translations.js';

/** Texts one update writes at most: one read page's worth. */
export const MAX_WRITES = 500;
/** SAP's limits: the project's ID (`Project.ID`) and `Description`. */
export const MAX_NAME = 30;
export const MAX_DESCRIPTION = 60;

export interface TranslationWrite {
  /** Target language, BCP 47. */
  language: string;
  objectType: string;
  name: string;
  key: string;
  target: string;
  /** Needed only when the project has two pairs into `language`. */
  sourceLanguage?: string;
  // Read-only: accepted when equal to the current value, refused otherwise (ADR-019 §4).
  project?: string;
  source?: string;
  maxwidth?: number;
  note?: string;
  status?: TranslationStatus;
}

export interface ProjectUpdate {
  translations?: TranslationWrite[];
  /** A new description changes it. */
  header?: { description?: string };
  /** Read-only. */
  package?: string;
  /** Sources the project lacks are added; ones it has are accepted with their keys unchanged. Leaving one out never removes it. */
  textSources?: Array<Record<string, unknown>>;
  /** Pairs the project lacks are added (only `source` and `target`); ones it has as `textSources`. */
  languages?: Array<Record<string, unknown>>;
}

const WRITE_KEYS = ['language', 'objectType', 'name', 'key', 'target', 'sourceLanguage', 'project', 'source', 'maxwidth', 'note', 'status'];
const PROPERTY_KEYS = ['header', 'package', 'textSources', 'languages', 'translations'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const refusal = (findings: string[], action: 'update' | 'create' = 'update') => new Error(`the ${action} was refused, nothing was sent:\n- ${findings.join('\n- ')}`);

/** A language the caller gave, as SAP's code; a finding when it isn't one. */
function languageOf(value: string, at: string, findings: string[]): string | undefined {
  try {
    return sapLanguage(value);
  } catch (err) {
    findings.push(`${at}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** The `properties` of an update (or a create), checked before any call: every finding at once. */
export function parseProjectUpdate(properties: unknown, action: 'update' | 'create' = 'update'): ProjectUpdate {
  if (!isObject(properties)) throw new Error('"properties" of a translation project must be an object');
  const findings: string[] = [];
  for (const k of Object.keys(properties)) {
    if (!PROPERTY_KEYS.includes(k)) findings.push(`unknown key "${k}" (a translation project takes ${PROPERTY_KEYS.join(', ')})`);
  }
  const update: ProjectUpdate = {};
  if (properties.header !== undefined) {
    if (!isObject(properties.header) || Object.keys(properties.header).some((k) => k !== 'description')) findings.push('"header" takes only "description"');
    else update.header = properties.header as ProjectUpdate['header'];
  }
  if (properties.package !== undefined) {
    if (typeof properties.package !== 'string') findings.push('"package" must be a string');
    else update.package = properties.package;
  }
  for (const k of ['textSources', 'languages'] as const) {
    if (properties[k] === undefined) continue;
    if (!Array.isArray(properties[k]) || !(properties[k] as unknown[]).every(isObject)) findings.push(`"${k}" must be a list of objects`);
    else update[k] = properties[k] as Array<Record<string, unknown>>;
  }
  if (properties.translations !== undefined) {
    const list = properties.translations;
    if (!Array.isArray(list) || list.length === 0) findings.push('"translations" must be a non-empty list');
    else if (list.length > MAX_WRITES) findings.push(`"translations" has ${list.length} texts; one update writes at most ${MAX_WRITES}`);
    else {
      update.translations = [];
      list.forEach((t: unknown, i) => {
        const at = `translations[${i}]`;
        if (!isObject(t)) {
          findings.push(`${at} must be an object`);
          return;
        }
        for (const k of Object.keys(t)) if (!WRITE_KEYS.includes(k)) findings.push(`${at}: unknown key "${k}"`);
        for (const k of ['language', 'objectType', 'name', 'key', 'target']) {
          if (typeof t[k] !== 'string') findings.push(`${at}: "${k}" is required, a string`);
        }
        for (const k of ['sourceLanguage', 'project', 'source', 'note']) {
          if (t[k] !== undefined && typeof t[k] !== 'string') findings.push(`${at}: "${k}" must be a string`);
        }
        if (t.maxwidth !== undefined && typeof t.maxwidth !== 'number') findings.push(`${at}: "maxwidth" must be a number`);
        if (t.status !== undefined && !(TRANSLATION_STATUSES as readonly unknown[]).includes(t.status)) {
          findings.push(`${at}: "status" is one of ${TRANSLATION_STATUSES.join(', ')}`);
        }
        for (const k of ['language', 'sourceLanguage']) if (typeof t[k] === 'string') languageOf(t[k], `${at}: "${k}"`, findings);
        if (typeof t.target === 'string' && t.target.trim() === '') {
          findings.push(`${at}: an empty "target" publishes an empty text and doesn't remove the translation; adt+ refuses it`);
        }
        update.translations!.push(t as unknown as TranslationWrite);
      });
    }
  }
  if (action === 'update' && findings.length === 0 && !update.translations && !update.header && !update.textSources && !update.languages) {
    findings.push('nothing to change: give "translations", "header.description", "textSources" or "languages"');
  }
  if (findings.length > 0) throw refusal(findings, action);
  return update;
}

export interface UpdateDeps {
  rest: RawAdtClient;
  destination: Destination;
  lookupChain: PackageChainLookup;
  /** The write rule for a translated object (a confirmed resolve, then its package); throws when it isn't allowed. */
  assertObjectWritable: (ref: ObjectRef) => Promise<void>;
  /**
   * Language pairs adt+ itself left uploaded and not published (an upload or publish that failed),
   * by `<project> <source> <target>`: the upload's time. SAP names the
   * uploader by display name only, so adt+ tells its own upload from another's only by remembering
   * it. Any other `PREPARED` pair is refused (ADR-019 §5).
   */
  ownUploads: Map<string, OwnUpload>;
  onServiceCheck?: (check: ServiceCheck) => void;
}

export interface OwnUpload {
  at: string;
}

export interface WrittenText {
  sourceLanguage: string;
  language: string;
  objectType: string;
  name: string;
  key: string;
  /** The translation before; absent when there was none. A changed one is set back by another update. */
  previous?: string;
  target: string;
}

export interface DefinitionChange {
  description?: { previous: string; description: string };
  textSources?: Array<{ type: string; name: string; objectType?: string }>;
  languages?: Array<{ source: string; target: string }>;
}

export interface ProjectUpdateResult {
  name: string;
  objectType: string;
  /** What the update changed in the definition. */
  changed?: DefinitionChange;
  written: WrittenText[];
  /** Sent targets that the verifying read doesn't show as sent, or why it couldn't read. */
  notVerified?: string[];
  /** Texts of the touched objects still missing or outdated in the written pairs. */
  remaining?: TranslationEntry[];
  warnings?: string[];
  via: 'odata-ui';
}

/** One text's identity in a pair: main type, name and key. */
const textKey = (objectType: string, name: string, key: string) => `${mainType(objectType)}\0${name.toUpperCase()}\0${key}`;
const pairKey = (project: string, p: LanguagePair) => `${project} ${p.source} ${p.target}`;
const pairName = (p: { source: string; target: string }) => `${languageTag(p.source)}→${languageTag(p.target)}`;

/** A text source as the read shows it: the service's type and name, and adt+'s type where it maps. */
const describeSource = (s: { type: string; name: string }) => {
  const object = sourceObject(s.type, s.name);
  return { type: s.type, name: s.name, ...(object ? { objectType: object.objectType } : {}) };
};

/** SAP's text source for a `textSources` entry: the service's `type` and `name`, or adt+'s `objectType` and `name`. */
function sourceOfEntry(s: Record<string, unknown>): { type: string; name: string } | undefined {
  if (typeof s.name !== 'string' || s.name === '') return undefined;
  if (typeof s.type === 'string' && s.type !== '') return { type: s.type.toUpperCase(), name: s.name.toUpperCase() };
  return typeof s.objectType === 'string' ? textSourceOf({ name: s.name, objectType: s.objectType }) : undefined;
}

export interface DefinitionPlan {
  description?: string;
  newSources: Array<{ type: string; name: string }>;
  /** SAP's codes. */
  newPairs: Array<{ source: string; target: string }>;
  findings: string[];
}

/**
 * What an update changes in the definition: a new description, and the text sources and language
 * pairs the project lacks. The rest of a round-tripped read is accepted when unchanged, refused when
 * it differs (ADR-019 §4); leaving a source or pair out never removes it.
 */
export function planDefinition(project: Pick<Project, 'description' | 'package' | 'textSources' | 'languages'>, update: ProjectUpdate): DefinitionPlan {
  const plan: DefinitionPlan = { newSources: [], newPairs: [], findings: [] };
  const findings = plan.findings;
  const description = update.header?.description;
  if (description !== undefined && description !== project.description) {
    if (description.trim() === '' || description.length > MAX_DESCRIPTION) findings.push(`header.description takes 1 to ${MAX_DESCRIPTION} characters`);
    else plan.description = description;
  }
  if (update.package !== undefined && update.package.toUpperCase() !== project.package) findings.push(`package is read-only, now ${JSON.stringify(project.package)}`);
  for (const s of update.textSources ?? []) {
    const source = sourceOfEntry(s);
    if (!source) {
      findings.push(`text source ${JSON.stringify(s)}: give "type" and "name" as a read shows them, or "objectType" and "name" of a type adt+ maps`);
      continue;
    }
    const unknown = Object.keys(s).filter((k) => !['type', 'name', 'objectType'].includes(k));
    if (unknown.length > 0) findings.push(`text source ${source.type} ${source.name}: unknown ${unknown.map((k) => `"${k}"`).join(', ')}`);
    const have = project.textSources.find((h) => h.type === source.type && h.name.toUpperCase() === source.name);
    if (!have) {
      const object = sourceObject(source.type, source.name);
      if (typeof s.objectType === 'string' && typeof s.type === 'string' && mainType(s.objectType) !== (object && mainType(object.objectType))) {
        findings.push(`text source ${source.type} ${source.name}: "objectType" ${s.objectType} isn't that type's`);
      } else if (!plan.newSources.some((n) => n.type === source.type && n.name === source.name)) plan.newSources.push(source);
      continue;
    }
    const object = sourceObject(have.type, have.name);
    if (s.objectType !== undefined && typeof s.type === 'string' && s.objectType !== object?.objectType) {
      findings.push(`text source ${have.type} ${have.name}: "objectType" is read-only, now ${JSON.stringify(object?.objectType)}`);
    }
  }
  for (const l of update.languages ?? []) {
    const source = typeof l.source === 'string' ? languageOf(l.source, 'languages: "source"', findings) : undefined;
    const target = typeof l.target === 'string' ? languageOf(l.target, 'languages: "target"', findings) : undefined;
    if (typeof l.source !== 'string' || typeof l.target !== 'string') {
      findings.push(`language pair ${JSON.stringify(l)}: "source" and "target" are required, as BCP 47 tags`);
      continue;
    }
    if (!source || !target) continue;
    const have = project.languages.find((p) => p.source === source && p.target === target);
    // `counts` is derived from the texts, not a field of the pair: not compared.
    const extra = Object.keys(l).filter((k) => k !== 'source' && k !== 'target' && k !== 'counts');
    if (!have) {
      if (extra.length > 0) findings.push(`new language pair ${l.source}→${l.target}: only "source" and "target", not ${extra.map((k) => `"${k}"`).join(', ')}`);
      else if (source === target) findings.push(`language pair ${l.source}→${l.target}: source and target are the same`);
      else if (!plan.newPairs.some((p) => p.source === source && p.target === target)) plan.newPairs.push({ source, target });
      continue;
    }
    const current: Record<string, unknown> = { publishStatus: have.publishStatus, lastUploaded: have.lastUploaded, lastPublished: have.lastPublished };
    for (const k of extra) {
      if (!(k in current)) findings.push(`language pair ${pairName(have)}: unknown key "${k}"`);
      else if (JSON.stringify(l[k]) !== JSON.stringify(current[k])) findings.push(`language pair ${pairName(have)}: "${k}" is read-only, now ${JSON.stringify(current[k])}`);
    }
  }
  return plan;
}

const changesDefinition = (plan: DefinitionPlan) => plan.description !== undefined || plan.newSources.length > 0 || plan.newPairs.length > 0;

/** New languages SAP doesn't have installed (`getInstalledLanguages`). */
async function checkLanguages(rest: RawAdtClient, system: string, pairs: DefinitionPlan['newPairs']): Promise<string[]> {
  if (pairs.length === 0) return [];
  const { d } = await callFunction(rest, 'getInstalledLanguages', {});
  const installed = new Set(results(d).map((l) => String(l.keyValue)));
  return [...new Set(pairs.flatMap((p) => [p.source, p.target]))].filter((code) => !installed.has(code)).map((code) => `language ${languageTag(code)} is not installed on ${system}`);
}

/** New text sources SAP wouldn't take (`getAddableTextSources`, which needs the project). */
async function checkSources(rest: RawAdtClient, name: string, sources: DefinitionPlan['newSources']): Promise<string[]> {
  if (sources.length === 0) return [];
  const { d } = await callFunction(rest, 'getAddableTextSources', { ID: name, Type: PROJECT_TYPE });
  const addable = new Set(results(d).map((s) => `${String(s.type)} ${String(s.name).toUpperCase()}`));
  return sources
    .filter((s) => !addable.has(`${s.type} ${s.name}`))
    .map((s) => `text source ${s.type} ${s.name} can't be added: SAP doesn't offer it (it must exist, have that type, and belong to the project's software component)`);
}

/** Both list checks; a failed read of a list is a finding, so the other findings aren't lost. */
async function sapListFindings(rest: RawAdtClient, system: string, name: string, plan: Pick<DefinitionPlan, 'newPairs' | 'newSources'>): Promise<string[]> {
  const asFinding = (what: string) => (err: unknown) => [`SAP's list of ${what} couldn't be read: ${message(err)}`];
  const [languages, sources] = await Promise.all([
    checkLanguages(rest, system, plan.newPairs).catch(asFinding('installed languages')),
    checkSources(rest, name, plan.newSources).catch(asFinding('text sources it would add')),
  ]);
  return [...languages, ...sources];
}

/** The definition changeset: description, new sources, new pairs; independent calls, all or nothing. */
function definitionOps(name: string, plan: DefinitionPlan, transport: Record<string, string>): ChangesetOperation[] {
  const key = { ID: name, Type: PROJECT_TYPE };
  return [
    ...(plan.description !== undefined ? [{ name: 'updateProject', params: { ...key, Description: plan.description, ...transport } }] : []),
    ...(plan.newSources.length > 0 ? [{ name: 'addTextSources', params: { ...key, textSources: JSON.stringify(plan.newSources), ...transport } }] : []),
    ...plan.newPairs.map((p) => ({ name: 'createTranslation', params: { ...key, sourceLanguage: p.source, targetLanguage: p.target, ...transport } })),
  ];
}

const changeOf = (previous: string, plan: DefinitionPlan): DefinitionChange => ({
  ...(plan.description !== undefined ? { description: { previous, description: plan.description } } : {}),
  ...(plan.newSources.length > 0 ? { textSources: plan.newSources.map(describeSource) } : {}),
  ...(plan.newPairs.length > 0 ? { languages: plan.newPairs.map((p) => ({ source: languageTag(p.source), target: languageTag(p.target) })) } : {}),
});

/** What a read of the project doesn't show of `plan` (after the definition changeset). */
function definitionMissing(project: Project | undefined, plan: DefinitionPlan): string[] {
  if (!project) return ['the project reads as gone'];
  return [
    ...(plan.description !== undefined && project.description !== plan.description ? [`description reads ${JSON.stringify(project.description)}`] : []),
    ...plan.newSources.filter((s) => !project.textSources.some((h) => h.type === s.type && h.name.toUpperCase() === s.name)).map((s) => `text source ${s.type} ${s.name} isn't there`),
    ...plan.newPairs.filter((p) => !project.languages.some((h) => h.source === p.source && h.target === p.target)).map((p) => `language pair ${pairName(p)} isn't there`),
  ];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * SAP asks for a request once the project's is released (`SMTR/022` without one, `SMTR/023` for a
 * released one): the caller passes an open one, which then holds the project (ADR-019 §5).
 */
const requestHint = (err: unknown) =>
  /SMTR\/02[23]|\btransport\b/i.test(message(err)) ? "SAP wants an open request for this project (its own was released): pass \"transport\". " : '';

/**
 * Known to have written nothing: SAP answered the changeset with a failure, or the call ended before
 * the changeset was sent (a CSRF fetch that timed out). A lost connection or a timed-out changeset
 * says nothing.
 */
const sapAnswered = (err: unknown) =>
  err instanceof RawAdtError || (err instanceof Error && err.name === 'ThrottledError') || (err instanceof RawAdtTimeoutError && !err.mayHaveWritten);

/** `err` with `prefix` in front, keeping a `RawAdtError` (status, auth failure) for the session manager. */
function prefixed(err: unknown, prefix: string): Error {
  if (err instanceof RawAdtError) {
    err.message = `${prefix}${err.message}`;
    return err;
  }
  return new Error(`${prefix}${message(err)}`);
}

/** ABAP counts a text's length in UTF-16 code units, as JavaScript does. */
const abapLength = (text: string) => text.length;

type Upload = { key: string; pair: LanguagePair; languages: XliffFile['languages']; units: Array<XliffUnit & { target: string }> };

/**
 * One pair's texts against its `ALL` (and `DELTA` where a status is sent along): a known unit,
 * within `maxwidth`, given once, read-only keys unchanged, a data element's texts together.
 */
function checkTexts(
  name: string,
  pair: LanguagePair,
  pairWrites: TranslationWrite[],
  all: XliffFile,
  delta: XliffFile | undefined,
): { findings: string[]; sending: Upload['units']; written: WrittenText[] } {
  const findings: string[] = [];
  const sending: Upload['units'] = [];
  const written: WrittenText[] = [];
  if (all.problems.length > 0) {
    findings.push(...all.problems.map((p) => `${pairName(pair)}: SAP's file isn't what adt+ reads (${p}), so nothing is written`));
    return { findings, sending, written };
  }
  let statusOf: Map<string, TranslationStatus> | undefined;
  if (delta) {
    const ids = new Set(delta.units.filter((u) => u.target !== undefined).map((u) => u.id));
    statusOf = new Map(entriesOf(name, pair, all.units, ids).map((e) => [textKey(e.objectType, e.name, e.key), e.status]));
  }
  const units = new Map(all.units.map((u) => [textKey(u.objectType, u.name, u.key), u]));
  const seen = new Set<string>();
  for (const w of pairWrites) {
    const id = textKey(w.objectType, w.name, w.key);
    const where = `${pairName(pair)} ${w.objectType} ${w.name.toUpperCase()} ${w.key}`;
    if (seen.has(id)) {
      findings.push(`${where}: given twice`);
      continue;
    }
    seen.add(id);
    const unit = units.get(id);
    if (!unit) {
      findings.push(`${where}: no such text in project ${name} (SAP would ignore it). Read the project with "translationStatus" for the keys`);
      continue;
    }
    const length = abapLength(w.target);
    if (unit.maxwidth !== undefined && length > unit.maxwidth) {
      findings.push(`${where}: the target has ${length} characters, SAP takes at most ${unit.maxwidth} (it would cut it)`);
    }
    const current: Record<string, unknown> = { project: name, source: unit.source, maxwidth: unit.maxwidth, note: unit.note, status: statusOf?.get(id) };
    for (const k of ['project', 'source', 'maxwidth', 'note', 'status'] as const) {
      if (w[k] !== undefined && w[k] !== current[k]) findings.push(`${where}: "${k}" is read-only, now ${JSON.stringify(current[k])}, sent ${JSON.stringify(w[k])}`);
    }
    sending.push({ ...unit, target: w.target });
    written.push({
      sourceLanguage: languageTag(pair.source),
      language: languageTag(pair.target),
      objectType: unit.objectType,
      name: unit.name,
      key: unit.key,
      ...(unit.target !== undefined ? { previous: unit.target } : {}),
      target: w.target,
    });
  }
  // A data element's texts are one record per language: publishing some of them publishes the
  // others empty when the language had none, and marks them outdated otherwise (`cloud-erp`). So all
  // or none; a text without a source (an unset label) has nothing to translate.
  for (const element of new Set(sending.filter((u) => mainType(u.objectType) === 'DTEL').map((u) => u.name))) {
    const left = all.units.filter((u) => mainType(u.objectType) === 'DTEL' && u.name === element && u.source !== '' && !sending.some((x) => x.id === u.id));
    if (left.length > 0) {
      findings.push(
        `${pairName(pair)} DTEL/DE ${element}: a data element's texts are written together, as SAP keeps them in one record per language; ` +
          `send ${left.map((u) => u.key).join(', ')} too (unchanged ones with their current target). Sent alone, SAP publishes the others empty or marks them outdated`,
      );
    }
  }
  return { findings, sending, written };
}

export async function updateProject(
  deps: UpdateDeps,
  input: { name: string; objectType: string; update: ProjectUpdate; transport?: string },
): Promise<ProjectUpdateResult> {
  const { rest, destination } = deps;
  const name = input.name.toUpperCase();
  const writes = input.update.translations ?? [];
  await checked(rest, destination.id, deps.onServiceCheck);
  const project = await readProject(rest, name);
  if (!project) throw new Error(`translation project ${name} does not exist on ${destination.id}`);

  // The definition, the allowlist and the pairs: their findings in one refusal.
  const plan = planDefinition(project, input.update);
  const findings = [...plan.findings];
  if (writes.length === 0 && !changesDefinition(plan) && findings.length === 0) {
    throw new Error('nothing to change: the update names no new description, text source, language pair or translation');
  }

  // Allowlist (ADR-003): the project's package, and every translated object's, whose LANG entries are written. Fails closed.
  try {
    await assertPackageWritable(destination, project.package, { lookupChain: deps.lookupChain });
  } catch (err) {
    findings.push(message(err));
  }
  const objects = new Map<string, ObjectRef>();
  for (const w of writes) {
    // A type adt+ maps to a text source of its own; a package isn't a text's object.
    if (!textSourceOf(w) || mainType(w.objectType) === 'DEVC') {
      findings.push(`${w.objectType} ${w.name}: adt+ can't tell the package of this type, so it can't check the write allowlist`);
      continue;
    }
    objects.set(`${mainType(w.objectType)} ${w.name.toUpperCase()}`, { name: w.name.toUpperCase(), objectType: w.objectType });
  }
  await Promise.all(
    [...objects.values()].map((ref) => deps.assertObjectWritable(ref).catch((err: unknown) => findings.push(`${ref.objectType} ${ref.name}: ${message(err)}`))),
  );
  // The new languages and sources against SAP's lists, unless the update is refused already.
  if (findings.length === 0) findings.push(...(await sapListFindings(rest, destination.id, name, plan)));

  // Language pairs: the project's, or one this update adds (ADR-019 §5.3), whose texts are
  // checked once the definition changeset has made it.
  const byPair = new Map<string, { pair: LanguagePair; writes: TranslationWrite[] }>();
  const byNewPair = new Map<string, { pair: LanguagePair; writes: TranslationWrite[] }>();
  const newPairs: LanguagePair[] = plan.newPairs.map((p) => ({ ...p, publishStatus: 'INITIAL' }));
  for (const w of writes) {
    const target = sapLanguage(w.language);
    const source = w.sourceLanguage !== undefined ? sapLanguage(w.sourceLanguage) : undefined;
    const matches = (p: LanguagePair) => p.target === target && (!source || p.source === source);
    const pairs = [...project.languages.filter(matches), ...newPairs.filter(matches)];
    if (pairs.length === 0) {
      findings.push(`${w.language}: project ${name} has no language pair into it${source ? ` from ${w.sourceLanguage}` : ''}; add it through "languages"`);
      continue;
    }
    if (pairs.length > 1) {
      findings.push(`${w.language}: project ${name} has ${pairs.length} pairs into it (${pairs.map(pairName).join(', ')}); give "sourceLanguage"`);
      continue;
    }
    const key = pairKey(name, pairs[0]!);
    const into = project.languages.includes(pairs[0]!) ? byPair : byNewPair;
    into.set(key, { pair: pairs[0]!, writes: [...(into.get(key)?.writes ?? []), w] });
  }
  // A PREPARED pair is someone's upload unless this daemon left it, at that very time. Fails closed.
  // adt+'s own is replaced: a new upload replaces the pair's pending one, unpublished texts included.
  for (const [key, { pair }] of byPair) {
    if (pair.publishStatus !== 'PREPARED') continue;
    const own = deps.ownUploads.get(key);
    if (own && pair.lastUploaded && own.at === pair.lastUploaded.at) continue;
    findings.push(
      `${pairName(pair)}: an upload by ${pair.lastUploaded?.by || 'someone'} at ${pair.lastUploaded?.at ?? 'an unknown time'} is not published yet; ` +
        `publishing would publish it too. Publish or replace it in the Maintain Translations app first`,
    );
  }
  if (findings.length > 0) throw refusal(findings);

  // Texts, checked against ALL (and DELTA where a status is sent along), every pair at once.
  const files = await Promise.all(
    [...byPair.entries()].map(async ([key, { pair, writes: pairWrites }]) => {
      const [all, delta] = await Promise.all([
        download(rest, name, pair, 'ALL'),
        pairWrites.some((w) => w.status !== undefined) ? download(rest, name, pair, 'DELTA') : undefined,
      ]);
      return { key, pair, pairWrites, all, delta };
    }),
  );
  const uploads: Upload[] = [];
  const written: WrittenText[] = [];
  const warnings: string[] = [];
  for (const { key, pair, pairWrites, all, delta } of files) {
    const checkedTexts = checkTexts(name, pair, pairWrites, all, delta);
    findings.push(...checkedTexts.findings);
    written.push(...checkedTexts.written);
    uploads.push({ key, pair, languages: all.languages, units: checkedTexts.sending });
  }
  if (findings.length > 0) throw refusal(findings);

  // Writes: the definition, then all uploads, then all publishes, a changeset each (a changeset's
  // operations don't see each other's writes).
  const transport: Record<string, string> = input.transport ? { transport: input.transport.toUpperCase() } : {};
  let changed: DefinitionChange | undefined;
  if (changesDefinition(plan)) {
    let done: OperationResult[];
    try {
      done = await changeset(rest, definitionOps(name, plan, transport), `change translation project ${name}`);
    } catch (err) {
      if (sapAnswered(err)) throw prefixed(err, `${requestHint(err)}nothing was written: `);
      throw prefixed(err, `whether the change of project ${name}'s definition reached SAP is unknown; no text was written. Read the project before trying again: `);
    }
    warnings.push(...done.flatMap((r) => r.warnings));
    const errors = done.flatMap((r) => r.errors);
    if (errors.length > 0) throw new Error(`project ${name}'s definition was changed, but SAP reported: ${errors.join('; ')}; no text was written`);
    changed = changeOf(project.description, plan);
    if (byNewPair.size > 0) {
      // The pairs exist now: their texts against their ALL, as for the others (ADR-019 §5.3).
      const done = `project ${name}'s definition was changed (${JSON.stringify(changed)}), but no text was written`;
      const later: string[] = [];
      try {
        for (const [key, { pair, writes: pairWrites }] of byNewPair) {
          const [all, delta] = await Promise.all([
            download(rest, name, pair, 'ALL'),
            pairWrites.some((w) => w.status !== undefined) ? download(rest, name, pair, 'DELTA') : undefined,
          ]);
          const checkedTexts = checkTexts(name, pair, pairWrites, all, delta);
          later.push(...checkedTexts.findings);
          written.push(...checkedTexts.written);
          uploads.push({ key, pair, languages: all.languages, units: checkedTexts.sending });
        }
      } catch (err) {
        throw prefixed(err, `${done}: the new pair's texts couldn't be read: `);
      }
      if (later.length > 0) throw new Error(`${done}; the new pairs' texts were refused:\n- ${later.join('\n- ')}`);
    }
    if (uploads.length === 0) {
      const missing = await readProject(rest, name).then((p) => definitionMissing(p, plan), (err: unknown) => [`the read to verify it failed: ${message(err)}`]);
      return {
        name,
        objectType: input.objectType,
        changed,
        written,
        ...(missing.length > 0 ? { notVerified: missing } : {}),
        ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
        via: 'odata-ui',
      };
    }
  }
  const nothingYet = changed ? `project ${name}'s definition was changed, but no text was written` : 'nothing was written';
  const pairParams = (p: LanguagePair) => ({ ProjectID: name, ProjectType: PROJECT_TYPE, SourceLanguage: p.source, TargetLanguage: p.target });
  const remember = () => rememberUploads(deps, name, uploads);
  let uploaded: OperationResult[];
  try {
    uploaded = await changeset(
      rest,
      uploads.map((u) => ({
        name: 'uploadTranslationFile',
        params: { ...pairParams(u.pair), fileType: 'XLIFF', fileContent: buildXliff(name, u.languages, u.units), ...transport },
      })),
      `upload translations into ${name}`,
    );
  } catch (err) {
    if (sapAnswered(err)) throw prefixed(err, `${requestHint(err)}${nothingYet}: `);
    await remember();
    throw prefixed(err, `the upload into ${name} may or may not have reached SAP; no text was published. Read the project before trying again: `);
  }
  warnings.push(...uploaded.flatMap((r) => r.warnings));
  const uploadErrors = uploaded.flatMap((r) => r.errors);
  if (uploadErrors.length > 0) {
    await remember();
    throw new Error(`uploaded into ${name} but not published, no text changed (a later update with the same texts replaces the upload): ${uploadErrors.join('; ')}`);
  }
  try {
    const published = await changeset(
      rest,
      uploads.map((u) => ({ name: 'publishTranslation', params: { ...pairParams(u.pair), ...transport } })),
      `publish translations of ${name}`,
    );
    warnings.push(...published.flatMap((r) => r.warnings));
    warnings.push(...published.flatMap((r) => r.errors).map((e) => `published, but SAP reported: ${e}`));
  } catch (err) {
    await remember();
    if (sapAnswered(err)) {
      throw prefixed(err, `${requestHint(err)}uploaded into ${name} but not published, no text changed (a later update with the same texts replaces the upload): `);
    }
    throw prefixed(err, `uploaded into ${name}; whether the publish reached SAP is unknown. Read the texts before trying again (previous targets: ${JSON.stringify(written.map((w) => [w.key, w.previous ?? null]))}): `);
  }
  for (const u of uploads) deps.ownUploads.delete(u.key);

  // Verify: every sent target in ALL as sent; what's still missing or outdated in the touched objects.
  // The texts are published by now: a read that fails is reported, not thrown, so `written` and its `previous` stay.
  const notVerified: string[] = [];
  const remaining: TranslationEntry[] = [];
  await Promise.all(
    uploads.map(async (u) => {
      try {
        const [all, delta] = await Promise.all([download(rest, name, u.pair, 'ALL'), download(rest, name, u.pair, 'DELTA')]);
        const touched = new Set(u.units.map((x) => `${mainType(x.objectType)}\0${x.name}`));
        const ids = new Set(delta.units.filter((x) => x.target !== undefined).map((x) => x.id));
        const entries = entriesOf(name, u.pair, all.units.filter((x) => touched.has(`${mainType(x.objectType)}\0${x.name}`)), ids);
        const now = new Map(entries.map((e) => [textKey(e.objectType, e.name, e.key), e]));
        for (const x of u.units) {
          const e = now.get(textKey(x.objectType, x.name, x.key));
          if (e?.target !== x.target) notVerified.push(`${languageTag(u.pair.target)} ${x.objectType} ${x.name} ${x.key}: reads ${JSON.stringify(e?.target ?? null)}`);
        }
        remaining.push(...entries.filter((e) => e.status === 'missing' || e.status === 'outdated'));
      } catch (err) {
        notVerified.push(`${pairName(u.pair)}: published, but the read to verify it failed: ${message(err)}`);
      }
    }),
  );
  return {
    name,
    objectType: input.objectType,
    ...(changed ? { changed } : {}),
    written,
    ...(notVerified.length > 0 ? { notVerified } : {}),
    ...(remaining.length > 0 ? { remaining } : {}),
    ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    via: 'odata-ui',
  };
}

/** After a failed publish or an unknown upload: the pairs this update left `PREPARED`, so the next update may replace them. */
async function rememberUploads(deps: UpdateDeps, name: string, uploads: Array<{ key: string }>): Promise<void> {
  const project = await readProject(deps.rest, name).catch(() => undefined);
  for (const p of project?.languages ?? []) {
    const upload = uploads.find((u) => u.key === pairKey(name, p));
    if (upload && p.publishStatus === 'PREPARED' && p.lastUploaded) deps.ownUploads.set(upload.key, { at: p.lastUploaded.at });
  }
}

// --- create, delete (ADR-019 §4) -------------------------------------------------

export interface CreateDeps {
  rest: RawAdtClient;
  destination: Destination;
  lookupChain: PackageChainLookup;
  /** Whether the package records changes; undefined when it doesn't exist. */
  recordsChanges: (pkg: string) => Promise<boolean | undefined>;
  onServiceCheck?: (check: ServiceCheck) => void;
}

export interface ProjectCreateResult {
  name: string;
  objectType: string;
  package: string;
  description: string;
  textSources: Array<{ type: string; name: string; objectType?: string }>;
  languages: Array<{ source: string; target: string }>;
  transport?: string;
  /** What the read after the create doesn't show. */
  notVerified?: string[];
  warnings?: string[];
  via: 'odata-ui';
}

/**
 * A developer translation project in `package`. `createProject` is its own call, since the next
 * ones need the project; then the text sources, checked against SAP's list (which needs the
 * project), and the language pairs in one changeset. If that fails, the project stays, empty, and
 * the error names it.
 */
export interface CreateInput {
  name: string;
  objectType: string;
  package: string;
  description: string;
  transport?: string;
  properties?: ProjectUpdate;
}

/** The create's local checks, before any session (the daemon runs them first): its plan, or one refusal. */
export function planCreate(input: CreateInput): DefinitionPlan {
  const name = input.name.toUpperCase();
  const findings: string[] = [];
  if (!new RegExp(`^[A-Z0-9_/]{1,${MAX_NAME}}$`).test(name)) findings.push(`"${name}" is not a project name SAP takes (at most ${MAX_NAME} characters: letters, digits, _ and /)`);
  if (input.description.trim() === '' || input.description.length > MAX_DESCRIPTION) findings.push(`"description" takes 1 to ${MAX_DESCRIPTION} characters`);
  const properties = input.properties ?? {};
  if (properties.translations) findings.push('"translations" can\'t come with the create: the project has no texts yet. Write them in an update');
  if (properties.header?.description !== undefined && properties.header.description !== input.description) {
    findings.push('"header.description" differs from "description"; give the description once');
  }
  const plan = planDefinition({ description: input.description, package: input.package.toUpperCase(), textSources: [], languages: [] }, properties);
  findings.push(...plan.findings);
  if (findings.length > 0) throw refusal(findings, 'create');
  return { ...plan, description: undefined };
}

export async function createProject(deps: CreateDeps, input: CreateInput): Promise<ProjectCreateResult> {
  const { rest, destination } = deps;
  const name = input.name.toUpperCase();
  const pkg = input.package.toUpperCase();
  const plan = planCreate(input);

  await assertPackageWritable(destination, pkg, { lookupChain: deps.lookupChain });
  const records = await deps.recordsChanges(pkg);
  if (records === undefined) throw new Error(`package ${pkg} does not exist on ${destination.id}`);
  if (records && !input.transport) throw new Error(`package ${pkg} records changes: the project needs a request, pass "transport" (adt+ picks none)`);
  await checked(rest, destination.id, deps.onServiceCheck);
  if (await readProject(rest, name)) throw new Error(`translation project ${name} already exists on ${destination.id}`);
  // Languages before anything is written; text sources can only be checked once the project exists.
  const languageFindings = await sapListFindings(rest, destination.id, name, { newPairs: plan.newPairs, newSources: [] });
  if (languageFindings.length > 0) throw refusal(languageFindings, 'create');

  const transport: Record<string, string> = input.transport ? { transport: input.transport.toUpperCase() } : {};
  const warnings: string[] = [];
  const key = { ID: name, Type: PROJECT_TYPE };
  let created: OperationResult[];
  try {
    created = await changeset(rest, [{ name: 'createProject', params: { ...key, Name: name, Description: input.description, PackageName: pkg, ...transport } }], `create translation project ${name}`);
  } catch (err) {
    if (sapAnswered(err)) throw prefixed(err, `${requestHint(err)}nothing was created: `);
    throw prefixed(err, `whether translation project ${name} was created is unknown; read it before trying again: `);
  }
  warnings.push(...created.flatMap((r) => r.warnings));
  const createErrors = created.flatMap((r) => r.errors);
  const left = `translation project ${name} was created in ${pkg}, without text sources or language pairs`;
  if (createErrors.length > 0) throw new Error(`${left}, but SAP reported: ${createErrors.join('; ')}`);
  if (changesDefinition(plan)) {
    const sourceFindings = await sapListFindings(rest, destination.id, name, { newPairs: [], newSources: plan.newSources });
    if (sourceFindings.length > 0) throw new Error(`${left}; delete it or add them in an update:\n- ${sourceFindings.join('\n- ')}`);
    let filled: OperationResult[];
    try {
      // The project's request records them: no `transport` (lookup probe, P5); another request is refused (SMTR/230).
      filled = await changeset(rest, definitionOps(name, plan, {}), `fill translation project ${name}`);
    } catch (err) {
      throw prefixed(err, sapAnswered(err) ? `${requestHint(err)}${left}: ` : `translation project ${name} was created in ${pkg}; whether its text sources and language pairs were added is unknown, read it: `);
    }
    warnings.push(...filled.flatMap((r) => r.warnings));
    const fillErrors = filled.flatMap((r) => r.errors);
    if (fillErrors.length > 0) {
      throw new Error(`translation project ${name} was created in ${pkg}; adding its text sources and language pairs went through, but SAP reported: ${fillErrors.join('; ')}. Read it`);
    }
  }
  const project = await readProject(rest, name).catch(() => undefined);
  const notVerified = project ? definitionMissing(project, plan) : ['the read to verify it failed'];
  return {
    name,
    objectType: input.objectType,
    package: project?.package ?? pkg,
    description: project?.description ?? input.description,
    textSources: (project?.textSources ?? plan.newSources).map(describeSource),
    languages: (project?.languages ?? plan.newPairs).map((p) => ({ source: languageTag(p.source), target: languageTag(p.target) })),
    ...(input.transport ? { transport: input.transport.toUpperCase() } : {}),
    ...(notVerified.length > 0 ? { notVerified } : {}),
    ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    via: 'odata-ui',
  };
}

export interface ProjectDeleteResult {
  name: string;
  objectType: string;
  /** What went with it. */
  textSources: Array<{ type: string; name: string; objectType?: string }>;
  languages: Array<{ source: string; target: string }>;
  notes: string[];
  via: 'odata-ui';
}

/** The project with its language pairs and text sources, in one changeset (all or nothing). The translations it published stay. */
export async function deleteProject(
  deps: Pick<CreateDeps, 'rest' | 'destination' | 'lookupChain' | 'onServiceCheck'> & Pick<UpdateDeps, 'ownUploads'>,
  input: { name: string; objectType: string; transport?: string },
): Promise<ProjectDeleteResult> {
  const { rest, destination } = deps;
  const name = input.name.toUpperCase();
  await checked(rest, destination.id, deps.onServiceCheck);
  const project = await readProject(rest, name);
  if (!project) throw new Error(`translation project ${name} does not exist on ${destination.id}`);
  await assertPackageWritable(destination, project.package, { lookupChain: deps.lookupChain });
  // Someone's upload, not published, would go with its pair (adt+'s own leftover may go).
  const pending = project.languages.filter((p) => p.publishStatus === 'PREPARED' && !(p.lastUploaded && deps.ownUploads.get(pairKey(name, p))?.at === p.lastUploaded.at));
  if (pending.length > 0) {
    throw new Error(
      `the delete was refused, nothing was sent: ${pending
        .map((p) => `${pairName(p)} holds an upload by ${p.lastUploaded?.by || 'someone'} at ${p.lastUploaded?.at ?? 'an unknown time'}, not published`)
        .join('; ')}; it would be lost. Publish or delete it in the Maintain Translations app first`,
    );
  }
  const transport: Record<string, string> = input.transport ? { transport: input.transport.toUpperCase() } : {};
  const key = { ID: name, Type: PROJECT_TYPE };
  let done: OperationResult[];
  try {
    done = await changeset(
      rest,
      [
        ...project.languages.map((p) => ({ name: 'deleteTranslation', params: { ...key, sourceLanguage: p.source, targetLanguage: p.target, ...transport } })),
        ...project.textSources.map((s) => ({ name: 'deleteTextSource', params: { ...key, Name: s.name, text_source_type: s.type, ...transport } })),
        { name: 'deleteProject', params: { ...key, ...transport } },
      ],
      `delete translation project ${name}`,
    );
  } catch (err) {
    if (sapAnswered(err)) throw prefixed(err, `${requestHint(err)}nothing was deleted: `);
    throw prefixed(err, `whether translation project ${name} was deleted is unknown; read it before trying again: `);
  }
  for (const p of project.languages) deps.ownUploads.delete(pairKey(name, p));
  const reported = [...done.flatMap((r) => r.errors).map((e) => `SAP reported: ${e}`), ...done.flatMap((r) => r.warnings)];
  const after = await readProject(rest, name).then(
    (p) => (p ? `SAP answered the delete, but project ${name} still reads as there` : undefined),
    (err: unknown) => `the read to verify the delete failed: ${message(err)}`,
  );
  return {
    name,
    objectType: input.objectType,
    textSources: project.textSources.map(describeSource),
    languages: project.languages.map((p) => ({ source: languageTag(p.source), target: languageTag(p.target) })),
    notes: [
      'the translations it published stay in the objects',
      ...(after ? [after] : []),
      ...reported,
    ],
    via: 'odata-ui',
  };
}
