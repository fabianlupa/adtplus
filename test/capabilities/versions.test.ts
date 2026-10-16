import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it } from 'vitest';
import { RawAdtError, type RawAdtClient } from '../../src/backends/rawadt.js';
import { diffVersions, feedOfFile, isVersionNumber, listVersions, readVersion } from '../../src/capabilities/versions.js';

// Shapes trimmed from ONPREM's version feeds (2026-10-12).
const FAIL = '<fail>';
const TREE = 'abap:/repotree-v1/DEV_100_X_EN/System%20Library/ZPKG';

function feedXml(entries: Array<{ id: string; request?: string; updated?: string; content?: string }>): string {
  return (
    '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:adtcore="http://www.sap.com/adt/core">' +
    entries
      .map(
        (e) =>
          `<atom:entry><atom:author><atom:name>DEV-A</atom:name></atom:author><atom:id>${e.id}</atom:id>` +
          `<atom:updated>${e.updated ?? '2026-10-07T07:38:21Z'}</atom:updated>` +
          (e.content ? `<atom:content type="text/plain" src="${e.content}"/>` : '') +
          (e.request
            ? `<atom:link href="/x" rel="http://www.sap.com/adt/relations/transport/request" adtcore:name="${e.request}" ` +
              'type="application/vnd.sap.adt.transportrequests.v1+xml" title="Trip &amp; app"/>'
            : '') +
          '</atom:entry>',
      )
      .join('') +
    '</atom:feed>'
  );
}

function fakeRest(routes: Record<string, string>): RawAdtClient & { paths: string[] } {
  const paths: string[] = [];
  const request = async (_method: string, path: string) => {
    paths.push(path);
    const body = routes[path];
    return { status: body === undefined ? 404 : body === FAIL ? 500 : 200, headers: new Headers(), body: body ?? '' };
  };
  return {
    paths,
    request,
    expectOk: async (method: string, path: string, context: string) => {
      const res = await request(method, path);
      if (res.status >= 400) throw new RawAdtError(res.status, undefined, 'not found', context);
      return res;
    },
  } as unknown as RawAdtClient & { paths: string[] };
}

function deps(uri: string, rest: RawAdtClient) {
  const adt = { lifecycle: { resolveAffUri: async () => uri } } as unknown as AdtLsClient;
  return { adt, withRest: <T>(fn: (r: RawAdtClient) => Promise<T>) => fn(rest) };
}

const CLASS_URI = `${TREE}/Source%20Code%20Library/Classes/ZCL_X/zcl_x.clas.abap`;
const CLS = '/sap/bc/adt/oo/classes/zcl_x/includes';

describe('feedOfFile', () => {
  it('finds the feed from the AFF file name, a group from its module or include', () => {
    expect(feedOfFile(CLASS_URI)).toBe(`${CLS}/main/versions`);
    expect(feedOfFile(`${TREE}/x/zcl_x.clas.testclasses.abap`)).toBe(`${CLS}/testclasses/versions`);
    expect(feedOfFile(`${TREE}/x/zfg.fugr.z_fm.func.abap`)).toBe('/sap/bc/adt/functions/groups/zfg/fmodules/z_fm/source/main/versions');
    expect(feedOfFile(`${TREE}/x/zfg.fugr.lzfgtop.reps.abap`)).toBe('/sap/bc/adt/functions/groups/zfg/includes/lzfgtop/source/main/versions');
    expect(feedOfFile(`${TREE}/x/zfg.fugr.saplzfg.reps.abap`)).toBe('/sap/bc/adt/functions/groups/zfg/source/main/versions');
    expect(feedOfFile(`${TREE}/x/%28ns%29fg.fugr.%28ns%29saplfg.reps.abap`)).toBe('/sap/bc/adt/functions/groups/%2Fns%2Ffg/source/main/versions');
    expect(feedOfFile(`${TREE}/x/zi_x.ddls.acds`)).toBe('/sap/bc/adt/ddic/ddl/sources/zi_x/versions');
    expect(feedOfFile(`${TREE}/x/zinc.prog.abap`)).toBe('/sap/bc/adt/programs/programs/zinc/source/main/versions');
  });

  it('has none for a type without a source feed', () => {
    expect(feedOfFile(`${TREE}/x/zsb.srvb.json`)).toBeUndefined();
    expect(feedOfFile(`${TREE}/x/zpkg.devck.jsonc`)).toBeUndefined();
  });
});

describe('isVersionNumber', () => {
  it('takes released numbers only', () => {
    expect(isVersionNumber('00001')).toBe(true);
    expect(isVersionNumber('00000')).toBe(false);
    expect(isVersionNumber('99999')).toBe(false);
    expect(isVersionNumber('1')).toBe(false);
    expect(isVersionNumber(undefined)).toBe(false);
  });
});

