import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';

export interface ResolvedObject extends ObjectRef {
  uri: string;
}

/**
 * Resolve `{name, objectType}` to its repotree AFF URI and confirm the
 * object actually exists there.
 *
 * `adt.lifecycle.resolveAffUri` already does search → getLsUri, but the
 * search index can be stale — the M1 spike hit a case where quickSearch
 * returned a DDLS deleted minutes earlier. Every adt+ capability that names an object by
 * `{name, type}` must go through this function rather than trusting
 * `resolveAffUri` alone.
 */
export async function resolveObject(
  adt: AdtLsClient,
  ref: ObjectRef,
): Promise<ResolvedObject> {
  const uri = await adt.lifecycle.resolveAffUri(ref);
  try {
    await adt.repository.readFile(uri);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Resolved ${ref.objectType} "${ref.name}" to ${uri}, but it could not be read ` +
        `(stale search index?): ${message}`,
    );
  }
  return { ...ref, uri };
}

/**
 * A fresh adt-ls session cannot write or delete an object it has not opened:
 * `Object cannot be locked: The Semantic file store doesn't exist` (M6.0
 * finding 7). Resolving reads the AFF source file; deletes additionally need
 * the file they delete read (`deleteTargetUri`), which is the `.json` metadata
 * file for most types. Returns the resolved object.
 */
export async function resolveForWrite(
  adt: AdtLsClient,
  ref: ObjectRef,
): Promise<ResolvedObject> {
  const resolved = await resolveObject(adt, ref);
  const extra = new Set([metadataAffUri(resolved.uri), deleteTargetUri(ref.objectType, resolved.uri)]);
  extra.delete(resolved.uri);
  for (const uri of extra) await adt.repository.readFile(uri).catch(() => undefined);
  return resolved;
}

/**
 * The file a delete targets: the object's AFF metadata file, the main file with `.json`, for most
 * types. A DDLX is deleted by its source. A function group's main file is its program
 * (`<group>.fugr.sapl<group>.reps.abap`), whose `.json` is that include's, which SAP refuses to
 * delete ("Only delete function module includes using Function Builder"); the group's own is
 * `<group>.fugr.json` in the same folder.
 */
export function deleteTargetUri(objectType: string, uri: string): string {
  const type = objectType.toUpperCase();
  if (type === 'DDLX/EX') return uri;
  if (type === 'FUGR/F') {
    const group = /^(.*\/)([^/]+?\.fugr)\.[^/]*$/i.exec(uri);
    if (group) return `${group[1]}${group[2]}.json`;
  }
  return metadataAffUri(uri);
}

/**
 * The AFF metadata URI (final extension → `.json`), which is what a delete
 * targets for most object types.
 *
 * This mirrors the SDK's own internal helper, which it does not export.
 * `object delete` needs it to pick the URI itself: the SDK's
 * `lifecycle.delete` has no DDLX branch.
 */
export function metadataAffUri(mainAffUri: string): string {
  return mainAffUri.replace(/\.[^./]+$/, '.json');
}
