import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import { RawAdtError, type RawAdtClient } from '../../src/backends/rawadt.js';
import { diff, parseTransportDetail, pickVersions, planSupplement, read, stateOf } from '../../src/capabilities/transport-diff.js';
import { unifiedDiff } from '../../src/core/udiff.js';
import type { FeedEntry } from '../../src/mirror/history.js';

// Shapes trimmed from ONPREM's organizer documents and version feeds (2026-10-10).
const NS = 'xmlns:tm="http://www.sap.com/cts/adt/tm" xmlns:adtcore="http://www.sap.com/adt/core"';
const obj = (pgmid: string, type: string, name: string, extra = '') =>
  `<tm:abap_object tm:pgmid="${pgmid}" tm:type="${type}" tm:name="${name}" tm:wbtype="${type}/X" tm:position="000001"${extra}/>`;
const head = (number: string, status: string, tag = 'request', parent = '') =>
  `<tm:${tag} tm:number="${number}" tm:parent="${parent}" tm:owner="DEV-A" tm:desc="Change &amp; fix" tm:type="K" ` +
  `tm:status="${status}" tm:status_text="${status === 'R' ? 'Released' : 'Modifiable'}" tm:target="VIR" ` +
  `tm:lastchanged_timestamp="20261009150357" tm:uri="/sap/bc/adt/cts/transportrequests/${number}">`;

