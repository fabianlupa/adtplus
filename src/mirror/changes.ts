import { RawAdtError, decodeXml, endsLoop, type RawAdtClient } from '../backends/rawadt.js';
import type { DaemonProgress } from '../daemon/protocol.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { resolveRoot } from './layout.js';
import { loadManifest } from './manifest.js';
import { DEFAULT_MAX_OBJECTS, type MirrorLocation, type MirrorPolicy } from './pull.js';

/**
 * `mirror changes` (docs/decisions/011-git-remote-helper.md, "Fetch"; G5): a change stamp per
 * object of a mirror's packages, from `adtcore:changedAt` in each object's REST metadata (a class
 * carries one per include; a function group's includes, from its object structure, are read one
 * by one, since the group's own date doesn't move when one changes). A class, program or function
 * group adds its text elements' etags: a text-only edit moves no date at all, neither the object's
 * nor the text elements' own. All parts come from the system, not the manifest, so the stamps a
 * clone takes before its first pull are complete. adt-ls has no change dates or ETags (ADR-007), so this is a REST
 * fallback (ADR-002) until it has. A caller keeps the stamps and re-reads only the objects whose
 * stamp moved.
 *
 * The objects come from the repository information system's search (one request per root
 * package; `packageName` takes subpackages along), so a stamp's key is the search's
 * `<type> <name>` (`CLAS/OC ZCL_X`), not the mirror's object id.
 */

export interface ChangesInput extends MirrorLocation {
  system: string;
  /** Overrides `mirror.maxObjects` for this call. */
  maxObjects?: number;
}

export interface ChangesResult {
  via: 'rest-fallback';
  /** true once adt-ls offers change dates natively: the fallback is retirable (ADR-002). */
  nativeAvailable: boolean | null;
  /** Per search hit, `<type> <name>`: its `changedAt` values joined, or null when its metadata didn't read. */
  stamps: Record<string, string | null>;
  /** Per hit, its package (upper case). */
  packages: Record<string, string>;
  /** Per hit, its ADT URI without the fragment: tells a part (a function module, a CDS entity) which object it belongs to. */
  uris: Record<string, string>;
  /** The search found more than the ceiling: no stamps were read, a full pull is due. */
  exceeded: boolean;
  /** Hits whose metadata failed to read, with the reason. */
  failed: Array<{ key: string; message: string }>;
  units: number;
  ms: number;
}

/** What `changes` runs with: the system's REST client, its requests in the rate limit's bulk lane (ADR-008). */
export interface ChangesDeps {
  withRest: <T>(fn: (rest: RawAdtClient) => Promise<T>) => Promise<T>;
  /** The bulk lane's REST requests in flight. */
  concurrency: number;
  /** The native-support probe's answer, when it ran. */
  native?: boolean;
  /** Objects stamped so far, after each one. */
  progress?: (p: DaemonProgress) => void;
}

const SEARCH = '/sap/bc/adt/repository/informationsystem/search';

interface Hit {
  key: string;
  uri: string;
  package: string;
}

