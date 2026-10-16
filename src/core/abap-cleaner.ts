import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * abap-cleaner (SAP, Apache-2.0) as an opt-in format engine (ADR-017): the binary the user has,
 * run once per call on a private temp file. Not bundled: it is a 180 MB Eclipse application with
 * its own JRE.
 */

/** Paths are absolute here: `core/destinations.ts` resolves `~/` on load. */
export interface AbapCleanerOptions {
  /** The binary; default: the newest one the abap-cleaner VS Code extension bundles. */
  path?: string;
  /** A profile (.cfj) exported from abap-cleaner; default: `LAYOUT_PROFILE`. */
  profile?: string;
  /** abap-cleaner's `--release`: the newest ABAP syntax a rule may use, e.g. "758". */
  release?: string;
}

/** abap-cleaner 1.29's rules that only change layout: empty lines, spaces, indentation, case, alignment. */
const LAYOUT_RULES = [
  'EMPTY_LINES_IN_CLASS_DEFINITION', 'EMPTY_LINES_OUTSIDE_METHODS', 'EMPTY_LINES_WITHIN_METHODS', 'ONE_COMMAND_PER_LINE',
  'CLOSING_BRACKETS_POSITION', 'NEEDLESS_SPACES', 'SPACE_AROUND_COMMENT_SIGN', 'SPACE_BEFORE_PERIOD', 'SPACES_IN_EMPTY_BRACKETS',
  'INSET', 'UPPER_AND_LOWER_CASE', 'LOGICAL_OPERATOR_POSITION',
  'ALIGN_ABAP_DOC', 'ALIGN_ALIASES_FOR', 'ALIGN_ASSIGNMENTS', 'ALIGN_CLEAR_FREE_AND_SORT', 'ALIGN_COND_EXPRESSIONS',
  'ALIGN_DECLARATIONS', 'ALIGN_FORM_DECLARATION', 'ALIGN_LOGICAL_EXPRESSIONS', 'ALIGN_METHODS_DECLARATION',
  'ALIGN_METHODS_FOR_TESTING', 'ALIGN_METHODS_REDEFINITION', 'ALIGN_PARAMETERS', 'ALIGN_PERFORM', 'ALIGN_SELECT_CLAUSES',
  'ALIGN_SELECT_FROM', 'ALIGN_SELECT_LISTS', 'ALIGN_WITH_SECOND_WORD',
  'DDL_ANNO_LAYOUT', 'DDL_POSITION_DEFINE', 'DDL_POSITION_ASSOCIATION', 'DDL_POSITION_BRACES', 'DDL_POSITION_CLAUSES',
  'DDL_POSITION_JOIN', 'DDL_POSITION_SELECT', 'DDL_SPACES_AROUND_BRACKETS', 'DDL_SPACES_AROUND_SIGNS',
  'DDL_ALIGN_DATA_SOURCES', 'DDL_ALIGN_ENTITY_PARAMETERS', 'DDL_ALIGN_FIELD_LISTS', 'DDL_ALIGN_FUNCTION_PARAMETERS',
  'DDL_ALIGN_LOGICAL_EXPRESSIONS', 'DDL_ALIGN_SELECT_LIST', 'DDL_ALIGN_SOURCE_PARAMETERS',
  'DDL_EMPTY_LINES_BETWEEN', 'DDL_EMPTY_LINES_WITHIN',
];

/** abap-cleaner 1.29's other rules: they rewrite code (obsolete statements, declarations, names), so they stay off. */
const OTHER_RULES = [
  'ABAP_DOC_LANG', 'ABAP_DOC_PARAMETERS', 'ADD_TO_ETC', 'ASSERT_CLASS', 'ASSERT_EQUALS_BOOLEAN', 'ASSERT_EQUALS_SUBRC',
  'ASSERT_PARAMETER_ORDER', 'CALCULATION_ASSIGNMENT', 'CALL_METHOD', 'CAMEL_CASE_IN_CDS_TEST', 'CAMEL_CASE_NAME',
  'CDS_TEST_CLASS_LINES', 'CHAIN_OF_ONE', 'CHECK_IN_LOOP', 'CHECK_OUTSIDE_LOOP', 'CLASS_DEFINITION', 'COMMENT_TYPE',
  'COMPARISON_OPERATOR', 'CONDENSE', 'CREATE_OBJECT', 'DDL_ANNO_NESTING', 'DDL_CAMEL_CASE_NAME', 'DDL_TYPO',
  'DECLARATION_CHAIN', 'DESCRIBE_TABLE', 'EMPTY_COMMAND', 'EMPTY_SECTIONS', 'END_OF_COMMENT', 'EQUALS_SIGN_CHAIN',
  'ESCAPE_CHAR_FOR_PARAMS', 'EXIT_OUTSIDE_LOOP', 'EXPORTING_KEYWORD', 'FINAL_VARIABLE', 'IF_BLOCK_AT_LOOP_END',
  'IF_BLOCK_AT_METHOD_END', 'IMPLICIT_TYPE', 'LOCAL_DECLARATION_ORDER', 'MOVE_TO', 'NEEDLESS_CLEAR', 'NEEDLESS_PARENTHESES',
  'NOT_IS', 'PRAGMA_POSITION', 'PSEUDO_COMMENT', 'RAISE_TYPE', 'READ_TABLE', 'RECEIVING_KEYWORD', 'SELF_REFERENCE_ME',
  'STRING_TEMPLATE', 'TRANSLATE', 'TYPO', 'UNUSED_PARAMETERS', 'UNUSED_VARIABLES', 'VALUE_STATEMENT',
];

