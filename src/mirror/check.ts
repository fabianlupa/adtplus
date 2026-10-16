import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkFormat } from './editorconfig.js';
import { adtLsChange, filesBelow } from './files.js';
import { REMOTE_SUFFIX, SRC_DIR, affClassFileFor, isReadOnlyFile, resolveRoot } from './layout.js';
import { abaplintVersion, lint, type RuleSwitches } from './lint.js';
import { loadManifest } from './manifest.js';
import { parseMsag } from './msag.js';
import { MAX_LISTED, listed, type Listed, type MirrorLocation } from './pull.js';
import { rapFindings, type RapFile } from './rap-rules.js';
import { validateAffJson } from './schema.js';

/**
 * `mirror check` (docs/decisions/007-mirror-mode.md, "Local checks"): abaplint
 * stage 1, AFF's schemas for `.json`, AFF's `.editorconfig` rules. Local files
 * only, no SAP call; results carry file:line and messages, never source.
 */

export interface CheckInput extends MirrorLocation {
  system: string;
  /** The system's `languageVersion` (systems.json); unset lints as standard ABAP. */
  languageVersion?: string;
  /** The adt-ls version adt+ runs now, to compare with the last pull's. */
  adtLsVersion?: string;
  /** abaplint rule switches on top of the default. */
  rules?: RuleSwitches;
}

