import { describe, expect, it } from 'vitest';
import { RawAdtError, RawAdtTimeoutError, type RawAdtClient } from '../../src/backends/rawadt.js';
import { componentPackages } from '../../src/mirror/component.js';

interface Pkg {
  type?: string;
  superPackage?: string;
  component: string;
}

/** Packages by name, and the search's hits per component (`<package>` per object). */
function restOver(packages: Record<string, Pkg>, objects: Record<string, string[]>, opts: { failRead?: string; homeError?: boolean; timeout?: string[]; endsLoop?: string } = {}) {
  const calls: string[] = [];
  const pkgXml = (name: string, p: Pkg) =>
    `<pak:package adtcore:name="${name}" adtcore:type="DEVC/K"><pak:attributes pak:packageType="${p.type ?? 'development'}"/>` +
    `<pak:superPackage${p.superPackage ? ` adtcore:name="${p.superPackage}"` : ''}/>` +
    `<pak:transport><pak:softwareComponent pak:name="${p.component}"/></pak:transport></pak:package>`;
  const request = async (_method: string, path: string, o: { query?: Record<string, string> } = {}) => {
    calls.push(o.query?.comp ? `search ${o.query.comp} ${o.query.maxResults}` : path);
    const pkg = path.match(/^\/sap\/bc\/adt\/packages\/([^/]+)$/);
    if (pkg) {
      const name = decodeURIComponent(pkg[1]!).toUpperCase();
      if (name === opts.failRead) return { status: 500, headers: new Headers(), body: 'boom' };
      if (opts.timeout?.includes(name)) throw new RawAdtTimeoutError('GET', path, 120_000);
      if (opts.endsLoop === name) throw new RawAdtTimeoutError('GET', path, 120_000, undefined, true);
      // ONPREM answers a name that is no package (HOME) with an exception body, not a 404.
      if (opts.homeError && name === 'HOME') return { status: 500, headers: new Headers(), body: '<exc:exception>ExceptionResourceNotFound</exc:exception>' };
      const p = packages[name];
      return p ? { status: 200, headers: new Headers(), body: pkgXml(name, p) } : { status: 404, headers: new Headers(), body: '' };
    }
    const comp = o.query!.comp!;
    // `DEVC:<name>@<package>`: a package's own hit, naming the package it reports.
    const refs = (objects[comp] ?? []).slice(0, Number(o.query!.maxResults)).map((entry, i) => {
      const devc = entry.match(/^DEVC:(.+)@(.*)$/);
      return devc
        ? `<adtcore:objectReference adtcore:uri="/x/${i}" adtcore:type="DEVC/K" adtcore:name="${devc[1]}" adtcore:packageName="${devc[2]}"/>`
        : `<adtcore:objectReference adtcore:uri="/x/${i}" adtcore:type="PROG/P" adtcore:name="Z${i}" adtcore:packageName="${entry}"/>`;
    });
    return { status: 200, headers: new Headers(), body: `<adtcore:objectReferences>${refs.join('')}</adtcore:objectReferences>` };
  };
  const rest = {
    request,
    expectOk: async (method: string, path: string, context: string, o: { query?: Record<string, string> } = {}) => {
      const res = await request(method, path, o);
      if (res.status >= 400) throw new RawAdtError(res.status, undefined, res.body, context);
      return res;
    },
  } as unknown as RawAdtClient;
  return { deps: { withRest: <T>(fn: (r: RawAdtClient) => Promise<T>) => fn(rest), concurrency: 3 }, calls };
}

