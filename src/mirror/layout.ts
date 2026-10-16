import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where mirror files live and what they are (docs/decisions/007-mirror-mode.md,
 * "Local layout"): `<root>/src/<package>/<file>`, package folders lower case,
 * a namespaced name `/NS/X` as AFF's `(ns)x`, subpackages nested, adt-ls's
 * category and type folders flattened away.
 */

export const MANIFEST_DIR = '.adtplus';
export const MANIFEST_FILE = 'mirror.json';
export const SRC_DIR = 'src';
/** Suffix of the remote version a re-pull writes next to a conflicting file. */
export const REMOTE_SUFFIX = '.remote';

/** `/DMO/AGENCY` → `(DMO)AGENCY`, as adt-ls names object and package folders. */
export function affName(name: string): string {
  const m = name.match(/^\/([^/]+)\/(.+)$/);
  return m ? `(${m[1]})${m[2]}` : name;
}

/** `(DMO)AGENCY` → `/DMO/AGENCY`: the ABAP name of an adt-ls object or package folder. */
export function abapName(folder: string): string {
  const m = folder.match(/^\(([^)]+)\)(.+)$/);
  return (m ? `/${m[1]}/${m[2]}` : folder).toUpperCase();
}

/** The local folder name of a package: AFF's name in lower case. */
export function packageFolder(name: string): string {
  return affName(name).toLowerCase();
}

/**
 * An object's type from its files' names: the segment after the object's own
 * name (`zcl_x.clas.abap` → `CLAS`, `zostatfl.dtelde.jsonc` → `DTELDE`). Every
 * file of the folder shares it; a file not named after the folder (none seen
 * so far) falls back to the first file's second segment.
 */
export function affType(folder: string, files: string[]): string | undefined {
  const stem = `${affName(abapName(folder)).toLowerCase()}.`;
  const own = files.find((f) => f.toLowerCase().startsWith(stem));
  const segment = own ? own.slice(stem.length).split('.')[0] : files[0]?.split('.')[1];
  return segment ? segment.toUpperCase() : undefined;
}

/** `.jsonc` stubs and `.properties` texts can't be written through adt-ls (ADR-007): read-only locally. */
export function isReadOnlyFile(name: string): boolean {
  return name.endsWith('.jsonc') || name.endsWith('.properties');
}

/** abapGit's names for the class includes AFF, as adt-ls serves it, names otherwise. */
const ABAPGIT_CLASS_INCLUDES: Record<string, string> = { locals_imp: 'implementations', locals_def: 'definitions' };

/**
 * AFF's name for a file named as abapGit names a class include
 * (`zbp_x.clas.locals_imp.abap` → `zbp_x.clas.implementations.abap`), or
 * undefined. Agents write abapGit's names; push can't send them.
 */
export function affClassFileFor(name: string): string | undefined {
  const m = name.match(/^(.+\.clas\.)(locals_imp|locals_def)(\.abap)$/i);
  return m ? `${m[1]}${ABAPGIT_CLASS_INCLUDES[m[2]!.toLowerCase()]}${m[3]}` : undefined;
}

/** The manifest key of an object: `CLAS ZCL_X`. */
export function objectId(type: string, name: string): string {
  return `${type} ${name}`;
}

/** `src/zadtplus_a/zcl_a.clas.abap` → `CLAS ZCL_A`, as the mirror names objects. */
export function objectOfPath(p: string): string {
  const [stem = '', type = ''] = path.posix.basename(p).split('.');
  return objectId(type.toUpperCase(), abapName(stem));
}

/** `CLAS ZCL_X` → type and name; undefined for the `(was <package>)` entries a move leaves, never pushed or activated. */
export function parseId(id: string): { type: string; name: string } | undefined {
  const at = id.indexOf(' ');
  if (at <= 0 || id.includes(' (was ')) return undefined;
  return { type: id.slice(0, at), name: id.slice(at + 1) };
}

/**
 * A root package must be customer code: `Z`, `Y`, `$`, or a namespace the
 * operator listed in `mirror.namespaces` (ADR-007, "Pull").
 */
export function isMirrorablePackage(name: string, namespaces: string[] = []): boolean {
  const upper = name.toUpperCase();
  if (/^[ZY$]/.test(upper)) return true;
  return namespaces.some((ns) => {
    const n = ns.toUpperCase();
    return n.startsWith('/') && n.endsWith('/') && n.length > 2 && upper.startsWith(n);
  });
}

/** One path segment as adt-ls might serve it: refuses separators, `.`/`..`, NUL and the empty name. */
export function isSafeSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..' && !/[/\\\0]/.test(segment);
}

/** A relative POSIX path whose every segment is safe; what the manifest may hold. */
export function isSafeRelativePath(p: string): boolean {
  if (p === '' || path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) return false;
  return p.split('/').every(isSafeSegment);
}

/** `child` is `parent` or below it (both already real paths). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The deepest existing ancestor of `p` (itself if it exists), resolved. */
async function realAncestor(p: string): Promise<{ real: string; rest: string[] }> {
  const rest: string[] = [];
  let current = p;
  for (;;) {
    try {
      return { real: await realpath(current), rest };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The mirror root, resolved: `root` must lie inside one of `workspaceFolders`
 * after every symlink is followed (ADR-007, "Local layout"). With `create`, a
 * missing root is made (`init`); otherwise it must exist.
 */
export async function resolveRoot(
  root: string,
  workspaceFolders: string[],
  opts: { create?: boolean } = {},
): Promise<string> {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error(`mirror root "${root}" is not an absolute path`);
  if (!Array.isArray(workspaceFolders)) throw new Error('no workspace folder to hold a mirror');
  const folders: string[] = [];
  for (const f of workspaceFolders) {
    if (typeof f !== 'string' || !path.isAbsolute(f)) continue;
    try {
      folders.push(await realpath(f));
    } catch {
      // A folder that doesn't exist (any more) can't hold a mirror.
    }
  }
  if (folders.length === 0) throw new Error('no workspace folder to hold a mirror');
  const { real, rest } = await realAncestor(path.resolve(root));
  const target = path.join(real, ...rest);
  if (!folders.some((f) => isInside(target, f))) {
    throw new Error(`mirror root ${root} is outside the workspace folders (${workspaceFolders.join(', ')})`);
  }
  if (rest.length > 0) {
    if (!opts.create) throw new Error(`mirror root ${root} does not exist`);
    await mkdir(target, { recursive: true });
  }
  return target;
}

/**
 * The absolute path of `rel` (a manifest path) under the real `root`, made safe
 * to write: the path is relative without `..`, its parent folders are created
 * and resolve inside the root, and an existing target is no symlink.
 */
export async function safeTarget(root: string, rel: string, opts: { mkdir?: boolean } = {}): Promise<string> {
  if (!isSafeRelativePath(rel)) throw new Error(`unsafe mirror path "${rel}"`);
  const target = path.join(root, ...rel.split('/'));
  const parent = path.dirname(target);
  if (opts.mkdir) await mkdir(parent, { recursive: true });
  const { real } = await realAncestor(parent);
  if (!isInside(real, root)) throw new Error(`mirror path "${rel}" leaves the mirror root`);
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error(`mirror path "${rel}" is a symlink`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return target;
}
