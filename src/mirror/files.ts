import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Every file below `dir` but dotfiles, relative to `root` as POSIX paths; symlinks are not followed. */
export async function filesBelow(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    // Dotfiles (.DS_Store, editor swap files) are never mirror files.
    if (e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await filesBelow(root, rel)));
    else out.push(rel);
  }
  return out;
}

/**
 * The versions when the running adt-ls differs from the last pull's: a format
 * change would make files look changed (ADR-007, "Manifest").
 */
export function adtLsChange(pulled: string | undefined, running: string | undefined): { pulled: string; running: string } | undefined {
  // A session reports the full build, the extension folder only major.minor.patch.
  const release = (v: string) => v.match(/^\d+\.\d+\.\d+/)?.[0] ?? v;
  return pulled && running && release(pulled) !== release(running) ? { pulled, running } : undefined;
}
