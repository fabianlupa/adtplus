import { resolveRoot } from './layout.js';
import { adtLsChange } from './files.js';
import { loadManifest } from './manifest.js';
import { scanLocal } from './scan.js';
import { MAX_LISTED, listed, type Listed, type MirrorLocation } from './pull.js';

/**
 * `mirror status` (docs/decisions/007-mirror-mode.md): local changes against
 * the manifest. No SAP call; `git diff` shows the content.
 */

export interface StatusInput extends MirrorLocation {
  /** The adt-ls version adt+ runs now, to compare with the last pull's. */
  adtLsVersion?: string;
}

export interface StatusResult {
  root: string;
  system: string;
  packages: Array<{ name: string; subpackages: boolean }>;
  objects: number;
  files: number;
  /** Changed against the base; to be pushed. */
  modified: Listed;
  /** `.jsonc` stubs and `.properties` changed locally: never sent. */
  readOnlyChanged: Listed;
  /** In the manifest, missing on disk. */
  deleted: Listed;
  /** Under `src/`, unknown to the manifest (new local objects). */
  added: Listed;
  /** Conflict files a re-pull left. */
  remote: Listed;
  /** Files whose last read failed. */
  readErrors: Array<{ path: string; message: string }>;
  /** A pull stopped before it finished; run it again. */
  unfinishedPull?: { id: string; startedAt: string };
  /** The adt-ls version differs from the last pull's: a format change makes files look changed. */
  adtLsChanged?: { pulled: string; running: string };
}

export async function status(input: StatusInput): Promise<StatusResult> {
  const root = await resolveRoot(input.root, input.workspaceFolders);
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error(`no mirror at ${root}; run \`mirror init\` first`);

  const modified: string[] = [];
  const readOnlyChanged: string[] = [];
  const deleted: string[] = [];
  const readErrors: StatusResult['readErrors'] = [];
  const scan = await scanLocal(root, manifest);
  for (const file of scan.files) {
    if (file.entry.error) readErrors.push({ path: file.rel, message: file.entry.error });
    if (file.state === 'deleted') deleted.push(file.rel);
    else if (file.state === 'modified') (file.entry.readOnly ? readOnlyChanged : modified).push(file.rel);
  }

  const adtLsChanged = adtLsChange(manifest.adtLs, input.adtLsVersion);
  return {
    root,
    system: manifest.system,
    packages: manifest.packages,
    objects: Object.keys(manifest.objects).length,
    files: scan.files.length,
    modified: listed(modified),
    readOnlyChanged: listed(readOnlyChanged),
    deleted: listed(deleted),
    added: listed(scan.unknown),
    remote: listed(scan.remotes),
    readErrors: readErrors.slice(0, MAX_LISTED),
    ...(manifest.pull ? { unfinishedPull: manifest.pull } : {}),
    ...(adtLsChanged ? { adtLsChanged } : {}),
  };
}
