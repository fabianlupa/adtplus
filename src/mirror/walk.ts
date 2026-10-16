import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { ThrottledError } from '../daemon/ratelimit.js';
import { SRC_DIR, abapName, affType, isSafeSegment, objectId, packageFolder } from './layout.js';

/**
 * A package's objects as adt-ls's repotree serves them (ADR-007, "Pull"):
 * `readDirectory` breadth-first from the package folder. A folder holding a
 * `*.devck.jsonc` is a (sub)package, a folder holding other files is an
 * object, everything else is one of adt-ls's localized category or type
 * folders and is flattened away.
 */

export interface WalkedObject {
  /** Manifest key, `CLAS ZCL_X`. */
  id: string;
  type: string;
  name: string;
  package: string;
  /** Local folder relative to the mirror root, `src/<package>[/<subpackage>…]`. */
  dir: string;
  /** Repotree folder URI of the object, ending in `/`. */
  uri: string;
  files: string[];
}

export interface WalkResult {
  objects: WalkedObject[];
  /** Root packages and the subpackages found below them. */
  packages: string[];
  /** Root packages adt-ls doesn't know. */
  missing: string[];
  /** Folders that failed to read: their objects are unknown, not gone. */
  unreadable: Array<{ path: string; message: string }>;
  /** File names adt-ls served that can't be a local file name. */
  unsafe: string[];
  /** The walk stopped at `maxObjects`. */
  exceeded: boolean;
}

export interface WalkOptions {
  maxObjects: number;
  /** Directories read at once. */
  concurrency: number;
}

const enc = (segments: string[]): string => segments.map((s) => `${encodeURIComponent(s)}/`).join('');

/** The repotree folder URI of a package, or undefined when the system has no such package. */
export async function locatePackage(adt: AdtLsClient, name: string): Promise<string | undefined> {
  const found = await adt.repository.search(name, { maxResults: 5, cold: true, types: ['DEVC/K'] });
  const hit = found.references?.find((r) => r.name?.toUpperCase() === name.toUpperCase() && r.uri);
  if (!hit?.uri) return undefined;
  const fileUri = await adt.repository.getLsUri(hit.uri);
  return fileUri.slice(0, fileUri.lastIndexOf('/') + 1);
}

interface Pending {
  /** Folder names below the root package's folder. */
  rel: string[];
  package: string;
  dir: string;
}

export async function walk(
  adt: AdtLsClient,
  roots: Array<{ name: string; subpackages: boolean }>,
  opts: WalkOptions,
): Promise<WalkResult> {
  const result: WalkResult = { objects: [], packages: [], missing: [], unreadable: [], unsafe: [], exceeded: false };

  for (const root of roots) {
    const base = await locatePackage(adt, root.name);
    if (!base) {
      result.missing.push(root.name);
      continue;
    }
    result.packages.push(root.name.toUpperCase());

    let frontier: Pending[] = [{ rel: [], package: root.name.toUpperCase(), dir: `${SRC_DIR}/${packageFolder(root.name)}` }];
    while (frontier.length > 0 && !result.exceeded) {
      const next: Pending[] = [];
      for (let i = 0; i < frontier.length && !result.exceeded; i += opts.concurrency) {
        const batch = frontier.slice(i, i + opts.concurrency);
        const read = await Promise.all(
          batch.map(async (at) => {
            try {
              return { at, children: await adt.repository.readDirectory(base + enc(at.rel)) };
            } catch (err) {
              // The root package's own folder failing is the caller's answer; deeper ones are reported.
              if (at.rel.length === 0 || err instanceof ThrottledError) throw err;
              const path = [root.name, ...at.rel].join('/');
              result.unreadable.push({ path, message: err instanceof Error ? err.message : String(err) });
              return { at, children: [] };
            }
          }),
        );
        for (const { at, children } of read) {
          const files = children.filter((c) => c.kind === 'file').map((c) => c.name);
          const dirs = children.filter((c) => c.kind === 'directory').map((c) => c.name);
          const isPackage = files.some((f) => f.endsWith('.devck.jsonc'));
          let here = at;
          if (isPackage && at.rel.length > 0) {
            if (!root.subpackages) continue;
            const folder = at.rel[at.rel.length - 1]!;
            const name = abapName(folder);
            result.packages.push(name);
            here = { ...at, package: name, dir: `${at.dir}/${packageFolder(name)}` };
          }
          if (!isPackage && files.length > 0 && at.rel.length > 0) {
            const folder = at.rel[at.rel.length - 1]!;
            const safe = files.filter(isSafeSegment);
            for (const f of files) if (!isSafeSegment(f)) result.unsafe.push(`${at.dir}/${f}`);
            const type = affType(folder, safe);
            if (type && safe.length > 0) {
              if (result.objects.length >= opts.maxObjects) {
                result.exceeded = true;
                break;
              }
              const name = abapName(folder);
              result.objects.push({
                id: objectId(type, name),
                type,
                name,
                package: at.package,
                dir: at.dir,
                uri: base + enc(at.rel),
                files: safe.sort(),
              });
            }
          }
          for (const d of dirs) {
            if (isSafeSegment(d)) next.push({ ...here, rel: [...at.rel, d] });
            else result.unsafe.push(`${at.dir}/${d}/`);
          }
        }
      }
      frontier = next;
    }
    if (result.exceeded) break;
  }
  return result;
}
