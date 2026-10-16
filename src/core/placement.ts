import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import { resolveObject } from './resolve.js';

/**
 * Which package a write lands in, and the packages above it.
 *
 * Read off the repotree URI `resolveObject` already returns, so no extra call
 * is needed. The path is `…/repotree-v1/<mount>/<root>/<package chain>/<category>/
 * <type>/<OBJECT>/<file>`: the package sits three segments above the object's
 * own folder. `$TMP` objects sit under a `Local Objects ($TMP)/<user>` root
 * instead, where that position holds the user folder, not a package.
 *
 * Every function here returns `undefined` rather than guessing; the caller
 * refuses the write then.
 */
export interface Placement {
  /** The package the write is checked against. */
  package: string;
  /** The package chain from the top down, ending with `package`. */
  chain: string[];
}

/** Both root labels are localized; this part of the `$TMP` one is not. */
const LOCAL_OBJECTS_MARK = '($TMP)';

/** Decoded path segments below the mount: `[root, ...]`. Split before decoding, so `/NS/` names stay whole. */
function repotreeSegments(uri: string): string[] | undefined {
  const parts = uri.split('/');
  const at = parts.indexOf('repotree-v1');
  if (at === -1 || parts.length < at + 4) return undefined;
  return parts.slice(at + 2).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

export function isPackageType(objectType: string): boolean {
  return objectType.toUpperCase().split('/')[0] === 'DEVC';
}

/**
 * Where a write to the resolved object lands. For a package that is its
 * superpackage: a package lives in its parent, so the allowlist root itself is
 * never writable unless its own parent is listed.
 */
export function objectPlacement(uri: string, ref: ObjectRef): Placement | undefined {
  const segments = repotreeSegments(uri);
  if (!segments) return undefined;
  const [root = '', ...rest] = segments;
  const at = isFunctionGroupPart(ref.objectType)
    ? functionGroupFolder(rest, ref.name)
    : rest.map((s) => s.toUpperCase()).lastIndexOf(ref.name.toUpperCase());
  if (at === -1) return undefined;
  const local = root.includes(LOCAL_OBJECTS_MARK);

  if (isPackageType(ref.objectType)) {
    if (local || at === 0) return undefined;
    return { package: rest[at - 1]!, chain: rest.slice(0, at) };
  }
  if (local) return { package: '$TMP', chain: ['$TMP'] };
  if (at < 3) return undefined;
  return { package: rest[at - 3]!, chain: rest.slice(0, at - 2) };
}

/** A function module or function group include: it has no folder of its own. */
function isFunctionGroupPart(objectType: string): boolean {
  const [type, subtype] = objectType.toUpperCase().split('/');
  return type === 'FUGR' && (subtype === 'FF' || subtype === 'I');
}

/**
 * A function module's or include's file sits in its group's folder, named
 * `<group>.fugr.<object>.<…>` (`…/Function Groups/ZADTPLUS_CALC/zadtplus_calc.fugr.z_adtplus_calc_get.func.abap`): the
 * group's folder stands where the object's own would. -1 unless the file name says so. A
 * namespaced name may be spelled `/NS/FM` or AFF's `(NS)FM` there.
 */
function functionGroupFolder(rest: string[], name: string): number {
  const at = rest.length - 2;
  if (at < 0) return -1;
  const file = rest[at + 1]!.toLowerCase();
  const aff = name.replace(/^\/([^/]+)\/(.+)$/, '($1)$2');
  return [name, aff].some((n) => file.startsWith(`${rest[at]!}.fugr.${n}.`.toLowerCase())) ? at : -1;
}

/** The chain of a package itself, from a URI inside its own folder (e.g. its `.devck.jsonc`). */
export function packageChain(uri: string, packageName: string): string[] | undefined {
  const segments = repotreeSegments(uri);
  if (!segments) return undefined;
  const rest = segments.slice(1);
  const at = rest.map((s) => s.toUpperCase()).lastIndexOf(packageName.toUpperCase());
  return at === -1 ? undefined : rest.slice(0, at + 1);
}

export type PackageChainLookup = (packageName: string) => Promise<string[]>;

/** One confirming resolve of the package (search → getLsUri → read). Throws when the chain cannot be read. */
export function lookupPackageChain(adt: AdtLsClient): PackageChainLookup {
  return async (packageName) => {
    const { uri } = await resolveObject(adt, { name: packageName, objectType: 'DEVC/K' });
    const chain = packageChain(uri, packageName);
    if (!chain) throw new Error(`cannot read the package chain of "${packageName}" from ${uri}`);
    return chain;
  };
}