describe('listVersions', () => {
  it("lists a class's main source and every include, each the draft, active, then released newest first", async () => {
    const rest = fakeRest({
      [`${CLS}/main/versions`]: feedXml([
        { id: '00001', request: 'DEVK1', updated: '2026-10-01T00:00:00Z' },
        { id: '00000', updated: '2026-09-30T00:00:00Z' },
        { id: '00002', request: 'DEVK2', updated: '2026-10-05T00:00:00Z' },
      ]),
      [`${CLS}/implementations/versions`]: feedXml([{ id: '00000', request: 'DEVK3' }, { id: '99999', request: 'DEVK3' }]),
    });
    const res = await listVersions(deps(CLASS_URI, rest), { name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(res.versions.map((v) => `${v.include} ${v.version} ${v.state} ${v.request ?? '-'}`)).toEqual([
      'main 00000 active -',
      'main 00002 released DEVK2',
      'main 00001 released DEVK1',
      'implementations 99999 draft DEVK3',
      'implementations 00000 active DEVK3',
    ]);
    expect(res.versions[1]).toMatchObject({ description: 'Trip & app', author: 'DEV-A', at: '2026-10-05T00:00:00Z' });
    expect(rest.paths).toHaveLength(5);
    expect(res.notes).toEqual([]);
    expect(res.truncated).toBeUndefined();
  });

  it('reads one include only, untagged for other types, and caps the list', async () => {
    const rest = fakeRest({
      [`${CLS}/testclasses/versions`]: feedXml([{ id: '00001', request: 'DEVK1' }]),
      '/sap/bc/adt/ddic/ddl/sources/zi_x/versions': feedXml([{ id: '00000' }, { id: '00001', request: 'DEVK1' }, { id: '00002', request: 'DEVK2' }]),
    });
    const one = await listVersions(deps(CLASS_URI, rest), { name: 'ZCL_X', objectType: 'CLAS/OC', include: 'testclasses' });
    expect(one.versions).toEqual([{ include: 'testclasses', version: '00001', state: 'released', request: 'DEVK1', description: 'Trip & app', author: 'DEV-A', at: '2026-10-07T07:38:21Z' }]);
    const ddls = await listVersions(deps(`${TREE}/x/zi_x.ddls.acds`, rest), { name: 'ZI_X', objectType: 'DDLS/DF', maxResults: 2 });
    expect(ddls.versions.map((v) => v.version)).toEqual(['00000', '00002']);
    expect(ddls.versions[0]!.include).toBeUndefined();
    expect(ddls.truncated).toBe(true);
  });

  it('notes an object without a released version, refuses one without any feed', async () => {
    const rest = fakeRest({ '/sap/bc/adt/programs/programs/zp/source/main/versions': feedXml([{ id: '00000', request: 'Y1DK1' }]) });
    const res = await listVersions(deps(`${TREE}/x/zp.prog.abap`, rest), { name: 'ZP', objectType: 'PROG/P' });
    expect(res.notes[0]).toMatch(/imported one keeps only its active version/);
    await expect(listVersions(deps(`${TREE}/x/zq.prog.abap`, rest), { name: 'ZQ', objectType: 'PROG/P' })).rejects.toThrow(/no version history/);
    await expect(listVersions(deps(`${TREE}/x/zsb.srvb.json`, rest), { name: 'ZSB', objectType: 'SRVB/SVB' })).rejects.toThrow(/no version history/);
  });

  it('caps each file, marks a numbered version without request as stored, notes a file that fails', async () => {
    const rest = fakeRest({
      [`${CLS}/main/versions`]: feedXml([{ id: '00003', request: 'DEVK3' }, { id: '00002' }, { id: '00001', request: 'DEVK1' }]),
      [`${CLS}/definitions/versions`]: FAIL,
      [`${CLS}/testclasses/versions`]: feedXml([{ id: '99999', request: 'DEVK4' }]),
    });
    const res = await listVersions(deps(CLASS_URI, rest), { name: 'ZCL_X', objectType: 'CLAS/OC', maxResults: 2 });
    expect(res.versions.map((v) => `${v.include} ${v.version} ${v.state}`)).toEqual(['main 00003 released', 'main 00002 stored', 'testclasses 99999 draft']);
    expect(res.truncated).toBe(true);
    expect(res.notes).toEqual([expect.stringMatching(/ZCL_X definitions could not be read/)]);
    const one = await listVersions(deps(CLASS_URI, rest), { name: 'ZCL_X', objectType: 'CLAS/OC', maxResults: 1 });
    expect(one.notes.filter((n) => /no released version/.test(n))).toEqual([]);
  });

  it("throws a failing feed's error, not \"no history\", when the others don't exist", async () => {
    const rest = fakeRest({ [`${CLS}/main/versions`]: FAIL });
    await expect(listVersions(deps(CLASS_URI, rest), { name: 'ZCL_X', objectType: 'CLAS/OC' })).rejects.toThrow(/ZCL_X main could not be read/);
  });

  it('checks include and maxResults before any call', async () => {
    const rest = fakeRest({});
    await expect(listVersions(deps(CLASS_URI, rest), { name: 'ZCL_X', objectType: 'CLAS/OC', include: 'locals_imp' })).rejects.toThrow(/"implementations"/);
    await expect(listVersions(deps(CLASS_URI, rest), { name: 'ZCL_X', objectType: 'CLAS/OC', maxResults: 0 })).rejects.toThrow(/maxResults/);
    expect(rest.paths).toEqual([]);
  });
});

describe('readVersion', () => {
  const content = `${CLS}/implementations/versions/20261007073821/00001/content`;
  const rest = () =>
    fakeRest({
      [`${CLS}/implementations/versions`]: feedXml([{ id: '00000', content: 'x' }, { id: '00001', request: 'DEVK1', content }]),
      [content]: 'CLASS lcl DEFINITION.\r\nENDCLASS.\r\nCLASS lcl IMPLEMENTATION.\r\n  METHOD run.\r\n  ENDMETHOD.\r\nENDCLASS.',
    });

  it("reads a released version's text, normalized, with its version", async () => {
    const res = await readVersion(deps(CLASS_URI, rest()), { name: 'ZCL_X', objectType: 'CLAS/OC', include: 'implementations', version: '00001' });
    expect(res.source).toBe('CLASS lcl DEFINITION.\nENDCLASS.\nCLASS lcl IMPLEMENTATION.\n  METHOD run.\n  ENDMETHOD.\nENDCLASS.\n');
    expect(res.uri).toBe(`${TREE}/Source%20Code%20Library/Classes/ZCL_X/zcl_x.clas.implementations.abap`);
    expect(res).toMatchObject({ include: 'implementations', totalLines: 6, version: { include: 'implementations', version: '00001', request: 'DEVK1' } });
    expect(res.notes).toEqual([]);
  });

  it('narrows like object read', async () => {
    const res = await readVersion(deps(CLASS_URI, rest()), { name: 'ZCL_X', objectType: 'CLAS/OC', include: 'implementations', version: '00001', method: 'run' });
    expect(res.methods?.[0]).toMatchObject({ fromLine: 4, toLine: 5, method: 'run' });
    expect(res.source).toBeUndefined();
  });

  it('names the versions when the asked one is missing', async () => {
    await expect(
      readVersion(deps(CLASS_URI, rest()), { name: 'ZCL_X', objectType: 'CLAS/OC', include: 'implementations', version: '00004' }),
    ).rejects.toThrow(/no version 00004; its versions: 00001, 00000/);
  });

  it('says so when the version names no content', async () => {
    const r = fakeRest({ [`${CLS}/main/versions`]: feedXml([{ id: '00001', request: 'DEVK1' }]) });
    await expect(readVersion(deps(CLASS_URI, r), { name: 'ZCL_X', objectType: 'CLAS/OC', version: '00001' })).rejects.toThrow(/names no content/);
  });

  it('refuses the active and draft numbers and a second narrowing', async () => {
    const r = rest();
    await expect(readVersion(deps(CLASS_URI, r), { name: 'ZCL_X', objectType: 'CLAS/OC', version: '00000' })).rejects.toThrow(/"active" and "inactive"/);
    await expect(
      readVersion(deps(CLASS_URI, r), { name: 'ZCL_X', objectType: 'CLAS/OC', version: '00001', grep: 'x', fromLine: 1 }),
    ).rejects.toThrow(/at most one/);
    expect(r.paths).toEqual([]);
  });

  it("notes the version store's rebuild of a class's main source", async () => {
    const main = `${CLS}/main/versions/1/00001/content`;
    const r = fakeRest({ [`${CLS}/main/versions`]: feedXml([{ id: '00001', request: 'DEVK1', content: main }]), [main]: 'CLASS ZCL_X DEFINITION.' });
    const res = await readVersion(deps(CLASS_URI, r), { name: 'ZCL_X', objectType: 'CLAS/OC', version: '00001' });
    expect(res.notes[0]).toMatch(/rebuilds it/);
  });
});

describe('diffVersions', () => {
  const v = (id: string) => `${CLS}/main/versions/1/${id}/content`;
  const routes = () => ({
    [`${CLS}/main/versions`]: feedXml([
      { id: '00000', content: v('00000') },
      { id: '00002', request: 'DEVK2', content: v('00002') },
      { id: '00001', request: 'DEVK1', content: v('00001') },
      { id: '99999', request: 'DEVK3', content: v('99999') },
    ]),
    [v('00001')]: 'a\nb\nc',
    [v('00002')]: 'a\nB\nc',
    [v('00000')]: 'a\nB\nc',
    [v('99999')]: 'a\nB\nc\nd',
  });

  it('defaults to the draft against the newest numbered version', async () => {
    const res = await diffVersions(deps(CLASS_URI, fakeRest(routes())), { name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(res.base).toMatchObject({ version: '00002', include: 'main' });
    expect(res.version).toMatchObject({ version: '99999', state: 'draft' });
    expect(res.diff).toContain('--- zcl_x.clas.abap (old)');
    expect(res.diff).toContain('+d');
  });

  it('takes a number against the one before it, or two given sides', async () => {
    const one = await diffVersions(deps(CLASS_URI, fakeRest(routes())), { name: 'ZCL_X', objectType: 'CLAS/OC', version: '00002' });
    expect(one.base.version).toBe('00001');
    expect(one.diff).toMatch(/-b\n\+B/);
    const same = await diffVersions(deps(CLASS_URI, fakeRest(routes())), { name: 'ZCL_X', objectType: 'CLAS/OC', version: 'active', baseVersion: '00002' });
    expect(same.diff).toBe('');
    expect(same.notes).toEqual(['00002 and 00000 are the same text']);
  });

  it('names what exists when a side is missing, refuses one with nothing before it', async () => {
    const d = deps(CLASS_URI, fakeRest(routes()));
    await expect(diffVersions(d, { name: 'ZCL_X', objectType: 'CLAS/OC', baseVersion: '00007' })).rejects.toThrow(
      /no version 00007; its versions: 99999, 00002, 00001, 00000/,
    );
    await expect(diffVersions(d, { name: 'ZCL_X', objectType: 'CLAS/OC', version: '00001' })).rejects.toThrow(/no numbered version before 00001/);
    await expect(diffVersions(d, { name: 'ZCL_X', objectType: 'CLAS/OC', version: 'latest' })).rejects.toThrow(/"active", "inactive"/);
  });

  it('compares the current state with the last release, not a version stored by hand', async () => {
    const r = routes();
    r[`${CLS}/main/versions`] = feedXml([
      { id: '00003', content: v('00002') },
      { id: '00002', request: 'DEVK2', content: v('00002') },
      { id: '00001', request: 'DEVK1', content: v('00001') },
      { id: '00000', content: v('00000') },
    ]);
    const res = await diffVersions(deps(CLASS_URI, fakeRest(r)), { name: 'ZCL_X', objectType: 'CLAS/OC', version: 'active' });
    expect(res.base.version).toBe('00002');
  });

  it('does not flag a diff exactly as long as the cap', async () => {
    const full = await diffVersions(deps(CLASS_URI, fakeRest(routes())), { name: 'ZCL_X', objectType: 'CLAS/OC' });
    const n = full.diff.replace(/\n$/, '').split('\n').length;
    const res = await diffVersions(deps(CLASS_URI, fakeRest(routes())), { name: 'ZCL_X', objectType: 'CLAS/OC', maxLines: n });
    expect(res.truncated).toBeUndefined();
    expect(res.diff).toBe(full.diff);
  });

  it('caps the diff', async () => {
    const res = await diffVersions(deps(CLASS_URI, fakeRest(routes())), { name: 'ZCL_X', objectType: 'CLAS/OC', maxLines: 2 });
    expect(res.diff.replace(/\n$/, '').split('\n')).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });
});

describe('times (ADR-016)', () => {
  const rest = () => fakeRest({ '/sap/bc/adt/ddic/ddl/sources/zi_x/versions': feedXml([{ id: '00001', request: 'DEVK1', updated: '2026-10-07T07:38:21Z' }]) });
  const ddls = (clock: Parameters<typeof listVersions>[0]['clock']) => ({ ...deps(`${TREE}/x/zi_x.ddls.acds`, rest()), clock });

  it('turns feed times into UTC with the measured clock', async () => {
    const res = await listVersions(ddls({ localOffsetMinutes: 60, feedOffsetMinutes: -60, measuredAt: 'x' }), { name: 'ZI_X', objectType: 'DDLS/DF' });
    expect(res.versions[0]!.at).toBe('2026-10-07T08:38:21Z');
    expect(res.notes).toEqual([]);
  });

  it('keeps them as sent and says so when the clock did not measure', async () => {
    const res = await listVersions(ddls({ measuredAt: 'x', errors: { feed: 'no answer' } }), { name: 'ZI_X', objectType: 'DDLS/DF' });
    expect(res.versions[0]!.at).toBe('2026-10-07T07:38:21Z');
    expect(res.notes[0]).toMatch(/not corrected to UTC.*no answer/);
  });
});
