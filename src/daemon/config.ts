import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  defaultAdtlsDestinationsPath,
  defaultSystemsConfigPath,
  loadConfig,
  mergeLayers,
  type ConfigLayer,
  type Destination,
  type LoadConfigOptions,
  type LoadedConfig,
} from '../core/destinations.js';
import { approve, checkProjectConfigPath, defaultTrustStorePath, tildePath } from '../core/project-config.js';
import { askTrustDialog, describeLayer, type DialogAnswer, type LayerSummary } from '../core/trust-dialog.js';

/**
 * The daemon's view of the config for one client (docs/decisions/006-layered-config.md):
 * the user config plus the project configs the client found. Clients send
 * paths only; the daemon reads and checks the files itself.
 */
export interface ConfigResolver {
  /**
   * The config seen with these project configs. With `system`, a system refused
   * only because a project config isn't approved is first put to the user in
   * the approval dialog.
   */
  resolve(projectConfigs: string[], system?: string): Promise<LoadedConfig>;
}

/** A fixed set of systems, no files: for tests and callers that load the config themselves. */
export function staticResolver(destinations: Record<string, Destination>): ConfigResolver {
  const config: LoadedConfig = { destinations, sources: {}, layers: [], refused: {} };
  return { resolve: async () => config };
}

export interface ConfigResolverOptions extends Omit<LoadConfigOptions, 'projectConfigPaths'> {
  home?: string;
  /** Testing seam: replaces the macOS dialog. */
  ask?: (summaries: LayerSummary[]) => Promise<DialogAnswer>;
  /** Called with the systems of each freshly read config, e.g. to trust their CA files. */
  onLoaded?: (destinations: Record<string, Destination>) => Promise<void>;
}

/** Size and mtime, or "missing": changes whenever the file is saved. */
function stamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** How many distinct configs (sets of project files) stay cached. */
const CACHE_SIZE = 32;

export function createConfigResolver(opts: ConfigResolverOptions = {}): ConfigResolver {
  const home = opts.home ?? homedir();
  const userPath = opts.systemsConfigPath ?? defaultSystemsConfigPath();
  const adtlsPath = opts.adtlsDestinationsPath ?? defaultAdtlsDestinationsPath();
  const trustPath = opts.trustStorePath ?? defaultTrustStorePath();
  const ask = opts.ask ?? askTrustDialog;

  const cache = new Map<string, Promise<LoadedConfig>>();
  /** Files the user denied, by path and hash: not asked again until the file changes or `config trust` approves it. */
  const denied = new Set<string>();
  /** Dialogs on screen, by the files they ask about: concurrent requests wait for the same answer. */
  const asking = new Map<string, Promise<DialogAnswer>>();

  function load(paths: string[]): Promise<LoadedConfig> {
    const key = JSON.stringify([paths, [userPath, adtlsPath, trustPath, ...paths].map(stamp)]);
    let hit = cache.get(key);
    if (!hit) {
      hit = loadConfig({ ...opts, projectConfigPaths: paths }).then(async (config) => {
        await opts.onLoaded?.(config.destinations);
        return config;
      });
      hit.catch(() => cache.delete(key));
      cache.set(key, hit);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    }
    return hit;
  }

  function withReason(config: LoadedConfig, system: string, reason: string): LoadedConfig {
    return { ...config, refused: { ...config.refused, [system]: reason } };
  }

  return {
    async resolve(projectConfigs, system) {
      const paths = projectConfigs.map((p) => checkProjectConfigPath(p, home));
      const config = await load(paths);
      if (!system || !config.refused[system]) return config;

      const pending = config.layers.filter((l): l is ConfigLayer => !l.trusted && system in l.systems);
      if (pending.length === 0) return config;
      const files = pending.map((l) => tildePath(l.path, home)).join(', ');
      const id = pending.map((l) => `${l.path}\0${l.sha256}`).join('\n');
      if (denied.has(id)) {
        return withReason(config, system, `${files} was denied in the approval dialog; \`adtplus config trust\` asks again`);
      }

      let answer = asking.get(id);
      if (!answer) {
        const summaries = pending.map((layer) =>
          describeLayer(layer, mergeLayers(config.layers.slice(0, config.layers.indexOf(layer))).entries, tildePath(layer.path, home)),
        );
        answer = ask(summaries)
          .then(async (result) => {
            // Recorded once, before any waiter re-reads: the hash of the content that was shown.
            if (result === 'allow') for (const layer of pending) await approve(layer.path, layer.sha256, trustPath);
            return result;
          })
          .finally(() => asking.delete(id));
        asking.set(id, answer);
      }
      const result = await answer;
      if (result === 'allow') return load(paths);
      if (result === 'deny') {
        denied.add(id);
        return withReason(config, system, `${files} was denied in the approval dialog; \`adtplus config trust\` asks again`);
      }
      return withReason(
        config,
        system,
        `${files} is not approved, and the daemon can't show the approval dialog here; run \`adtplus config trust\` in a terminal`,
      );
    },
  };
}
