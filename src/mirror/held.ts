import path from 'node:path';
import type { ObjectRef } from '@arc-mcp/adt-ls';
import { affName, objectId, resolveRoot } from './layout.js';
import type { Manifest } from './manifest.js';
import { MANIFEST_PATH, loadManifest } from './manifest.js';

export interface MirrorHoldInput {
  system: string;
  ref: ObjectRef;
  mirrorRoots: unknown;
  workspaceFolders: unknown;
}

/**
 * The first mirror the client's session used that holds `ref`, with the object's writable
 * files, or the first such mirror whose manifest doesn't parse (`unparsable`; with
 * `skipUnparsable` such a mirror is passed over). undefined: no such mirror. A root outside
 * `workspaceFolders`, or without a manifest, holds nothing.
 */
export async function mirrorHolding(
  input: MirrorHoldInput,
  opts: { skipUnparsable?: boolean } = {},
): Promise<{ root: string; id: string; files: string[] } | { root: string; unparsable: string } | undefined> {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  const roots = [...new Set(strings(input.mirrorRoots))];
  const folders = strings(input.workspaceFolders);
  if (roots.length === 0 || folders.length === 0) return undefined;
  for (const root of roots) {
    let real: string;
    try {
      real = await resolveRoot(root, folders);
    } catch {
      continue;
    }
    let manifest;
    try {
      manifest = await loadManifest(real);
    } catch (err) {
      if (opts.skipUnparsable) continue;
      return { root, unparsable: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
    }
    if (!manifest || manifest.system !== input.system) continue;
    const found = heldFiles(manifest, input.ref);
    if (found) return { root, ...found };
  }
  return undefined;
}

/**
 * Why an in-system write (`cmd`, default `object.update`) on `ref` is refused: a mirror the
 * client's session used holds the object (docs/decisions/009-mirrored-object-write-gate.md).
 * undefined: no such mirror. A manifest that doesn't parse refuses.
 */
export async function mirrorRefusal(input: MirrorHoldInput, cmd = 'object.update'): Promise<string | undefined> {
  const held = await mirrorHolding(input);
  if (!held) return undefined;
  if ('unparsable' in held) {
    return (
      `${cmd} refused: the mirror at ${held.root}, used in this session, has a manifest that doesn't parse ` +
      `(${held.unparsable}). Fix or delete ${path.join(held.root, MANIFEST_PATH)}.`
    );
  }
  return (
    `${cmd} refused: ${held.id} is mirrored at ${held.root}, which this session used. ` +
    `Edit ${held.files.join(', ')} there and push it with adtplus_mirror_write (it checks for conflicts); ` +
    'delete the mirror folder to work on the object in the system again.'
  );
}

/** A note for an in-system read of `ref` when a mirror the session used holds it: its files may be newer. */
export async function mirrorReadNote(input: MirrorHoldInput): Promise<string | undefined> {
  const held = await mirrorHolding(input, { skipUnparsable: true });
  if (!held || 'unparsable' in held) return undefined;
  return `${held.id} is mirrored at ${held.root}, which this session used: ${held.files.join(', ')} there may hold newer, unpushed changes`;
}

/**
 * The mirrored object holding `ref` and its writable files. Manifest keys are AFF folders:
 * a function module (`FUGR/FF`) or function group include (`FUGR/I`) is a file of its
 * group's entry (`<group>.fugr.<name>.…`), not an entry of its own.
 */
function heldFiles(manifest: Manifest, ref: ObjectRef): { id: string; files: string[] } | undefined {
  const [type, sub] = String(ref.objectType).toUpperCase().split('/');
  const name = String(ref.name).toUpperCase();
  const writable = (id: string, match: (file: string) => boolean = () => true) => {
    const held = manifest.objects[id];
    const files = held ? Object.entries(held.files).filter(([file, f]) => !f.readOnly && match(file)).map(([file]) => `${held.dir}/${file}`) : [];
    return files.length > 0 ? { id, files } : undefined;
  };
  if (type !== 'FUGR' || sub === undefined || sub === 'F') return writable(objectId(type!, name));
  const part = `.fugr.${affName(name).toLowerCase()}.`;
  for (const id of Object.keys(manifest.objects)) {
    if (!id.startsWith('FUGR ')) continue;
    const found = writable(id, (file) => file.toLowerCase().includes(part));
    if (found) return found;
  }
  return undefined;
}