describe('swc.packages: a software component\'s root packages', () => {
  it('ABAP Cloud: a structure package of the component\'s name is its own root, 1 request', async () => {
    const { deps, calls } = restOver({ ZLOCAL: { type: 'structure', component: 'ZLOCAL' } }, {});
    const r = await componentPackages(deps, {}, { system: 'DEV', component: 'zlocal' });
    expect(r).toMatchObject({ from: 'structure-package', roots: ['ZLOCAL'], dropped: [], objects: null, exceeded: false, units: 1 });
    expect(calls).toEqual(['/sap/bc/adt/packages/zlocal']);
  });

  it('on-premise: the objects\' packages from one search, the roots from their super packages', async () => {
    const { deps, calls } = restOver(
      {
        ZT1_A: { superPackage: 'ZT1', component: 'ZT1_DEV' },
        ZT1_A_SUB: { superPackage: 'ZT1_A', component: 'ZT1_DEV' },
        ZT1_B: { superPackage: 'ZT1', component: 'ZT1_DEV' },
        // In the hits, but another component's: neither a root nor a reason to drop its subpackage.
        ZOTHER: { component: 'HOME' },
        ZT1_C: { superPackage: 'ZOTHER', component: 'ZT1_DEV' },
        '/NA2/X': { component: 'ZT1_DEV' },
      },
      { ZT1_DEV: ['ZT1_A', 'ZT1_A_SUB', 'ZT1_A_SUB', 'ZT1_B', 'ZOTHER', 'ZT1_C', '/NA2/X', ''] },
      { homeError: true },
    );
    const r = await componentPackages(deps, { maxObjects: 10 }, { system: 'DEV', component: 'ZT1_DEV' });
    expect(r).toMatchObject({
      from: 'search',
      roots: ['ZT1_A', 'ZT1_B', 'ZT1_C'],
      dropped: ['/NA2/X'],
      packages: ['/NA2/X', 'ZT1_A', 'ZT1_A_SUB', 'ZT1_B', 'ZT1_C'],
      objects: 8,
      exceeded: false,
    });
    // The component's name, the search (ceiling 10 → 140 results), one read per package, then the
    // super packages up to the top (ZT1, which doesn't exist).
    expect(calls[1]).toBe('search ZT1_DEV 140');
    expect(r.units).toBe(2 + 6 + 1);
    // A namespace the system lists is a root like any other.
    const listed = await componentPackages(deps, { maxObjects: 10, namespaces: ['/NA2/'] }, { system: 'DEV', component: 'ZT1_DEV' });
    expect(listed.roots).toEqual(['/NA2/X', 'ZT1_A', 'ZT1_B', 'ZT1_C']);
  });

  it('a package of the component under a foreign package under one of its roots is no second root', async () => {
    const { deps } = restOver(
      {
        ZT1_A: { component: 'ZT1_DEV' },
        ZFOREIGN: { superPackage: 'ZT1_A', component: 'HOME' },
        ZT1_C: { superPackage: 'ZFOREIGN', component: 'ZT1_DEV' },
      },
      { ZT1_DEV: ['ZT1_A', 'ZT1_C'] },
    );
    expect((await componentPackages(deps, {}, { system: 'DEV', component: 'ZT1_DEV' })).roots).toEqual(['ZT1_A']);
  });

  it('a top package outside the root-package rule: its mirrorable subpackages are the roots', async () => {
    const { deps } = restOver(
      {
        '/ABC/TOP': { component: 'ABC' },
        ZABC_A: { superPackage: '/ABC/TOP', component: 'ABC' },
        ZABC_A_SUB: { superPackage: 'ZABC_A', component: 'ABC' },
        ZABC_B: { superPackage: '/ABC/TOP', component: 'ABC' },
      },
      { ABC: ['/ABC/TOP', 'ZABC_A_SUB', 'ZABC_B', 'DEVC:ZABC_A@/ABC/TOP'] },
    );
    const r = await componentPackages(deps, {}, { system: 'DEV', component: 'ABC' });
    // ZABC_A has no object of its own: its own hit, which names its super package, still counts.
    expect(r).toMatchObject({ roots: ['ZABC_A', 'ZABC_B'], dropped: ['/ABC/TOP'] });
  });

  it('ONPREM\'s HOME (no package of that name) goes to the search', async () => {
    const { deps } = restOver({ ZADTPLUS_A: { superPackage: '$TMP', component: 'HOME' } }, { HOME: ['ZADTPLUS_A'] }, { homeError: true });
    expect((await componentPackages(deps, {}, { system: 'DEV', component: 'HOME' })).roots).toEqual(['ZADTPLUS_A']);
  });

  it('above the ceiling: no package read, the count it reached named', async () => {
    const { deps, calls } = restOver({ ZADTPLUS_A: { component: 'HOME' } }, { HOME: Array.from({ length: 200 }, () => 'ZADTPLUS_A') });
    // Ceiling 1: the search stops at 104 (×4 + 100, the headroom for includes and packages).
    const r = await componentPackages(deps, { maxObjects: 1 }, { system: 'DEV', component: 'HOME' });
    expect(r).toMatchObject({ exceeded: true, roots: [], objects: 104 });
    expect(calls.some((c) => c.includes('/packages/zadtplus_a'))).toBe(false);
    // The call's own ceiling wins over the system's.
    expect((await componentPackages(deps, { maxObjects: 1 }, { system: 'DEV', component: 'HOME', maxObjects: 30 })).roots).toEqual(['ZADTPLUS_A']);
  });

  it('a package that doesn\'t read fails the call: its place in the tree is unknown', async () => {
    const { deps } = restOver(
      { ZT1_A: { component: 'ZT1_DEV' }, ZT1_B: { superPackage: 'ZT1_A', component: 'ZT1_DEV' } },
      { ZT1_DEV: ['ZT1_A', 'ZT1_B'] },
      { failRead: 'ZT1_B' },
    );
    await expect(componentPackages(deps, {}, { system: 'DEV', component: 'ZT1_DEV' })).rejects.toThrow(/packages of ZT1_DEV not read: ZT1_B: /);
  });

  it('a package SAP doesn\'t answer is that package\'s failure; a timeout that ends loops ends the call before the rest is read', async () => {
    const packages = Object.fromEntries(['ZT1_A', 'ZT1_B', 'ZT1_C', 'ZT1_D', 'ZT1_E'].map((n) => [n, { component: 'ZT1_DEV' }]));
    const hits = { ZT1_DEV: Object.keys(packages) };
    const one = restOver(packages, hits, { timeout: ['ZT1_C'] });
    await expect(componentPackages(one.deps, {}, { system: 'DEV', component: 'ZT1_DEV' })).rejects.toThrow(/packages of ZT1_DEV not read: ZT1_C: GET .* got no answer/);
    expect(one.calls).toContain('/sap/bc/adt/packages/zt1_e');

    const two = restOver(packages, hits, { timeout: ['ZT1_A'], endsLoop: 'ZT1_B' });
    await expect(componentPackages(two.deps, {}, { system: 'DEV', component: 'ZT1_DEV' })).rejects.toThrow(/SAP has likely stopped answering/);
    // The worker whose package answered may already have started the next one; nothing after it starts.
    expect(two.calls).not.toContain('/sap/bc/adt/packages/zt1_e');
  });
});
