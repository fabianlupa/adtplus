import { RawAdtError, endsLoop, type RawAdtClient } from '../backends/rawadt.js';
import { readPackageDefinition, type PackageDefinition } from '../capabilities/package.js';
import { ThrottledError } from '../daemon/ratelimit.js';
import { parseHits, shortMessage } from './changes.js';
import { isMirrorablePackage } from './layout.js';
import { DEFAULT_MAX_OBJECTS, type MirrorPolicy } from './pull.js';

/**
 * `swc.packages` (docs/decisions/011-git-remote-helper.md, G4): the root packages of a software
 * component, which a clone of `adtplus::<system>/swc/<SWC>` mirrors with their subpackages.
 *
 * - ABAP Cloud: a software component is a structure package of the same name (P2), so it is its
 *   own root: 1 request.
 * - On-premise: adt-ls's search refuses every filter (P2), so the REST info-system search
 *   `comp=<SWC>` lists the component's objects, packages among them, each with its package; one
 *   package read each (and of a foreign super package between two of them) then names the roots.
 *   A REST fallback (ADR-002) until adt-ls searches by component. The search is bounded by the
 *   object ceiling: a component that spans the whole customer namespace never runs unbounded.
 */

export interface ComponentInput {
  system: string;
  component: string;
  /** Overrides `mirror.maxObjects` for this call. */
  maxObjects?: number;
}

export interface ComponentResult {
  via: 'rest-fallback';
  /** Always null: no probe tells whether adt-ls searches by component (ADR-002). */
  nativeAvailable: null;
  component: string;
  /** A structure package of the component's name, or the objects' search. */
  from: 'structure-package' | 'search';
  /** Root packages a clone mirrors with their subpackages, sorted. */
  roots: string[];
  /** Top packages the root-package rule leaves out (`Z`/`Y`/`$`/`mirror.namespaces`); their mirrorable subpackages are roots instead. */
  dropped: string[];
  /** Every package of the component the search found, sorted: tells a root that moved under another from one that left. */
  packages: string[];
  /** Objects the search found (packages included); null for a structure package. */
  objects: number | null;
  /** The search found more than the ceiling allows: no roots were read. */
  exceeded: boolean;
  units: number;
  ms: number;
}

export interface ComponentDeps {
  withRest: <T>(fn: (rest: RawAdtClient) => Promise<T>) => Promise<T>;
  /** The bulk lane's REST requests in flight. */
  concurrency: number;
}

const SEARCH = '/sap/bc/adt/repository/informationsystem/search';

/** A logon refused, the rate limit, or SAP no longer answering (`endsLoop`): ends the call. Anything else is the package's own failure. */
function fatal(err: unknown): boolean {
  return err instanceof ThrottledError || (err instanceof RawAdtError && err.isAuthFailure) || endsLoop(err);
}

/** Max steps up a super-package chain: deeper than any real tree, a guard against a cycle. */
const MAX_DEPTH = 50;

/**
 * The roots of a component's packages, by name (upper case) → definition, `all` holding foreign
 * super packages too: a mirrorable package with no mirrorable package of the component above it,
 * since a root's walk takes every subpackage. A top package the rule leaves out is `dropped`, its
 * mirrorable subpackages become roots.
 */
export function rootsOf(
  component: Set<string>,
  all: Map<string, PackageDefinition>,
  mirrorable: (name: string) => boolean,
): { roots: string[]; dropped: string[] } {
  const ancestors = (name: string) => {
    const up: string[] = [];
    for (let at = all.get(name)?.superPackage.toUpperCase(); at && up.length < MAX_DEPTH; at = all.get(at)?.superPackage.toUpperCase()) up.push(at);
    return up.filter((a) => component.has(a));
  };
  const roots: string[] = [];
  const dropped: string[] = [];
  for (const name of [...component].sort()) {
    const above = ancestors(name);
    if (!mirrorable(name)) {
      if (above.length === 0) dropped.push(name);
    } else if (!above.some(mirrorable)) roots.push(name);
  }
  return { roots, dropped };
}