/**
 * adt+'s default profile: every rule listed, the layout ones on, each with its default settings.
 * `autoActivateNewFeatures` stays true because `false` gives every setting a "neutral" value (five
 * empty lines between methods); a rule a newer abap-cleaner adds is then on, and the token guard
 * (`core/format-guard.ts`) refuses what it changes beyond layout.
 */
export const LAYOUT_PROFILE = JSON.stringify({
  requiredVersion: 1,
  programVersion: 28,
  ruleCount: LAYOUT_RULES.length + OTHER_RULES.length,
  autoActivateNewFeatures: true,
  rules: [
    ...LAYOUT_RULES.map((ruleID) => ({ ruleID, isActive: true, settingCount: 0, settings: {} })),
    ...OTHER_RULES.map((ruleID) => ({ ruleID, isActive: false, settingCount: 0, settings: {} })),
  ],
});

/** Where the abap-cleaner VS Code extension keeps its binary, per platform. */
function bundledBinaries(extensionDir: string, platform: NodeJS.Platform): string[] {
  const bin = path.join(extensionDir, 'binary');
  if (platform === 'win32') return [path.join(bin, 'abapcleaner', 'abap-cleanerc.exe')];
  if (platform === 'darwin') {
    return [
      path.join(bin, 'abapcleaner.app', 'Contents', 'MacOS', 'abap-cleaner'),
      path.join(bin, 'abapcleaner', 'abapcleaner.app', 'Contents', 'MacOS', 'abap-cleaner'),
    ];
  }
  return [path.join(bin, 'abapcleaner', 'abap-cleaner')];
}

const versionOf = (dir: string): number[] => (dir.match(/^saposs\.abap-cleaner-(\d+(?:\.\d+)*)/)?.[1] ?? '0').split('.').map(Number);

function newerFirst(a: string, b: string): number {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const isFileAsync = async (p: string): Promise<boolean> => (await stat(p).catch(() => undefined))?.isFile() ?? false;

/** Where VS Code installs extensions: locally, for Insiders, and on a remote (SSH, WSL, containers). */
const EXTENSION_ROOTS = ['.vscode', '.vscode-insiders', '.vscode-server', '.vscode-server-insiders'];

/** The newest binary of the abap-cleaner extension across every VS Code install, else undefined. */
export function findBundledBinary(home = os.homedir(), platform = process.platform): string | undefined {
  const installed: Array<{ dir: string; extension: string }> = [];
  for (const root of EXTENSION_ROOTS.map((d) => path.join(home, d, 'extensions'))) {
    try {
      for (const extension of fs.readdirSync(root)) if (extension.startsWith('saposs.abap-cleaner-')) installed.push({ dir: root, extension });
    } catch {
      // No such install.
    }
  }
  for (const { dir, extension } of installed.sort((a, b) => newerFirst(a.extension, b.extension))) {
    const hit = bundledBinaries(path.join(dir, extension), platform).find(isFile);
    if (hit) return hit;
  }
  return undefined;
}

/** The extension's binary, looked up once per daemon: a new extension version needs a restart. */
let bundled: { binary: string | undefined } | undefined;

/** The binary to run: the configured one, else the extension's. Throws naming what to set. */
export async function resolveBinary(opts: AbapCleanerOptions): Promise<string> {
  if (opts.path) {
    if (!(await isFileAsync(opts.path))) throw new Error(`format.abapCleaner.path: no file at ${opts.path}`);
    return opts.path;
  }
  bundled ??= { binary: findBundledBinary() };
  if (!bundled.binary || !(await isFileAsync(bundled.binary))) {
    bundled = undefined;
    throw new Error(
      'abap-cleaner not found: install the abap-cleaner extension in VS Code, or set format.abapCleaner.path to its binary ' +
        '(or set format.engine to "sap")',
    );
  }
  return bundled.binary;
}

const run = (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`abap-cleaner failed: ${(stderr || err.message).trim().slice(0, 500)}`));
      else resolve({ stdout, stderr });
    });
  });

/** abap-cleaner's refusal without its pointer to its own error log. */
function refusal(stderr: string, stdout: string): string {
  const text = (stderr || stdout)
    .split('\n')
    .filter((l) => !/error log/i.test(l))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return text || 'no result and no message';
}

/**
 * Format `source` (ABAP or CDS; abap-cleaner tells them apart itself). Returns the text with `\n`
 * line ends. A parse error throws with abap-cleaner's message: it exits 0 then, writing no result.
 */
export async function cleanSource(source: string, opts: AbapCleanerOptions): Promise<string> {
  const binary = await resolveBinary(opts);
  if (opts.profile && !(await isFileAsync(opts.profile))) throw new Error(`format.abapCleaner.profile: no file at ${opts.profile}`);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'adtplus-format-'));
  try {
    const input = path.join(dir, 'source.abap');
    const output = path.join(dir, 'formatted.abap');
    await writeFile(input, source, { mode: 0o600 });
    const args = ['--sourcefile', input, '--targetfile', output, '--overwrite'];
    args.push(...(opts.profile ? ['--profile', opts.profile] : ['--profiledata', LAYOUT_PROFILE]));
    if (opts.release) args.push('--release', opts.release);
    const { stdout, stderr } = await run(binary, args);
    if (!(await isFileAsync(output))) throw new Error(`abap-cleaner refused: ${refusal(stderr, stdout)}`);
    return (await readFile(output, 'utf8')).replace(/\r\n/g, '\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
