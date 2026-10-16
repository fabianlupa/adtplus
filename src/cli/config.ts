import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { checkDestinations } from '../core/config-check.js';
import {
  defaultAdtlsDestinationsPath,
  defaultSystemsConfigPath,
  loadConfig,
  mergeLayers,
  readConfigLayers,
  systemsConfigJsonSchema,
  type ConfigLayer,
  type LoadedConfig,
} from '../core/destinations.js';
import { approve, findProjectConfigs, projectFolderOf, tildePath } from '../core/project-config.js';
import { askTrustDialog, describeLayer, formatSummaries } from '../core/trust-dialog.js';

type Flags = Record<string, string | undefined>;

/** Fields `show` prints first, in this order; the rest follow as they come. */
const LEADING = ['kind', 'auth', 'client', 'systemUrl', 'user', 'keychainService'];

const tilde = (p: string): string => tildePath(p);

/** A field's source as `show` prints it: `user`, the project folder, or the ~/.adtls entry. */
function sourceLabel(source: string | undefined, userPath: string): string {
  if (!source) return '';
  if (source === userPath) return 'user';
  if (source.startsWith('~/.adtls ')) return source;
  return tilde(projectFolderOf(source));
}

function printLayers(layers: ConfigLayer[], userPath: string): void {
  if (!layers.some((l) => l.path === userPath)) console.log(`user config          ${tilde(userPath)} (none)`);
  for (const layer of layers) {
    const label = layer.kind === 'user' ? 'user config   ' : 'project config';
    const state = layer.kind === 'project' ? (layer.trusted ? ' (approved)' : ' (NOT approved)') : '';
    console.log(`${label}       ${tilde(layer.path)}${state}`);
  }
  console.log(`adt-ls destinations  ${tilde(defaultAdtlsDestinationsPath())}`);
}

function printSystems(config: LoadedConfig, userPath: string): void {
  for (const destination of Object.values(config.destinations)) {
    const { id, ...fields } = destination;
    const from = config.sources[id] ?? {};
    console.log('');
    console.log(id);
    const keys = [...LEADING.filter((k) => k in fields), ...Object.keys(fields).filter((k) => !LEADING.includes(k))];
    for (const key of keys) {
      const value = (fields as Record<string, unknown>)[key];
      if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
      // An object field can take its keys from several files (`mirror.maxObjects`).
      const files = Object.entries(from).filter(([path]) => path === key || path.startsWith(`${key}.`));
      const source = [...new Set(files.map(([, file]) => sourceLabel(file, userPath)))].filter(Boolean).join(', ');
      console.log(`  ${key.padEnd(24)} ${JSON.stringify(value)}${source ? `  (${source})` : ''}`);
    }
  }
  for (const [id, reason] of Object.entries(config.refused)) {
    console.log('');
    console.log(`${id}: refused, ${reason.replaceAll(homedir() + path.sep, '~/')}`);
  }
}

/** Ask on the terminal when no dialog can be shown. Weaker: whatever types in this terminal can answer. */
async function askOnTerminal(text: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error('No approval dialog can be shown here, and stdin is not a terminal to ask on instead.');
  }
  console.log(text);
  console.log('');
  console.log('No dialog can be shown here. Approving on the terminal is weaker: anything that can type in it can approve.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question('Type "approve" to approve this file: ')).trim() === 'approve';
  } finally {
    rl.close();
  }
}

async function trust(projectConfigPaths: string[]): Promise<void> {
  const layers = await readConfigLayers({ projectConfigPaths });
  const pending = layers.filter((l) => !l.trusted);
  if (pending.length === 0) {
    console.log(projectConfigPaths.length === 0 ? 'No project config here.' : 'Every project config here is approved.');
    return;
  }
  // One question for every pending file on the chain: each is described against the files before it.
  const summaries = pending.map((layer) =>
    describeLayer(layer, mergeLayers(layers.slice(0, layers.indexOf(layer))).entries, tilde(layer.path)),
  );
  let answer = await askTrustDialog(summaries);
  if (answer === 'unavailable') answer = (await askOnTerminal(formatSummaries(summaries))) ? 'allow' : 'deny';
  for (const layer of pending) {
    if (answer === 'allow') {
      // The hash of the content that was shown, so an edit since then is not covered.
      await approve(layer.path, layer.sha256);
      console.log(`✓ approved ${tilde(layer.path)}`);
    } else {
      console.log(`✗ not approved ${tilde(layer.path)}`);
    }
  }
  if (answer !== 'allow') process.exitCode = 1;
}

/**
 * `adtplus config show|validate|schema|trust [--dir <folder>]`: reads the config
 * files locally, never the daemon. Project configs are looked up from `--dir`,
 * else the working folder.
 */
export async function runConfig(action: string | undefined, flags: Flags): Promise<void> {
  const json = flags.json !== undefined;
  const userPath = defaultSystemsConfigPath();
  const projectConfigPaths = findProjectConfigs(path.resolve(flags.dir ?? process.cwd()));

  switch (action) {
    case 'schema':
      console.log(JSON.stringify(systemsConfigJsonSchema(), null, 2));
      return;

    case 'show': {
      const config = await loadConfig({ projectConfigPaths });
      if (json) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }
      printLayers(config.layers, userPath);
      printSystems(config, userPath);
      return;
    }

    case 'validate': {
      let config: LoadedConfig;
      try {
        config = await loadConfig({ projectConfigPaths });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (json) console.log(JSON.stringify({ ok: false, error }, null, 2));
        else console.error(`✗ ${error}`);
        process.exitCode = 1;
        return;
      }
      const checks = await checkDestinations(config.destinations);
      for (const [system, reason] of Object.entries(config.refused)) {
        checks.push({ system, problems: [`refused: ${json ? reason : reason.replaceAll(homedir() + path.sep, '~/')}`] });
      }
      const ok = checks.every((c) => c.problems.length === 0);
      if (json) {
        console.log(JSON.stringify({ ok, files: config.layers.map((l) => ({ path: l.path, kind: l.kind, trusted: l.trusted })), systems: checks }, null, 2));
      } else {
        for (const layer of config.layers) console.log(tilde(layer.path));
        for (const check of checks) {
          if (check.problems.length === 0) console.log(`  ✓ ${check.system}`);
          else for (const problem of check.problems) console.log(`  ✗ ${check.system}: ${problem}`);
        }
      }
      if (!ok) process.exitCode = 1;
      return;
    }

    case 'trust':
      await trust(projectConfigPaths);
      return;

    default:
      throw new Error(`unknown config action "${action ?? ''}" (show, validate, schema, trust)`);
  }
}