export async function componentPackages(deps: ComponentDeps, policy: MirrorPolicy, input: ComponentInput): Promise<ComponentResult> {
  const started = Date.now();
  const component = input.component.toUpperCase();
  const maxObjects = input.maxObjects ?? policy.maxObjects ?? DEFAULT_MAX_OBJECTS;
  // The search lists more than the walk (function-group includes, packages): headroom over the ceiling.
  const maxResults = maxObjects * 4 + 100;
  let units = 0;
  const mirrorable = (name: string) => isMirrorablePackage(name, policy.namespaces);
  const result = (fields: Pick<ComponentResult, 'from' | 'roots' | 'dropped' | 'packages' | 'objects' | 'exceeded'>): ComponentResult => ({
    via: 'rest-fallback',
    nativeAvailable: null,
    component,
    ...fields,
    units,
    ms: Date.now() - started,
  });

  return deps.withRest(async (rest) => {
    units += 1;
    let own: PackageDefinition | undefined;
    try {
      own = await readPackageDefinition(rest, component);
    } catch (err) {
      // An on-premise system may answer a name that is no package with an error body, not a 404.
      if (fatal(err)) throw err;
    }
    if (own?.packageType === 'structure' && own.softwareComponent.toUpperCase() === component) {
      const root = mirrorable(component);
      return result({ from: 'structure-package', roots: root ? [component] : [], dropped: root ? [] : [component], packages: [component], objects: null, exceeded: false });
    }

    units += 1;
    // A RawAdtError, so the session's re-logon sees a 401 (ADR-001).
    const res = await rest.expectOk('GET', SEARCH, `search software component ${component}`, {
      query: { operation: 'quickSearch', query: '*', maxResults: String(maxResults), comp: component },
      headers: { Accept: 'application/xml' },
    });
    const hits = parseHits(res.body);
    if (hits.length >= maxResults) return result({ from: 'search', roots: [], dropped: [], packages: [], objects: hits.length, exceeded: true });
    // Each object's package, and a package's own hit for a package without objects.
    const named = hits.flatMap((h) => [h.package, ...(h.key.startsWith('DEVC/') ? [h.key.slice(h.key.indexOf(' ') + 1)] : [])]);

    const all = new Map<string, PackageDefinition>();
    /** Read these packages, the bulk lane's REST requests in flight at once; the names that failed, with why. */
    const readAll = async (names: string[]): Promise<string[]> => {
      const queue = [...new Set(names.filter((n) => n !== '' && !all.has(n)))].sort();
      const failed: string[] = [];
      let stop: unknown;
      await Promise.all(
        Array.from({ length: Math.min(Math.max(1, deps.concurrency), queue.length) }, async () => {
          for (let name = queue.shift(); name !== undefined && stop === undefined; name = queue.shift()) {
            units += 1;
            try {
              const d = await readPackageDefinition(rest, name);
              if (d) all.set(name, d);
            } catch (err) {
              if (fatal(err)) {
                stop ??= err;
                return;
              }
              failed.push(`${name}: ${shortMessage(err)}`);
            }
          }
        }),
      );
      if (stop !== undefined) throw stop;
      return failed;
    };
    // A package of the component whose place in the tree is unknown could be a root or inside one: no guess.
    const failed = await readAll(named);
    if (failed.length > 0) throw new Error(`packages of ${component} not read: ${failed.slice(0, 5).join('; ')}`);
    const inComponent = new Set([...all.values()].filter((d) => d.softwareComponent.toUpperCase() === component).map((d) => d.name.toUpperCase()));
    // Foreign super packages up to the top, so a package of the component under another one's tree is
    // no second root. One that doesn't read ends its chain there.
    const unreadable = new Set<string>();
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const up = [...all.values()].map((d) => d.superPackage.toUpperCase()).filter((p) => p !== '' && !all.has(p) && !unreadable.has(p));
      if (up.length === 0) break;
      for (const f of await readAll(up)) unreadable.add(f.slice(0, f.indexOf(':')));
      for (const p of up) if (!all.has(p)) unreadable.add(p);
    }
    const { roots, dropped } = rootsOf(inComponent, all, mirrorable);
    return result({ from: 'search', roots, dropped, packages: [...inComponent].sort(), objects: hits.length, exceeded: false });
  });
}
