import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Project configs and their approval (docs/decisions/006-layered-config.md).
 *
 * A project config is `.adtplus/systems.json` in a folder at or above the start
 * folder, below `$HOME`. Its content is only used once the user approved that
 * exact content: the approval is the file's SHA-256, kept with its path in
 * ~/.config/adtplus/trusted.json, so any edit revokes it.
 */

export const PROJECT_CONFIG = path.join('.adtplus', 'systems.json');

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Project configs from `startDir` up to, but not including, `home`, nearest
 * first. None when `startDir` is not below `home`.
 */
export function findProjectConfigs(startDir: string, home: string = homedir()): string[] {
  const root = realpathOr(home);
  let dir = realpathOr(startDir);
  const found: string[] = [];
  if (!dir.startsWith(root + path.sep)) return found;
  while (dir !== root && dir.startsWith(root + path.sep)) {
    const file = path.join(dir, PROJECT_CONFIG);
    if (existsSync(file)) found.push(realpathOr(file));
    dir = path.dirname(dir);
  }
  return found;
}

/** A path under the home folder written with `~`, for messages and dialogs. */
export function tildePath(p: string, home: string = homedir()): string {
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/**
 * Check that a path a client sent names a project config: absolute, ending in
 * `.adtplus/systems.json`, below `home`. Returns its realpath. The daemon reads
 * only such files, whatever a client sends.
 */
export function checkProjectConfigPath(p: string, home: string = homedir()): string {
  if (!path.isAbsolute(p) || !p.endsWith(path.sep + PROJECT_CONFIG)) {
    throw new Error(`Not an adt+ project config path: ${p}`);
  }
  const real = realpathOr(p);
  const root = realpathOr(home);
  if (!real.startsWith(root + path.sep) || !real.endsWith(path.sep + PROJECT_CONFIG)) {
    throw new Error(`adt+ project config outside the home folder: ${p}`);
  }
  return real;
}

/** The folder a project config belongs to: the one holding its `.adtplus/`. */
export function projectFolderOf(configPath: string): string {
  return path.dirname(path.dirname(configPath));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface TrustEntry {
  sha256: string;
  approvedAt: string;
  /** The merge rule the approval was given under; 2 since objects merge key by key (ADR-006). */
  merge?: number;
}

/** The merge rule approvals are given under now (ADR-006): objects merge key by key. */
export const MERGE_RULE = 2;

/** Approved project configs by absolute path. */
export type TrustStore = Record<string, TrustEntry>;

export function defaultTrustStorePath(): string {
  return path.join(homedir(), '.config', 'adtplus', 'trusted.json');
}

export async function readTrustStore(storePath: string = defaultTrustStorePath()): Promise<TrustStore> {
  let text: string;
  try {
    text = await readFile(storePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(text) as TrustStore;
  } catch (err) {
    throw new Error(`${storePath}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Whether this exact content is approved. A file that sets an object field (`mirror`, `rateLimit`)
 * means something else since objects merge key by key (ADR-006): approved before, it is asked for
 * again once.
 */
export function isTrusted(store: TrustStore, configPath: string, hash: string, setsObject = false): boolean {
  const entry = store[configPath];
  return entry?.sha256 === hash && (!setsObject || entry.merge === MERGE_RULE);
}

/** Record the approval of this exact content. Written to a temp file and renamed, mode 0600. */
export async function approve(
  configPath: string,
  hash: string,
  storePath: string = defaultTrustStorePath(),
  now: Date = new Date(),
): Promise<void> {
  const store = await readTrustStore(storePath);
  store[configPath] = { sha256: hash, approvedAt: now.toISOString(), merge: MERGE_RULE };
  await mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, storePath);
}
