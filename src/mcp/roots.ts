import { fileURLToPath } from 'node:url';
import { combineConfigs, loadConfig } from '../core/destinations.js';
import { findProjectConfigs } from '../core/project-config.js';
import { defaultProjectConfigs } from '../daemon/client.js';

/**
 * One project config list per workspace folder the client reported as an MCP
 * root, duplicates dropped (docs/decisions/006-layered-config.md). undefined
 * when no root is a local folder: the caller then falls back to
 * ADTPLUS_PROJECT or the working folder.
 */
export function projectConfigSetsFromRoots(rootUris: string[], home?: string): string[][] | undefined {
  const folders = rootUris.filter((uri) => uri.startsWith('file:')).map((uri) => fileURLToPath(uri));
  if (folders.length === 0) return undefined;
  const sets = new Map<string, string[]>();
  for (const folder of folders) {
    const set = findProjectConfigs(folder, home);
    sets.set(JSON.stringify(set), set);
  }
  return [...sets.values()];
}

/**
 * The local folders among the client's MCP roots, duplicates dropped: where a
 * mirror may live (ADR-007). undefined when none is local, like
 * `projectConfigSetsFromRoots`.
 */
export function workspaceFoldersFromRoots(rootUris: string[]): string[] | undefined {
  const folders = [...new Set(rootUris.filter((uri) => uri.startsWith('file:')).map((uri) => fileURLToPath(uri)))];
  return folders.length > 0 ? folders : undefined;
}

/** The systems that switch on `adtplus_run` (`allowRun`), `adtplus_data` (`allowDataPreview`, ADR-013) and `adtplus_runtime` (`allowRuntimeLogs`, ADR-015). */
export interface GatedSystems {
  run: string[];
  data: string[];
  runtime: string[];
}

/**
 * The systems with `allowRun: true` and with `allowDataPreview: true` in the
 * config these sets resolve to, approved files only, from one read: what
 * `adtplus_run` and `adtplus_data` offer. The daemon checks again on each call.
 * A config that doesn't load leaves none; the daemon reports the error on the
 * first call.
 */
export async function gatedSystemsFor(sets: string[][] = [defaultProjectConfigs()]): Promise<GatedSystems> {
  try {
    const configs = await Promise.all(sets.map((projectConfigPaths) => loadConfig({ projectConfigPaths })));
    const destinations = Object.values(combineConfigs(configs).destinations);
    return {
      run: destinations.filter((d) => d.allowRun === true).map((d) => d.id),
      data: destinations.filter((d) => d.allowDataPreview === true).map((d) => d.id),
      runtime: destinations.filter((d) => d.allowRuntimeLogs === true).map((d) => d.id),
    };
  } catch {
    return { run: [], data: [], runtime: [] };
  }
}
