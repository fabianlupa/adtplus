import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inPool } from '../core/pool.js';
import { filesBelow } from './files.js';
import { REMOTE_SUFFIX, SRC_DIR } from './layout.js';
import type { Manifest, ManifestFileEntry } from './manifest.js';
import { contentHash } from './normalize.js';

/**
 * Local files against the manifest, for `mirror status` and push's plan alike, so the two
 * agree on what is modified. No SAP call.
 */

/** A file's state against its base. */
export type FileState =
  /** Same content as the base. */
  | 'unchanged'
  /** Changed against the base, or against the `.remote` a re-pull left when there is no base (ADR-007). */
  | 'modified'
  /** Gone from disk while the manifest has a base or a `.remote` for it. */
  | 'deleted'
  /** On disk, but its last read failed: no base and no `.remote` to compare with. */
  | 'noBase'
  /** Neither a base nor a file. */
  | 'absent';

export interface ScannedFile {
  id: string;
  /** File name inside the object's folder. */
  name: string;
  /** Path below the mirror root, `/`-separated. */
  rel: string;
  entry: ManifestFileEntry;
  state: FileState;
  /** The local content, when the file exists. */
  text?: string;
  /** The content of `<file>.remote`, when a re-pull left one. */
  remote?: string;
}

export interface LocalScan {
  /** Every file the manifest knows, in manifest order. */
  files: ScannedFile[];
  /** Files under `src/` the manifest doesn't know, `.remote` files left out. */
  unknown: string[];
  /** `.remote` files under `src/`. */
  remotes: string[];
}

/** A file's content; undefined when it is missing or a symbolic link. */
export async function readLocal(abs: string): Promise<string | undefined> {
  try {
    if ((await lstat(abs)).isSymbolicLink()) return undefined;
    return await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Files `scanLocal` reads at once: a mirror holds thousands, and one at a time is slow. */
const READS_AT_ONCE = 32;

export async function scanLocal(root: string, manifest: Manifest): Promise<LocalScan> {
  const below = await filesBelow(root, SRC_DIR);
  const remotes = below.filter((rel) => rel.endsWith(REMOTE_SUFFIX));
  const remoteSet = new Set(remotes);
  const abs = (rel: string) => path.join(root, ...rel.split('/'));
  const listed = Object.entries(manifest.objects).flatMap(([id, object]) =>
    Object.entries(object.files).map(([name, entry]) => ({ id, name, rel: `${object.dir}/${name}`, entry })),
  );
  const known = new Set(listed.map(({ rel }) => rel));
  const files = await inPool(listed, READS_AT_ONCE, async (file): Promise<ScannedFile> => {
    const [remote, text] = await Promise.all([
      remoteSet.has(`${file.rel}${REMOTE_SUFFIX}`) ? readLocal(abs(`${file.rel}${REMOTE_SUFFIX}`)) : undefined,
      readLocal(abs(file.rel)),
    ]);
    return { ...file, state: stateOf(file.entry, text, remote), text, remote };
  });
  const unknown = below.filter((rel) => !rel.endsWith(REMOTE_SUFFIX) && !known.has(rel));
  return { files, unknown, remotes };
}

function stateOf(entry: ManifestFileEntry, text: string | undefined, remote: string | undefined): FileState {
  if (entry.hash === undefined && remote === undefined) return text === undefined ? 'absent' : 'noBase';
  if (text === undefined) return 'deleted';
  return contentHash(text) === entry.hash ? 'unchanged' : 'modified';
}