/** The search's object references: `<adtcore:objectReference adtcore:uri=… adtcore:type=… …/>`. */
export function parseHits(xml: string): Hit[] {
  const hits: Hit[] = [];
  // Attribute values may hold an unescaped `>`: skip quoted values whole.
  for (const [, attrs = ''] of xml.matchAll(/<adtcore:objectReference\b((?:[^>"]|"[^"]*")*?)\/?>/g)) {
    const attr = (name: string) => {
      const v = attrs.match(new RegExp(`adtcore:${name}="([^"]*)"`))?.[1];
      return v === undefined ? undefined : decodeXml(v);
    };
    const uri = attr('uri');
    const type = attr('type');
    const name = attr('name');
    if (!uri || !type || !name) continue;
    hits.push({ key: `${type} ${name.toUpperCase()}`, uri: uri.split('#')[0]!, package: (attr('packageName') ?? '').toUpperCase() });
  }
  return hits;
}

/** One line for a failed metadata read: an HTML error page (ENHO answers 500 with one) is just its status. */
export function shortMessage(err: unknown): string {
  if (err instanceof RawAdtError && /<!DOCTYPE|<html/i.test(err.sapMessage ?? '')) return `HTTP ${err.status}`;
  const text = (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** Where the text elements of a hit's object type live (`/sap/bc/adt/textelements/<path>/<name>`). */
const TEXT_ELEMENTS: Record<string, string> = { 'CLAS/OC': 'classes', 'PROG/P': 'programs', 'FUGR/F': 'functiongroups' };

/**
 * The etag of each part of a text-elements body (`symbols:<etag>`), which moves with the texts. A
 * body with none is an error, never an empty stamp that would miss every text edit from then on.
 */
export function textEtags(xml: string): string {
  const parts: string[] = [];
  for (const [, attrs = '', body = ''] of xml.matchAll(/<rept:subobject\b([^>]*)>(.*?)<\/rept:subobject>/gs)) {
    const name = attrs.match(/adtcore:name="([^"]*)"/)?.[1];
    const etag = body.match(/\betag="([^"]*)"/)?.[1];
    if (name && etag) parts.push(`${name}:${etag}`);
  }
  if (parts.length === 0) throw new Error('text elements without an etag');
  return parts.join(',');
}

/**
 * The group's own includes (`FUGR/I`) its object structure lists, sorted: `L<group>` and three
 * characters (`TOP`, `UXX`, `F01`), `/NS/L<rest>…` for a namespaced group. The structure lists every
 * include the group uses, SAP's too (a maintenance group's `LSVIM…`), which aren't part of it, nor
 * is another group's whose name starts with this one's.
 */
export function structureIncludes(xml: string, group: string): string[] {
  const own = (group.startsWith('/') ? group.replace(/^(\/[^/]+\/)/, '$1L') : `L${group}`).toUpperCase();
  const names = new Set<string>();
  for (const [, attrs = ''] of xml.matchAll(/<abapsource:objectStructureElement\b([^>]*)>/g)) {
    if (!/adtcore:type="FUGR\/I"/.test(attrs)) continue;
    const name = decodeXml(attrs.match(/adtcore:name="([^"]*)"/)?.[1] ?? '');
    if (name.length === own.length + 3 && name.toUpperCase().startsWith(own)) names.add(name);
  }
  return [...names].sort();
}

/** Every `adtcore:changedAt` of a metadata body, in order: the object's and, for a class, each include's. */
export function stampOf(xml: string): string {
  return [...xml.matchAll(/adtcore:changedAt="([^"]*)"/g)].map(([, at]) => at).join(',');
}

export async function changes(deps: ChangesDeps, policy: MirrorPolicy, input: ChangesInput): Promise<ChangesResult> {
  const started = Date.now();
  const root = await resolveRoot(input.root, input.workspaceFolders);
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error(`no mirror at ${root}; run \`mirror init\` first`);
  if (manifest.system !== input.system) throw new Error(`${root} mirrors system "${manifest.system}", not "${input.system}"`);
  const maxObjects = input.maxObjects ?? policy.maxObjects ?? DEFAULT_MAX_OBJECTS;
  // The search lists more than the walk (function-group includes, packages): headroom over the ceiling.
  const maxResults = maxObjects * 4 + 100;
  const workers = Math.max(1, deps.concurrency);
  let units = 0;
  const result = (fields: Pick<ChangesResult, 'stamps' | 'packages' | 'uris' | 'exceeded' | 'failed'>): ChangesResult => ({
    via: 'rest-fallback',
    nativeAvailable: deps.native ?? null,
    ...fields,
    units,
    ms: Date.now() - started,
  });

  return deps.withRest(async (rest) => {
    const hits: Hit[] = [];
    for (const p of manifest.packages) {
      units += 1;
      // A RawAdtError, so the session's re-logon sees a 401 (ADR-001).
      const res = await rest.expectOk('GET', SEARCH, `search package ${p.name}`, {
        query: { operation: 'quickSearch', query: '*', maxResults: String(maxResults), packageName: p.name },
        headers: { Accept: 'application/xml' },
      });
      const found = parseHits(res.body);
      if (found.length >= maxResults) return result({ stamps: {}, packages: {}, uris: {}, exceeded: true, failed: [] });
      // `packageName` takes subpackages along; without them, only the package's own objects.
      hits.push(...(p.subpackages ? found : found.filter((h) => h.package === p.name.toUpperCase())));
    }

    const stamps: Record<string, string | null> = {};
    const packages: Record<string, string> = {};
    const uris: Record<string, string> = {};
    const failed: ChangesResult['failed'] = [];
    const queue = hits.filter((hit) => {
      if (hit.key in packages) return false;
      packages[hit.key] = hit.package;
      uris[hit.key] = hit.uri;
      return true;
    });
    const total = queue.length;
    let done = 0;
    const step = () => deps.progress?.({ stage: 'stamps', done, total, units });
    step();
    let stop: unknown;
    await Promise.all(
      Array.from({ length: Math.min(workers, queue.length) }, async () => {
        for (let hit = queue.shift(); hit && stop === undefined; hit = queue.shift()) {
          // A package's own stamp is never compared (`git/incremental.ts`), only whether it is there.
          if (hit.key.startsWith('DEVC/')) {
            stamps[hit.key] = 'package';
            done++;
            step();
            continue;
          }
          const type = hit.key.slice(0, hit.key.indexOf(' '));
          const name = hit.key.slice(type.length + 1);
          units += 1;
          try {
            const res = await rest.expectOk('GET', hit.uri, `read ${hit.key}`);
            /** Another part of the object; gone on the system (404) is a mark of its own, so the stamp moves. */
            const part = (uri: string, what: string, read: (body: string) => string) =>
              rest.expectOk('GET', uri, `read ${hit.key} ${what}`).then(
                (r) => read(r.body),
                (err: unknown) => {
                  if (err instanceof RawAdtError && err.status === 404) return '-';
                  throw err;
                },
              );
            // A group's includes, as the system lists them: the group's own date doesn't move when one changes.
            let includes: string[] = [];
            if (type === 'FUGR/F') {
              units += 1;
              const structure = await rest.expectOk('GET', `${hit.uri}/objectstructure`, `read ${hit.key} structure`, {
                headers: { Accept: 'application/vnd.sap.adt.objectstructure.v2+xml' },
              });
              includes = structureIncludes(structure.body, name);
            }
            // A text-only edit moves no date, only the text elements' etags.
            const texts = TEXT_ELEMENTS[type];
            units += includes.length + (texts ? 1 : 0);
            // At once: the rate limit's bulk lane still bounds the calls in flight.
            const parts = await Promise.all([
              ...includes.map(async (include) => {
                const uri = `${hit!.uri}/includes/${encodeURIComponent(include.toLowerCase())}`;
                return `${include}=${await part(uri, `include ${include}`, stampOf)}`;
              }),
              ...(texts ? [part(`/sap/bc/adt/textelements/${texts}/${encodeURIComponent(name.toLowerCase())}`, 'text elements', textEtags).then((t) => `texts=${t}`)] : []),
            ]);
            const own = stampOf(res.body);
            stamps[hit.key] = own ? [own, ...parts].join(',') : null;
          } catch (err) {
            // A rejected logon, the rate limit or SAP no longer answering ends the call; anything else costs this hit its stamp.
            if (endsLoop(err) || err instanceof ThrottledError || (err instanceof RawAdtError && err.isAuthFailure)) {
              stop ??= err;
              return;
            }
            stamps[hit.key] = null;
            failed.push({ key: hit.key, message: shortMessage(err) });
          }
          done++;
          step();
        }
      }),
    );
    if (stop !== undefined) throw stop;
    return result({ stamps, packages, uris, exceeded: false, failed });
  });
}
