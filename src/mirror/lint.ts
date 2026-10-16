import { Config, LanguageVersion, MemoryFile, Registry, type Issue } from '@abaplint/core';
import { frameComments, isEndMethodLineComment, type FrameComment } from '../core/class-regions.js';

/**
 * abaplint stage 1 over a mirror's AFF files (docs/decisions/007-mirror-mode.md,
 * "Local checks"), also the rules `quality abaplint` runs. Only what SAP's
 * syntax check would refuse and what is likely a bug is on: the default's
 * style, naming and whitespace rules buried the errors (ADR-012), and the rules that need the system's objects
 * (`check_syntax`, `implement_methods`, `unknown_types`) can't work without
 * stubs (stage 2). A caller switches rules on or off with `rules`. abaplint
 * reads AFF only in part, so some findings are dropped per type.
 */

/** On, as errors: SAP's syntax check refuses these too, and abaplint finds them without the system's objects. */
const ERROR_RULES = [
  'parser_error',
  'cds_parser_error',
  'parser_missing_space',
  'parser_bad_exceptions',
  'begin_end_names',
  'method_implemented_twice',
  'mix_returning',
  'no_comments_between_methods',
];

/** On, as warnings: likely bugs. */
const BUG_RULES = [
  'unused_variables',
  'unused_types',
  'check_subrc',
  'no_inline_in_optional_branches',
  'unreachable_code',
  'identical_conditions',
  'identical_contents',
  'try_without_catch',
  'invalid_table_index',
];

/** A caller's rule switches, `{ "abapdoc": true, "check_subrc": false }`. */
export type RuleSwitches = Record<string, boolean>;

/** Findings dropped for one type's files: abaplint misreads them there. Keys may be parser keys (`structure`). */
const OFF_PER_TYPE: Array<{ keys: string[]; file: RegExp; why: string }> = [
  { keys: ['check_abstract'], file: /\.clas\./i, why: 'RAP behaviour pools must be ABSTRACT FINAL' },
  { keys: ['check_ddic', 'tabl_enhancement_category'], file: /\.tabl\./i, why: "abaplint can't parse .tabl.ddic" },
  { keys: ['main_file_contents'], file: /\.prog\./i, why: 'includes are taken for reports' },
  { keys: ['check_include'], file: /\.fugr\./i, why: "AFF's include file names aren't mapped" },
  { keys: ['parser_error', 'structure'], file: /\.fugr\..*\.func\.abap$/i, why: "AFF's function module files aren't parsed" },
  { keys: ['msag_consistency'], file: /\.msag\./i, why: "the name isn't read from .json" },
];

/** Errors: ERROR_RULES and the parser's own `structure`. Every other finding, a switched-on rule's too, is a warning. */
const ERROR_KEYS = new Set([...ERROR_RULES, 'structure']);

export const isErrorKey = (key: string): boolean => ERROR_KEYS.has(key);

export interface LintFinding {
  /** The file as passed in. */
  file: string;
  /** 1-based. */
  line: number;
  col: number;
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

/** An ABAP language version, AFF's name. */
export type AffLanguageVersion = 'standard' | 'keyUser' | 'cloudDevelopment';

export interface LintResult {
  findings: LintFinding[];
  /** Objects linted. */
  objects: number;
  /** Objects linted per language version. */
  languageVersions: Partial<Record<AffLanguageVersion, number>>;
  /** Objects of types abaplint doesn't know, per type: not linted. */
  unknownTypes: Record<string, number>;
}

/** The stage-1 configuration for a language version, with a caller's switches on top. */
export function stageOneConfig(languageVersion: LanguageVersion, rules: RuleSwitches = {}): Config {
  const raw = Config.getDefault(undefined, languageVersion).get();
  const unknown = Object.keys(rules).filter((key) => !(key in raw.rules));
  if (unknown.length > 0) throw new Error(`unknown abaplint rule${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  // Never matches: every reference to an object outside the mirror is void, not an error.
  raw.syntax.errorNamespace = '^(?!)';
  const on = new Set([...ERROR_RULES, ...BUG_RULES]);
  for (const key of Object.keys(raw.rules)) {
    const wanted = rules[key] ?? on.has(key);
    // A switched-on rule keeps the default's settings for it.
    if (!wanted) raw.rules[key] = false;
  }
  return new Config(JSON.stringify(raw));
}

function toFinding(issue: Issue): LintFinding {
  const key = issue.getKey();
  return {
    file: issue.getFilename(),
    line: issue.getStart().getRow(),
    col: issue.getStart().getCol(),
    rule: key,
    severity: isErrorKey(key) ? 'error' : 'warning',
    message: issue.getMessage(),
  };
}

/** A finding abaplint gets wrong for its file's type (`OFF_PER_TYPE`): dropped. */
export const isDroppedFinding = (rule: string, file: string): boolean => OFF_PER_TYPE.some((o) => o.keys.includes(rule) && o.file.test(file));

const offForType = (f: LintFinding) => isDroppedFinding(f.rule, f.file);

/**
 * The class frame comments abaplint's rule misses (ADR-012 stopgap, `core/class-regions.ts`), as
 * warnings: push refuses them unless the system's version has them there, which check can't see.
 */
function frameFindings(f: { path: string; text: string }): LintFinding[] {
  if (!/\.clas\.abap$/i.test(f.path)) return [];
  let comments: FrameComment[];
  try {
    comments = frameComments(f.text);
  } catch {
    return []; // abaplint failed on it: the run's own crash warning, or its parser error, says so
  }
  return comments
    .filter((c) => !c.byRule)
    .map((c) => ({
      file: f.path,
      line: c.row,
      col: 1,
      rule: 'class_frame_comment',
      severity: 'warning' as const,
      message: `Comment ${c.where}: SAP has no include for it; push refuses it unless the system's version has it there`,
    }));
}