export interface CheckFinding {
  /** Relative to the mirror root. */
  path: string;
  /** 1-based. */
  line: number;
  col?: number;
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface CheckResult {
  root: string;
  system: string;
  /** What abaplint ran with. */
  languageVersion: 'cloud' | 'standard';
  files: number;
  /** Objects abaplint linted. */
  objects: number;
  /** No error: every file parses and every `.json` fits its schema. Warnings don't count. */
  ok: boolean;
  errors: number;
  warnings: number;
  /** Findings per rule, errors and warnings. */
  byRule: Record<string, number>;
  /** Errors first, then by path and line; at most `MAX_LISTED`. */
  findings: CheckFinding[];
  notLinted: {
    /** `.jsonc` stubs and `.properties` texts. */
    readOnlyFiles: number;
    /** Objects of types abaplint doesn't know, per type. */
    unknownTypes: Record<string, number>;
    /** Symlinks under `src/`: never followed. */
    symlinks: number;
  };
  /** In the manifest, missing on disk (as `status` reports them): deletions a push never sends, not checked. */
  deleted: Listed;
  /** `.json` files of types without a vendored AFF schema, per type. */
  noSchema: Record<string, number>;
  notes: string[];
  /** The adt-ls version differs from the last pull's: a format change makes files look changed. */
  adtLsChanged?: { pulled: string; running: string };
  ms: number;
}

export async function check(input: CheckInput): Promise<CheckResult> {
  const started = Date.now();
  const root = await resolveRoot(input.root, input.workspaceFolders);
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error(`no mirror at ${root}; run \`mirror init\` first`);
  if (manifest.system !== input.system) {
    throw new Error(`${root} mirrors system "${manifest.system}", not "${input.system}"`);
  }

  const findings: CheckFinding[] = [];
  const noSchema: Record<string, number> = {};
  const toLint: Array<{ path: string; text: string }> = [];
  let readOnlyFiles = 0;
  const rapFiles: RapFile[] = [];
  let symlinks = 0;
  let files = 0;

  const listedFiles = await filesBelow(root, SRC_DIR);
  /** Files on disk as the check saw them: read, or a symlink. */
  const onDisk = new Set<string>();
  for (const rel of listedFiles) {
    if (rel.endsWith(REMOTE_SUFFIX)) continue;
    const bytes = await readListed(path.join(root, ...rel.split('/')));
    // Deleted since the listing (an `rm` running beside the check): not checked.
    if (bytes === undefined) continue;
    onDisk.add(rel);
    if (bytes === 'symlink') {
      symlinks += 1;
      continue;
    }
    files += 1;
    const name = rel.split('/').pop()!;
    for (const f of checkFormat(name, bytes)) findings.push({ path: rel, severity: 'warning', ...f });
    const aff = affClassFileFor(name);
    if (aff) {
      findings.push({ path: rel, line: 1, rule: 'aff_file_name', severity: 'error', message: `abapGit's name; AFF names this class include ${aff} (push won't send it)` });
    }
    if (isReadOnlyFile(name)) {
      readOnlyFiles += 1;
      continue;
    }
    const text = bytes.toString('utf8');
    toLint.push({ path: rel, text });
    rapFiles.push({ path: rel, text });
    if (name.toLowerCase().endsWith('.json')) {
      const result = validateAffJson(name, text);
      if (result.status === 'noSchema') noSchema[result.type] = (noSchema[result.type] ?? 0) + 1;
      else if (result.status === 'invalid') {
        for (const f of result.findings) {
          findings.push({ path: rel, line: f.line, rule: result.schema ? 'aff_schema' : 'json_syntax', severity: 'error', message: f.message });
        }
      } else if (name.toLowerCase().endsWith('.msag.json')) {
        // What the schema can't say and push refuses (ADR-014): a number twice, a line break.
        const problem = parseMsag(text);
        if (typeof problem === 'string') findings.push({ path: rel, line: 1, rule: 'msag_file', severity: 'error', message: `${problem} (push won't send it)` });
      }
    }
  }

  const linted = await lint(toLint, abaplintVersion(input.languageVersion), input.rules);
  for (const f of linted.findings) {
    findings.push({ path: f.file, line: f.line, col: f.col, rule: f.rule, severity: f.severity, message: f.message });
  }

  for (const f of rapFindings(rapFiles)) findings.push({ ...f, severity: 'error' });

  const notes: string[] = [];
  if (toLint.some((f) => /\.fugr\..*\.func\.abap$/i.test(f.path))) {
    notes.push("function modules (.func.abap) aren't syntax-checked locally: abaplint can't parse AFF's function module files");
  }
  if (toLint.some((f) => /\.tabl\.ddic$/i.test(f.path))) {
    notes.push("tables (.tabl.ddic) aren't linted by abaplint, which can't parse them: their .json is schema-checked, and RAP rules read amount/quantity references");
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const byRule: Record<string, number> = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  findings.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.line - b.line,
  );
  // What `status` calls deleted (scan.ts), from this check's own listing: a manifest file with a
  // base or a `.remote`, not on disk.
  const remotes = new Set(listedFiles.filter((rel) => rel.endsWith(REMOTE_SUFFIX)));
  const deleted: string[] = [];
  for (const object of Object.values(manifest.objects)) {
    for (const [name, entry] of Object.entries(object.files)) {
      const rel = `${object.dir}/${name}`;
      if (!onDisk.has(rel) && (entry.hash !== undefined || remotes.has(`${rel}${REMOTE_SUFFIX}`))) deleted.push(rel);
    }
  }
  const adtLsChanged = adtLsChange(manifest.adtLs, input.adtLsVersion);
  return {
    root,
    system: manifest.system,
    languageVersion: input.languageVersion === 'cloudDevelopment' ? 'cloud' : 'standard',
    files,
    objects: linted.objects,
    ok: errors === 0,
    errors,
    warnings: findings.length - errors,
    byRule: Object.fromEntries(Object.entries(byRule).sort(([, a], [, b]) => b - a)),
    findings: findings.slice(0, MAX_LISTED),
    notLinted: { readOnlyFiles, unknownTypes: linted.unknownTypes, symlinks },
    deleted: listed(deleted),
    noSchema,
    notes,
    ...(adtLsChanged ? { adtLsChanged } : {}),
    ms: Date.now() - started,
  };
}

/** A listed file's bytes; undefined when it is gone by now. */
async function readListed(abs: string): Promise<Buffer | 'symlink' | undefined> {
  try {
    if ((await lstat(abs)).isSymbolicLink()) return 'symlink';
    return await readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
