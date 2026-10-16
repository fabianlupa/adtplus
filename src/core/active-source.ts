import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import { ThrottledError } from '../daemon/ratelimit.js';

/**
 * The active half of a source read. `sameAsServed`: adt-ls already serves the
 * active version of every include, because the logged-on user has no draft of
 * any of them, so the default read is the active one and nothing more was read.
 * Otherwise `texts` holds each include's active source by include name (`main`
 * for the object's own source); an include that could not be read is missing
 * there and has its error in `errors`.
 */
export type ActiveRead = { sameAsServed: true } | { texts: Map<string, string>; errors?: Map<string, string> };

/** A class include's AFF URI, as the SDK's internal `includeAffUri` builds it. */
export function includeUri(mainUri: string, include: string | undefined): string {
  return include ? mainUri.replace(/\.clas\.abap$/, `.clas.${include}.abap`) : mainUri;
}

/**
 * Read `includes` of `ref` at the ACTIVE version through the SDK's
 * `source.read({version: 'active'})`.
 *
 * Versions are per file: a class's main source can be active while one include
 * holds the user's draft. So every include is stat'ed first; when none has a
 * draft, nothing is read. Otherwise each include is read active. The SDK
 * toggles adt-ls to the active version for the whole object while it reads,
 * serializes its own calls on the object meanwhile, and toggles back by
 * `abapStat`. Calls outside its queue (`raw`, quality, other adt+ commands)
 * would see the flip, so the caller still keeps them out (the daemon's object
 * lock).
 */
export async function readActiveIncludes(
  adt: AdtLsClient,
  ref: ObjectRef,
  includes: Array<string | undefined>,
): Promise<ActiveRead> {
  // A ref resolved by the caller carries its URI: resolving it again would cost a counted call for nothing.
  const uri = ref.uri ?? (await adt.lifecycle.resolveAffUri(ref));
  // Stat first: a stat that answers counts, whatever a cached listing says. A failed stat counts as
  // a missing include only when the folder doesn't list the file; otherwise it fails the read, since
  // it could hide the one draft and label draft text active.
  const stats = await Promise.allSettled(includes.map((include) => adt.repository.abapStat(includeUri(uri, include))));
  const throttled = stats.find((r) => r.status === 'rejected' && r.reason instanceof ThrottledError);
  if (throttled) throw (throttled as PromiseRejectedResult).reason;
  const failed = includes.filter((_, i) => stats[i]!.status === 'rejected');
  const listed = failed.length > 0 ? await listedIncludes(adt, uri, failed) : [];
  const served = stats.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    if (includes[i] === undefined || listed.includes(includes[i])) throw r.reason;
    return undefined;
  });
  if (served.every((v) => v === undefined)) {
    throw new Error(`${ref.name} has no include ${includes.filter((include) => include !== undefined).join(', ')}`);
  }
  if (!served.includes('inactive')) return { sameAsServed: true };

  const texts = new Map<string, string>();
  const errors = new Map<string, string>();
  // Every read settles before a cooldown fails the whole: the caller's hold on the object must
  // outlast the SDK's switch to the active version.
  const reads = await Promise.allSettled(
    // A read that throws synchronously settles as rejected too, instead of escaping.
    includes.map((include, i) =>
      served[i] === undefined ? Promise.resolve(undefined) : Promise.resolve().then(() => adt.source.read({ ...ref, uri, include, version: 'active' })),
    ),
  );
  const cooldown = reads.find((r) => r.status === 'rejected' && r.reason instanceof ThrottledError);
  if (cooldown) throw (cooldown as PromiseRejectedResult).reason;
  reads.forEach((r, i) => {
    const include = includes[i] ?? 'main';
    if (r.status === 'rejected') errors.set(include, r.reason instanceof Error ? r.reason.message : String(r.reason));
    else if (typeof r.value === 'string') texts.set(include, r.value);
  });
  return { texts, errors };
}

/** Which of `includes` the object's folder lists. adt-ls's listing names are decoded; the URI's aren't. */
async function listedIncludes(adt: AdtLsClient, uri: string, includes: Array<string | undefined>): Promise<Array<string | undefined>> {
  const folder = uri.slice(0, uri.lastIndexOf('/'));
  const files = new Set((await adt.repository.readDirectory(folder)).map((entry) => entry.name));
  return includes.filter((include) => {
    const file = includeUri(uri, include);
    return files.has(decodeURIComponent(file.slice(file.lastIndexOf('/') + 1)));
  });
}