const knownTypes = new Map<string, boolean>();

/** abaplint knows the type (a file `x.<type>.…`); asked once per type of an empty registry. */
function isKnownType(type: string): boolean {
  let known = knownTypes.get(type);
  if (known === undefined) {
    const probe = new Registry().addFile(new MemoryFile(`x.${type.toLowerCase()}.json`, '{}'));
    // abaplint doesn't export the class; a test pins the name.
    known = [...probe.getObjects()].every((obj) => obj.constructor.name !== 'UnknownObject');
    knownTypes.set(type, known);
  }
  return known;
}

/** The object a file belongs to: `zcl_x.clas` for `src/zcl_x.clas.locals_imp.abap`. */
export function objectStem(file: string): string {
  return (file.split('/').pop() ?? '').toLowerCase().split('.').slice(0, 2).join('.');
}

/**
 * An object's language version from its AFF `.json`: `header.abapLanguageVersion`. Undefined
 * without one (the caller's fallback, the system's: some types' headers never carry it) and for
 * text that isn't such a file.
 */
export function affLanguageVersion(text: string): AffLanguageVersion | undefined {
  let header: unknown;
  try {
    header = (JSON.parse(text) as { header?: unknown }).header;
  } catch {
    return undefined;
  }
  if (typeof header !== 'object' || header === null) return undefined;
  const version = (header as { abapLanguageVersion?: unknown }).abapLanguageVersion;
  return version === 'standard' || version === 'keyUser' || version === 'cloudDevelopment' ? version : undefined;
}

/**
 * Lint `files` (path + text; the path's base name is the AFF file name), each object at the
 * language version its `.json` names, `fallback` for one without. abaplint takes one version
 * per registry, so each version is a run of its own; a reference between them is void, like any
 * outside the files. A rule that throws on one object costs that object a warning, not the run.
 */
export async function lint(
  files: Array<{ path: string; text: string }>,
  fallback: AffLanguageVersion,
  rules?: RuleSwitches,
): Promise<LintResult> {
  const named = new Map<string, AffLanguageVersion>();
  for (const f of files) {
    const version = f.path.toLowerCase().endsWith('.json') ? affLanguageVersion(f.text) : undefined;
    if (version) named.set(objectStem(f.path), version);
  }
  const groups = new Map<AffLanguageVersion, Array<{ path: string; text: string }>>();
  for (const f of files) {
    const version = named.get(objectStem(f.path)) ?? fallback;
    const group = groups.get(version);
    if (group) group.push(f);
    else groups.set(version, [f]);
  }
  const result: LintResult = { findings: [], objects: 0, languageVersions: {}, unknownTypes: {} };
  for (const [version, group] of groups) {
    const one = await lintOneVersion(group, abaplintVersion(version), rules);
    result.findings.push(...one.findings);
    result.objects += one.objects;
    if (one.objects > 0) result.languageVersions[version] = one.objects;
    for (const [type, n] of Object.entries(one.unknownTypes)) result.unknownTypes[type] = (result.unknownTypes[type] ?? 0) + n;
  }
  return result;
}

async function lintOneVersion(
  files: Array<{ path: string; text: string }>,
  languageVersion: LanguageVersion,
  rules?: RuleSwitches,
): Promise<Omit<LintResult, 'languageVersions'>> {
  const registry = new Registry(stageOneConfig(languageVersion, rules));
  const unknownTypes: Record<string, number> = {};
  const unknownObjects = new Set<string>();
  for (const f of files) {
    const [name, type] = (f.path.split('/').pop() ?? '').toUpperCase().split('.');
    if (!type) continue;
    if (isKnownType(type)) {
      registry.addFile(new MemoryFile(f.path, f.text));
    } else if (!unknownObjects.has(`${type} ${name}`)) {
      unknownObjects.add(`${type} ${name}`);
      unknownTypes[type] = (unknownTypes[type] ?? 0) + 1;
    }
  }
  await registry.parseAsync();

  let issues: readonly Issue[];
  const crashes: LintFinding[] = [];
  try {
    issues = registry.findIssues();
  } catch {
    // Once more object by object, to keep what the others report.
    const each: Issue[] = [];
    issues = each;
    for (const obj of registry.getObjects()) {
      try {
        each.push(...registry.findIssuesObject(obj));
      } catch (err) {
        crashes.push({
          file: obj.getFiles()[0]?.getFilename() ?? obj.getName(),
          line: 1,
          col: 1,
          rule: 'abaplint_crash',
          severity: 'warning',
          message: `abaplint failed on ${obj.getType()} ${obj.getName()}, not linted: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
  return {
    findings: [
      ...issues.filter((i) => !isEndMethodLineComment(registry, i)).map(toFinding).filter((f) => !offForType(f)),
      ...files.flatMap(frameFindings),
      ...crashes,
    ],
    objects: registry.getObjectCount().normal,
    unknownTypes,
  };
}

/** abaplint's language version for an AFF one. */
export function abaplintVersion(languageVersion: AffLanguageVersion): LanguageVersion {
  if (languageVersion === 'cloudDevelopment') return LanguageVersion.Cloud;
  return languageVersion === 'keyUser' ? LanguageVersion.KeyUser : LanguageVersion.Normal;
}