/** A released request: its own entries, then a task listing them again (self-closing, as released ones are). */
function releasedXml(number: string, entries: string[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><tm:root tm:object_type="R" adtcore:name="${number}" ${NS}>` +
    `${head(number, 'R')}<tm:long_desc/>${obj('CORR', 'RELE', `${number}T 20261009 150353 DEV-A`)}${entries.join('')}` +
    `${head(`${number}T`, 'R', 'task', number)}${entries.join('')}</tm:task></tm:request></tm:root>`
  );
}

function feedXml(entries: Array<{ id: string; request?: string; content?: string }>): string {
  return (
    '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:adtcore="http://www.sap.com/adt/core">' +
    entries
      .map(
        (e) =>
          `<atom:entry><atom:author><atom:name>DEV-A</atom:name></atom:author><atom:id>${e.id}</atom:id>` +
          `<atom:updated>2026-10-09T13:03:53Z</atom:updated>` +
          (e.content ? `<atom:content type="text/plain" src="${e.content}"/>` : '') +
          (e.request
            ? `<atom:link href="/x" rel="http://www.sap.com/adt/relations/transport/request" adtcore:name="${e.request}" ` +
              'type="application/vnd.sap.adt.transportrequests.v1+xml" title="t"/>'
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
    return { status: body === undefined ? 404 : 200, headers: new Headers(), body: body ?? '' };
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

function fakeAdt(diffResult = '', extra: Partial<Record<string, unknown>> = {}): AdtLsClient {
  return {
    transport: {
      getDiff: vi.fn(async () => ({
        batchInfo: { processedCount: 1, totalObjects: 1, remainingCount: 0, status: 'completed' },
        message: 'All objects processed successfully.',
        diffResult,
      })),
    },
    lifecycle: { resolveAffUri: vi.fn(async () => 'abap:/repotree-v1/onprem/Z/Function%20Groups/ZFG/zfg.fugr.json') },
    repository: { readDirectory: vi.fn(async () => []) },
    ...extra,
  } as unknown as AdtLsClient;
}

const CLASS = '/sap/bc/adt/oo/classes/zcl_x/includes';
const v = (id: string, request?: string): FeedEntry => ({ id, author: 'DEV-A', updated: '', ...(request ? { request } : {}) });

describe('parseTransportDetail', () => {
  it('reads a released request: header, tasks, entries once each, comment entries left out', () => {
    const xml = releasedXml('DEVK1', [obj('R3TR', 'CLAS', 'ZCL_X'), obj('R3TR', 'PROG', 'ZPROG', ' tm:obj_func="D"')]);
    const d = parseTransportDetail(xml, 'DEVK1')!;
    expect(d).toMatchObject({ number: 'DEVK1', owner: 'DEV-A', status: 'R', statusText: 'Released', description: 'Change & fix', target: 'VIR' });
    expect(d.request).toBeUndefined();
    expect(d.tasks).toEqual([
      expect.objectContaining({ number: 'DEVK1T', status: 'R', objects: [expect.objectContaining({ name: 'ZCL_X' }), expect.objectContaining({ name: 'ZPROG', deleted: true })] }),
    ]);
    expect(d.objects).toEqual([
      { pgmid: 'R3TR', type: 'CLAS', name: 'ZCL_X', wbtype: 'CLAS/X' },
      { pgmid: 'R3TR', type: 'PROG', name: 'ZPROG', wbtype: 'PROG/X', deleted: true },
    ]);
  });

  it('reads a task: its own entries, its request named', () => {
    const xml =
      `<tm:root tm:object_type="T" ${NS}>${head('DEVK1', 'D')}<tm:long_desc/></tm:request>` +
      `${head('DEVK2', 'D', 'task', 'DEVK1')}<tm:abap_object tm:pgmid="LIMU" tm:type="CINC" tm:name="ZCL_X=====CCAU"></tm:abap_object></tm:task></tm:root>`;
    const d = parseTransportDetail(xml, 'DEVK2')!;
    expect(d).toMatchObject({ number: 'DEVK2', request: 'DEVK1', status: 'D' });
    expect(d.objects).toEqual([{ pgmid: 'LIMU', type: 'CINC', name: 'ZCL_X=====CCAU' }]);
  });

  it('lists a translation project\'s LANG entries next to the objects', () => {
    // A publish records the project and the translated object's LANG entry.
    const xml = releasedXml('DEVK1', [obj('R3TR', 'TRPR', 'ZADTPLUS_P'), obj('LANG', 'MSAG', 'ZADTPLUS_M')]);
    expect(parseTransportDetail(xml, 'DEVK1')!.objects).toEqual([
      { pgmid: 'R3TR', type: 'TRPR', name: 'ZADTPLUS_P', wbtype: 'TRPR/X' },
      { pgmid: 'LANG', type: 'MSAG', name: 'ZADTPLUS_M', wbtype: 'MSAG/X' },
    ]);
  });

  it('read() tags the REST fallback and fails on a document without the request', async () => {
    const rest = fakeRest({ '/sap/bc/adt/cts/transportrequests/DEVK1': releasedXml('DEVK1', []) });
    expect(await read(rest, 'devk1')).toMatchObject({ via: 'rest-fallback', nativeAvailable: null, number: 'DEVK1' });
    await expect(read(fakeRest({ '/sap/bc/adt/cts/transportrequests/DEVK9': '<x/>' }), 'DEVK9')).rejects.toThrow(/no transport request/);
    await expect(read(fakeRest({}), 'DEVK8')).rejects.toThrow(RawAdtError);
  });

  it('read() gives the release in UTC by the measured clock, else as sent with a note (ADR-016)', async () => {
    const rest = () => fakeRest({ '/sap/bc/adt/cts/transportrequests/DEVK1': releasedXml('DEVK1', []) });
    const measured = await read(rest(), 'DEVK1', null, { localOffsetMinutes: 60, feedOffsetMinutes: -60, measuredAt: 'x' });
    expect(measured).toMatchObject({ lastChanged: '2026-10-09T14:03:57Z' });
    expect(measured.notes).toBeUndefined();
    const unmeasured = await read(rest(), 'DEVK1', null, { measuredAt: 'x', errors: { local: 'no answer' } });
    expect(unmeasured).toMatchObject({ lastChanged: '20261009150357', notes: [expect.stringMatching(/not corrected/)] });
  });
});

describe('planSupplement', () => {
  it('maps entries to objects and the files getDiff shows itself', () => {
    const plan = planSupplement([
      { pgmid: 'R3TR', type: 'CLAS', name: 'ZCL_A' },
      { pgmid: 'LIMU', type: 'CINC', name: 'ZCL_B=========================CCAU' },
      { pgmid: 'LIMU', type: 'METH', name: 'ZCL_B                         RUN' },
      { pgmid: 'R3TR', type: 'FUGR', name: 'ZFG' },
      { pgmid: 'R3TR', type: 'DDLS', name: 'ZI_X' },
      { pgmid: 'LIMU', type: 'REPS', name: 'ZPROG' },
      { pgmid: 'LIMU', type: 'FUNC', name: 'Z_FM' },
      { pgmid: 'R3TR', type: 'DEVC', name: 'ZPKG' },
      { pgmid: 'LANG', type: 'MSAG', name: 'ZMSG' },
    ]);
    expect(plan.objects.map((o) => [`${o.type} ${o.name}`, [...o.covered]])).toEqual([
      ['CLAS ZCL_A', ['zcl_a.clas.abap']],
      ['CLAS ZCL_B', ['zcl_b.clas.testclasses.abap', 'zcl_b.clas.abap']],
      ['FUGR ZFG', ['zfg.fugr.saplzfg.reps.abap']],
      ['DDLS ZI_X', ['zi_x.ddls.acds']],
      ['PROG ZPROG', ['zprog.prog.abap']],
    ]);
    expect(plan.notCovered).toEqual([expect.stringContaining('LIMU FUNC Z_FM'), expect.stringContaining('LANG MSAG ZMSG')]);
  });
  it('reads a 30-character class\'s include suffix without padding, and namespaces as AFF spells them', () => {
    const name = 'ZCL_A_CLASS_NAME_OF_THIRTY_CHR';
    expect(name).toHaveLength(30);
    const plan = planSupplement([
      { pgmid: 'LIMU', type: 'CINC', name: `${name}CCAU` },
      { pgmid: 'R3TR', type: 'FUGR', name: '/NS/FG' },
    ]);
    expect(plan.objects.map((o) => [...o.covered])).toEqual([
      ['zcl_a_class_name_of_thirty_chr.clas.testclasses.abap'],
      ['(ns)fg.fugr.(ns)saplfg.reps.abap'],
    ]);
  });
});

describe('stateOf', () => {
  it('modifiable is open, released with or without import protection released, the rest unsettled', () => {
    expect(['D', 'L', 'R', 'N', 'O'].map(stateOf)).toEqual(['open', 'open', 'released', 'released', 'unsettled']);
  });
});

describe('pickVersions', () => {
  const ids = new Set(['DEVK2', 'DEVK2T']);
  it('released: the version naming the request (or its task) against the one before', () => {
    const list = [v('00000', 'DEVK3'), v('00003', 'DEVK3'), v('00002', 'DEVK2T'), v('00001', 'DEVK1')];
    expect(pickVersions(list, ids, 'released')).toEqual({ new: list[2], old: list[3] });
    expect(pickVersions([v('00001', 'DEVK2')], ids, 'released')).toEqual({ new: v('00001', 'DEVK2') });
    expect(pickVersions(list, new Set(['DEVK9']), 'released')).toBeUndefined();
  });

  it('open: the draft, else the active version, while the request holds it, against the newest release', () => {
    const list = [v('99999', 'DEVK2'), v('00000', 'DEVK2'), v('00002', 'DEVK1'), v('00001', 'DEVK0')];
    expect(pickVersions(list, ids, 'open')).toEqual({ new: list[0], old: list[2] });
    expect(pickVersions(list.slice(1), ids, 'open')).toEqual({ new: list[1], old: list[2] });
    expect(pickVersions([v('00000', 'DEVK7'), v('00001', 'DEVK1')], ids, 'open')).toBeUndefined();
  });

  it('unsettled: the released rule, else the open one', () => {
    const released = [v('00000', 'DEVK2'), v('00002', 'DEVK2'), v('00001', 'DEVK1')];
    expect(pickVersions(released, ids, 'unsettled')).toEqual({ new: released[1], old: released[2] });
    const open = [v('00000', 'DEVK2'), v('00001', 'DEVK1')];
    expect(pickVersions(open, ids, 'unsettled')).toEqual({ new: open[0], old: open[1] });
  });
});

describe('unifiedDiff', () => {
  it('is empty for equal texts and headed like getDiff otherwise', () => {
    expect(unifiedDiff('f', 'a\nb\n', 'a\nb\n')).toBe('');
    expect(unifiedDiff('f', '', 'x\n')).toBe('--- f (old)\n+++ f (new)\n@@ -0,0 +1,1 @@\n+x\n');
    expect(unifiedDiff('f', 'x\ny\n', '')).toBe('--- f (old)\n+++ f (new)\n@@ -1,2 +0,0 @@\n-x\n-y\n');
  });

  it('keeps three lines of context and splits distant changes into hunks', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const b = a.map((l, i) => (i === 2 || i === 17 ? `${l}!` : l));
    const out = unifiedDiff('f', `${a.join('\n')}\n`, `${b.join('\n')}\n`);
    expect(out.match(/^@@.*$/gm)).toEqual(['@@ -1,6 +1,6 @@', '@@ -15,6 +15,6 @@']);
    expect(out).toContain('-l2\n+l2!\n');
  });

  it('replaces the whole middle past its step cap, between the lines both share', () => {
    const a = ['head', ...Array.from({ length: 2000 }, (_, i) => `a${i}`), 'tail'];
    const b = ['head', ...Array.from({ length: 2000 }, (_, i) => `b${i}`), 'tail'];
    const out = unifiedDiff('f', `${a.join('\n')}\n`, `${b.join('\n')}\n`);
    expect(out.match(/^@@.*$/gm)).toEqual(['@@ -1,2002 +1,2002 @@']);
    expect(out).toContain(' head\n-a0\n');
    expect(out).toContain('-a1999\n+b0\n');
    expect(out.endsWith('+b1999\n tail\n')).toBe(true);
  });
});

describe('transport diff', () => {
  it('first page: getDiff\'s page plus the includes and objects it leaves out', async () => {
    const xml = releasedXml('DEVK2', [obj('R3TR', 'CLAS', 'ZCL_X'), obj('R3TR', 'PROG', 'ZGONE'), obj('R3TR', 'TABU', 'TDDAT')]);
    const routes: Record<string, string> = {
      '/sap/bc/adt/cts/transportrequests/DEVK2': xml,
      // Main: getDiff shows it.
      [`${CLASS}/main/versions`]: feedXml([{ id: '00000', request: 'DEVK2', content: '/c/main0' }, { id: '00001', request: 'DEVK2', content: '/c/main1' }]),
      // Test classes changed by the request.
      [`${CLASS}/testclasses/versions`]: feedXml([
        { id: '00000', request: 'DEVK2', content: '/c/tc0' },
        { id: '00002', request: 'DEVK2T', content: '/c/tc2' },
        { id: '00001', request: 'DEVK1', content: '/c/tc1' },
      ]),
      '/c/tc2': 'CLASS ltc DEFINITION FOR TESTING.\nENDCLASS.\n',
      '/c/tc1': '*"* use this source file for your ABAP unit test classes\n',
      // Created as SAP's template only: left out.
      [`${CLASS}/macros/versions`]: feedXml([{ id: '00000', request: 'DEVK2', content: '/c/m0' }, { id: '00001', request: 'DEVK2', content: '/c/m1' }]),
      '/c/m1': '*"* use this source file for any macro definitions you need\n*"* in the implementation part of the class\n',
      // Unchanged by this request.
      [`${CLASS}/definitions/versions`]: feedXml([{ id: '00000', request: 'DEVK1', content: '/c/d0' }, { id: '00001', request: 'DEVK1', content: '/c/d1' }]),
      // Deleted since: only released versions left in its feed.
      '/sap/bc/adt/programs/programs/zgone/source/main/versions': feedXml([{ id: '00001', request: 'DEVK2', content: '/c/g1' }]),
      '/c/g1': 'REPORT zgone.\n',
    };
    const rest = fakeRest(routes);
    const adt = fakeAdt('--- CLAS/OC ZCL_X (old)\n+++ CLAS/OC ZCL_X (new)\n@@ -1,1 +1,1 @@\n-a\n+b\n');
    const res = await diff({ adt, withRest: (fn) => fn(rest) }, { transport: 'devk2' });

    expect(adt.transport.getDiff).toHaveBeenCalledWith('DEVK2', {});
    expect(res).toMatchObject({ via: 'adt-ls', transport: 'DEVK2', page: { processed: 1, total: 1, remaining: 0 } });
    expect(res.diff).toContain('CLAS/OC ZCL_X');
    expect(res.nextCursor).toBeUndefined();
    const s = res.supplement!;
    expect(s.files).toEqual([
      { object: 'CLAS ZCL_X', file: 'zcl_x.clas.testclasses.abap', old: '00001', new: '00002', reason: 'include' },
      { object: 'PROG ZGONE', file: 'zgone.prog.abap', new: '00001', reason: 'gone' },
    ]);
    expect(s).toMatchObject({ via: 'rest-fallback', nativeAvailable: null, gone: ['PROG ZGONE'], templates: 1, notCovered: [] });
    expect(s.diff).toContain('--- zcl_x.clas.testclasses.abap (old)\n+++ zcl_x.clas.testclasses.abap (new)\n');
    expect(s.diff).toContain('+REPORT zgone.\n');
    // getDiff's own file is never read for an object that exists.
    expect(rest.paths).not.toContain('/c/main0');
    expect(rest.paths).not.toContain('/c/main1');
  });

  it('a later page: getDiff only, no request read', async () => {
    const rest = fakeRest({});
    const adt = fakeAdt('\nNo differences found.\n');
    const res = await diff({ adt, withRest: (fn) => fn(rest) }, { transport: 'DEVK2', cursor: 'c2', pageSize: 10 });
    expect(adt.transport.getDiff).toHaveBeenCalledWith('DEVK2', { cursor: 'c2', pageSize: 10 });
    expect(res.diff).toBe('');
    expect(res.supplement).toBeUndefined();
    expect(rest.paths).toEqual([]);
  });

  it('an object deleted in an open request: its last release against nothing', async () => {
    const xml =
      `<tm:root tm:object_type="R" ${NS}>${head('DEVK5', 'D')}<tm:long_desc/><tm:all_objects>` +
      `${obj('R3TR', 'INTF', 'ZIF_GONE', ' tm:obj_func="D"')}</tm:all_objects></tm:request></tm:root>`;
    const rest = fakeRest({
      '/sap/bc/adt/cts/transportrequests/DEVK5': xml,
      '/sap/bc/adt/oo/interfaces/zif_gone/source/main/versions': feedXml([{ id: '00001', request: 'DEVK1', content: '/c/i1' }]),
      '/c/i1': 'INTERFACE zif_gone PUBLIC.\nENDINTERFACE.\n',
    });
    const res = await diff({ adt: fakeAdt(), withRest: (fn) => fn(rest) }, { transport: 'DEVK5' });
    expect(res.supplement!.files).toEqual([{ object: 'INTF ZIF_GONE', file: 'zif_gone.intf.abap', old: '00001', new: 'deleted', reason: 'gone' }]);
    expect(res.supplement!.diff).toContain('@@ -1,2 +0,0 @@\n-INTERFACE zif_gone PUBLIC.\n');
  });

  it('a failed read costs its object, not the page; a failed request read only the supplement', async () => {
    const xml = releasedXml('DEVK2', [obj('R3TR', 'CLAS', 'ZCL_X'), obj('R3TR', 'PROG', 'ZGONE')]);
    const routes: Record<string, string> = {
      '/sap/bc/adt/cts/transportrequests/DEVK2': xml,
      '/sap/bc/adt/programs/programs/zgone/source/main/versions': feedXml([{ id: '00001', request: 'DEVK2', content: '/c/g1' }]),
      '/c/g1': 'REPORT zgone.\n',
    };
    const base = fakeRest(routes);
    const rest = {
      ...base,
      expectOk: async (method: string, path: string, context: string) => {
        if (path.startsWith(CLASS)) throw new RawAdtError(500, undefined, 'boom', context);
        return base.expectOk(method, path, context);
      },
    } as unknown as RawAdtClient;
    const adt = fakeAdt('--- CLAS/OC ZCL_X (old)\n');
    const res = await diff({ adt, withRest: (fn) => fn(rest) }, { transport: 'DEVK2' });
    expect(res.diff).toContain('CLAS/OC ZCL_X');
    expect(res.supplement!.files.map((f) => f.object)).toEqual(['PROG ZGONE']);
    expect(res.supplement!.notCovered).toEqual([expect.stringMatching(/^CLAS ZCL_X: .*boom/)]);

    const none = await diff({ adt, withRest: (fn) => fn(fakeRest({})) }, { transport: 'DEVK2' });
    expect(none.diff).toContain('CLAS/OC ZCL_X');
    expect(none.supplement).toBeUndefined();
    expect(none.supplementError).toMatch(/DEVK2/);
  });

  it('a task of an open request goes by the request\'s status, though released itself', async () => {
    const xml =
      `<tm:root tm:object_type="T" ${NS}>${head('DEVK1', 'D')}<tm:long_desc/></tm:request>` +
      `${head('DEVK2', 'R', 'task', 'DEVK1')}${obj('LIMU', 'CINC', 'ZCL_X=========================CCIMP')}</tm:task></tm:root>`;
    const rest = fakeRest({
      '/sap/bc/adt/cts/transportrequests/DEVK2': xml,
      [`${CLASS}/main/versions`]: feedXml([{ id: '00000', request: 'DEVK1' }, { id: '00001', request: 'DEVK0' }]),
      [`${CLASS}/testclasses/versions`]: feedXml([
        { id: '00000', request: 'DEVK1', content: '/c/tc0' },
        { id: '00001', request: 'DEVK0', content: '/c/tc1' },
      ]),
      '/c/tc0': 'CLASS ltc DEFINITION FOR TESTING.\nENDCLASS.\n',
      '/c/tc1': 'CLASS ltc DEFINITION.\nENDCLASS.\n',
    });
    const res = await diff({ adt: fakeAdt(), withRest: (fn) => fn(rest) }, { transport: 'DEVK2' });
    expect(res.supplement!.files).toEqual([{ object: 'CLAS ZCL_X', file: 'zcl_x.clas.testclasses.abap', old: '00001', new: '00000', reason: 'include' }]);
  });

  it('an include changed back to SAP\'s template is a diff, and the main feed is read once', async () => {
    const xml = releasedXml('DEVK2', [obj('R3TR', 'CLAS', 'ZCL_X')]);
    const rest = fakeRest({
      '/sap/bc/adt/cts/transportrequests/DEVK2': xml,
      [`${CLASS}/main/versions`]: feedXml([{ id: '00000', request: 'DEVK2' }, { id: '00002', request: 'DEVK2' }]),
      [`${CLASS}/macros/versions`]: feedXml([
        { id: '00000', request: 'DEVK2', content: '/c/m0' },
        { id: '00002', request: 'DEVK2', content: '/c/m2' },
        { id: '00001', request: 'DEVK1', content: '/c/m1' },
      ]),
      '/c/m2': '*"* use this source file for any macro definitions you need\n',
      // The old version's content is gone (404): still a change, not a created template.
    });
    const res = await diff({ adt: fakeAdt(), withRest: (fn) => fn(rest) }, { transport: 'DEVK2' });
    expect(res.supplement!.files).toEqual([{ object: 'CLAS ZCL_X', file: 'zcl_x.clas.macros.abap', old: '00001', new: '00002', reason: 'include' }]);
    expect(res.supplement!.templates).toBe(0);
    expect(rest.paths.filter((p) => p === `${CLASS}/main/versions`)).toHaveLength(1);
  });

  it('a function group: the parts its folder lists, the main program left to getDiff', async () => {
    const xml = releasedXml('DEVK6', [obj('R3TR', 'FUGR', 'ZFG')]);
    const group = '/sap/bc/adt/functions/groups/zfg';
    const rest = fakeRest({
      '/sap/bc/adt/cts/transportrequests/DEVK6': xml,
      [`${group}/source/main/versions`]: feedXml([{ id: '00000', request: 'DEVK6' }, { id: '00001', request: 'DEVK6' }]),
      [`${group}/includes/lzfgtop/source/main/versions`]: feedXml([{ id: '00000', request: 'DEVK6' }, { id: '00001', request: 'DEVK6', content: '/c/top' }]),
      '/c/top': 'FUNCTION-POOL zfg.\n',
      [`${group}/fmodules/z_fm/source/main/versions`]: feedXml([{ id: '00000', request: 'DEVK6' }, { id: '00001', request: 'DEVK6', content: '/c/fm' }]),
      '/c/fm': 'FUNCTION z_fm.\nENDFUNCTION.\n',
    });
    const adt = fakeAdt('', {
      repository: {
        readDirectory: vi.fn(async () => [
          { name: 'zfg.fugr.json', kind: 'file' },
          { name: 'zfg.fugr.saplzfg.reps.abap', kind: 'file' },
          { name: 'zfg.fugr.lzfgtop.reps.abap', kind: 'file' },
          { name: 'zfg.fugr.z_fm.func.abap', kind: 'file' },
        ]),
      },
    });
    const res = await diff({ adt, withRest: (fn) => fn(rest) }, { transport: 'DEVK6' });
    expect(res.supplement!.files.map((f) => f.file)).toEqual(['zfg.fugr.lzfgtop.reps.abap', 'zfg.fugr.z_fm.func.abap']);
    expect(res.supplement!.gone).toEqual([]);
  });
});
