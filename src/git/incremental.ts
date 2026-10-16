import type { Stamps } from './state.js';

/**
 * Which objects a fetch re-reads (G5): those whose change stamp moved since the last complete
 * pull. A search hit that is part of a mirrored object (a function module of a function group, a
 * CDS entity of its view, an enhancement's part) counts for its owner. Anything the stamps can't
 * vouch for is a full pull: no stamps yet, an object new or gone in the search, a move, or a
 * changed hit that belongs to no mirrored object. Mirrored objects without a stamp are re-read
 * on every fetch, best effort (G5b: an object adt-ls can't find by name is skipped, not a reason
 * for a full pull).
 */

export type FetchPlan = { full: string } | { objects: string[]; bestEffort: string[] };

const nameOf = (key: string) => key.slice(key.indexOf(' ') + 1);

/** Search keys (`CLAS/OC ZCL_X`) by the mirror ids they can stand for: `CLAS ZCL_X`, or `DTELDE ZDE_X` for `DTEL/DE`. */
export function idsOfKeys(keys: Iterable<string>): Map<string, string> {
  const byId = new Map<string, string>();
  for (const key of keys) {
    const [main = '', sub = ''] = key.slice(0, key.indexOf(' ')).split('/');
    const name = nameOf(key);
    byId.set(`${main} ${name}`, key);
    if (sub) byId.set(`${main}${sub} ${name}`, key);
  }
  return byId;
}

/** URIs whose path names the owning object: the owner's type and the path segment holding its name. */
const OWNER_PATHS: Array<{ path: RegExp; type?: string }> = [
  // A function module: `/functions/groups/<group>/fmodules/<module>`.
  { path: /\/functions\/groups\/([^/]+)\/fmodules\//, type: 'FUGR' },
  // A CDS entity (`STOB/DO`): `/ddic/ddl/sources/<view>/source/main`.
  { path: /\/ddic\/ddl\/sources\/([^/]+)\//, type: 'DDLS' },
  // An enhancement's part: `/enhancements/<type>/<name>`, owned by the enhancement of that name.
  { path: /\/enhancements\/[^/]+\/([^/#?]+)/ },
];

/**
 * The mirrored object a search hit stands for or belongs to, if any: the same name and the main
 * type (or main and subtype joined, or a mirror type that the joined type starts with, as
 * `ENHOXH` for `ENHO/XHB`), else the owner its URI names.
 */
export function ownerOf(key: string, uri: string | undefined, mirrored: Set<string>): string | undefined {
  const [main = '', sub = ''] = key.slice(0, key.indexOf(' ')).split('/');
  const name = nameOf(key);
  for (const type of [main, `${main}${sub}`]) if (mirrored.has(`${type} ${name}`)) return `${type} ${name}`;
  const joined = `${main}${sub}`;
  for (const id of mirrored) {
    const t = id.slice(0, id.indexOf(' '));
    if (nameOf(id) === name && t.length > main.length && joined.startsWith(t)) return id;
  }
  for (const rule of OWNER_PATHS) {
    const owner = uri?.match(rule.path)?.[1]?.toUpperCase();
    if (!owner) continue;
    const decoded = decodeURIComponent(owner);
    if (rule.type) return mirrored.has(`${rule.type} ${decoded}`) ? `${rule.type} ${decoded}` : undefined;
    for (const id of mirrored) if (nameOf(id) === decoded && id.startsWith(main)) return id;
  }
  return undefined;
}

const names = (keys: string[]) => (keys.length > 3 ? `${keys.slice(0, 3).join(', ')} and ${keys.length - 3} more` : keys.join(', '));

export function planFetch(
  previous: Stamps | undefined,
  now: Stamps,
  mirrored: string[],
  exceeded = false,
  uris: Record<string, string> = {},
): FetchPlan {
  if (exceeded) return { full: 'the package search found more objects than the ceiling' };
  if (!previous) return { full: 'no change stamps from an earlier fetch' };
  const added = Object.keys(now).filter((k) => !(k in previous));
  const gone = Object.keys(previous).filter((k) => !(k in now));
  if (added.length > 0) return { full: `new on the system: ${names(added)}` };
  if (gone.length > 0) return { full: `gone from the system: ${names(gone)}` };
  // A move between packages (the stamp starts with the package): a local `$` object's re-read can't see it.
  const moved = Object.keys(now).filter((k) => {
    const [a, b] = [previous[k], now[k]];
    return a && b && a.split(' ')[0] !== b.split(' ')[0];
  });
  if (moved.length > 0) return { full: `moved to another package: ${names(moved)}` };

  const ids = new Set(mirrored);
  const changed = new Set<string>();
  /** Mirrored objects one of their own hits stamps. */
  const stamped = new Set<string>();
  const orphans: string[] = [];
  for (const key of Object.keys(now)) {
    if (key.startsWith('DEVC/')) continue;
    const owner = ownerOf(key, uris[key], ids);
    // Its own hit (same name, the type or a longer form of it), not a part found through the URI.
    const direct = owner !== undefined && nameOf(owner) === nameOf(key);
    if (owner && direct && now[key] !== null) stamped.add(owner);
    if (now[key] === previous[key]) continue;
    if (owner) changed.add(owner);
    else orphans.push(key);
  }
  if (orphans.length > 0) return { full: `changed, and no mirrored object: ${names(orphans)}` };
  // No stamp vouches for them: read every time, best effort.
  const bestEffort = mirrored.filter((id) => !stamped.has(id) && !changed.has(id)).sort();
  return { objects: [...changed].sort(), bestEffort };
}
