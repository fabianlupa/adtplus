import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAdtlsDestinationsPath, defaultSystemsConfigPath } from '../core/destinations.js';

/**
 * What a daemon was started from: the code a client would spawn and the config
 * it reads once at start. The daemon outlives MCP server restarts, so a client
 * compares this to its own view of the disk on every connect and replaces a
 * daemon that differs (client.ts ensureDaemon).
 *
 * Both halves are stamps over file path, size and mtime, not content hashes:
 * cheap enough to take on every request, and any rebuild or save changes them.
 */
export interface DaemonIdentity {
  /** dist/**\/*.js when built, else src/**\/*.ts — plus package-lock.json, since dependencies stay external to the bundle. */
  build: string;
  /** systems.json and ~/.adtls/destinations.json. */
  config: string;
}

/** Walk up from this file until a package.json is found. */
export function resolvePackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate adt+ package root');
    dir = parent;
  }
  return dir;
}

/** The built daemon entry; clients spawn it when it exists and fall back to the TypeScript source otherwise. */
export function compiledDaemonPath(root: string): string {
  return path.join(root, 'dist', 'daemon', 'server.js');
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f))
    .sort();
}

function stamp(files: string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    try {
      const s = statSync(file);
      hash.update(`${file}\0${s.size}\0${s.mtimeMs}\n`);
    } catch {
      hash.update(`${file}\0missing\n`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

export interface IdentityOptions {
  root?: string;
  configPaths?: string[];
}

/** The identity a daemon spawned right now would have. */
export function currentIdentity(opts: IdentityOptions = {}): DaemonIdentity {
  const root = opts.root ?? resolvePackageRoot();
  const code = existsSync(compiledDaemonPath(root))
    ? listFiles(path.join(root, 'dist'), '.js')
    : listFiles(path.join(root, 'src'), '.ts');
  return {
    build: stamp([...code, path.join(root, 'package-lock.json')]),
    config: stamp(opts.configPaths ?? [defaultSystemsConfigPath(), defaultAdtlsDestinationsPath()]),
  };
}

/** A daemon that reports no identity predates the handshake and never matches. */
export function sameIdentity(a: DaemonIdentity | undefined, b: DaemonIdentity): boolean {
  return a?.build === b.build && a?.config === b.config;
}
