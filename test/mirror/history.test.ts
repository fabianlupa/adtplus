import { describe, expect, it } from 'vitest';
import { clockOffset, localToUtc } from '../../src/core/clock.js';
import { feedsOf, isReleased, parseFeed, parseReleased } from '../../src/mirror/history.js';

const FEED =
  '<?xml version="1.0" encoding="utf-8"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<atom:title>Versionsliste von ZNFL_BOOKINGS_LIST (REPS)</atom:title><atom:updated>2026-10-07T04:47:49Z</atom:updated>' +
  '<atom:entry><atom:author><atom:name>DEVELOPER</atom:name></atom:author>' +
  '<atom:content type="text/plain" src="/sap/bc/adt/programs/programs/znfl_bookings_list/source/main/versions/20261007044749/00000/content"/>' +
  '<atom:id>00000</atom:id><atom:title>Version (aktiv)</atom:title><atom:updated>2026-10-07T04:09:29Z</atom:updated></atom:entry>' +
  '<atom:entry><atom:author><atom:name>DEVELOPER</atom:name></atom:author>' +
  '<atom:content type="text/plain" src="/sap/bc/adt/programs/programs/znfl_bookings_list/source/main/versions/20261007044749/00002/content"/>' +
  '<atom:id>00002</atom:id>' +
  '<atom:link adtcore:name="DEVK914324" href="/sap/bc/adt/vit/wb/object_type/%20%20%20%20rq/object_name/DEVK914324" rel="http://www.sap.com/adt/relations/transport/request" type="application/vnd.sap.sapgui" title="adtplus transport reads"/>' +
  '<atom:link adtcore:name="DEVK914324" href="/sap/bc/adt/cts/transportrequests/DEVK914324" rel="http://www.sap.com/adt/relations/transport/request" type="application/vnd.sap.adt.transportrequests.v1+xml" title="adtplus &amp; transport reads"/>' +
  '<atom:title>adtplus transport reads</atom:title><atom:updated>2026-10-07T04:47:49Z</atom:updated></atom:entry>' +
  '<atom:entry><atom:author><atom:name>OTHER</atom:name></atom:author>' +
  '<atom:content type="text/plain" src="/x/99999/content"/><atom:id>99999</atom:id>' +
  '<atom:link adtcore:name="DEVK914325" href="/sap/bc/adt/cts/transportrequests/DEVK914325" rel="http://www.sap.com/adt/relations/transport/request" type="application/vnd.sap.adt.transportrequests.v1+xml" title="task"/>' +
  '<atom:updated>2026-10-07T04:08:13Z</atom:updated></atom:entry></atom:feed>';

describe('history: version feeds', () => {
  it('reads each entry: id, author, release time, the request link and the content URL', () => {
    const entries = parseFeed(FEED);
    expect(entries.map((e) => e.id)).toEqual(['00000', '00002', '99999']);
    expect(entries[1]).toEqual({
      id: '00002',
      author: 'DEVELOPER',
      updated: '2026-10-07T04:47:49Z',
      request: 'DEVK914324',
      description: 'adtplus & transport reads',
      content: '/sap/bc/adt/programs/programs/znfl_bookings_list/source/main/versions/20261007044749/00002/content',
    });
    expect(entries[0]!.request).toBeUndefined();
  });

  it('only numbered versions with a request are released: never the active or the draft', () => {
    expect(parseFeed(FEED).filter(isReleased).map((e) => e.id)).toEqual(['00002']);
  });

  it('a feed per source file, built from type and name (P4)', () => {
    expect(
      feedsOf('CLAS', 'ZCL_A', ['zcl_a.clas.abap', 'zcl_a.clas.testclasses.abap', 'zcl_a.clas.implementations.abap', 'zcl_a.clas.json', 'zcl_a.clas.texts.en.properties']),
    ).toEqual([
      { file: 'zcl_a.clas.abap', feed: '/sap/bc/adt/oo/classes/zcl_a/includes/main/versions' },
      { file: 'zcl_a.clas.testclasses.abap', feed: '/sap/bc/adt/oo/classes/zcl_a/includes/testclasses/versions' },
      { file: 'zcl_a.clas.implementations.abap', feed: '/sap/bc/adt/oo/classes/zcl_a/includes/implementations/versions' },
    ]);
    expect(feedsOf('DDLS', 'ZI_B', ['zi_b.ddls.acds', 'zi_b.ddls.json'])).toEqual([
      { file: 'zi_b.ddls.acds', feed: '/sap/bc/adt/ddic/ddl/sources/zi_b/versions' },
    ]);
    expect(feedsOf('PROG', 'ZP', ['zp.prog.abap'])[0]!.feed).toBe('/sap/bc/adt/programs/programs/zp/source/main/versions');
    expect(feedsOf('TABL', 'ZT', ['zt.tabl.ddic', 'zt.tabl.json'])[0]!.feed).toBe('/sap/bc/adt/ddic/tables/zt/source/main/versions');
    // Types without versions, or files that aren't sources: none.
    expect(feedsOf('DTELDE', 'ZDE_A', ['zde_a.dtelde.jsonc'])).toEqual([]);
    expect(feedsOf('SRVB', 'ZUI', ['zui.srvb.json'])).toEqual([]);
  });

  it('a function group: its main program, includes and modules, a namespaced one too', () => {
    expect(feedsOf('FUGR', 'ZFG', ['zfg.fugr.saplzfg.reps.abap', 'zfg.fugr.lzfgtop.reps.abap', 'zfg.fugr.z_fm.func.abap', 'zfg.fugr.json'])).toEqual([
      { file: 'zfg.fugr.saplzfg.reps.abap', feed: '/sap/bc/adt/functions/groups/zfg/source/main/versions' },
      { file: 'zfg.fugr.lzfgtop.reps.abap', feed: '/sap/bc/adt/functions/groups/zfg/includes/lzfgtop/source/main/versions' },
      { file: 'zfg.fugr.z_fm.func.abap', feed: '/sap/bc/adt/functions/groups/zfg/fmodules/z_fm/source/main/versions' },
    ]);
    expect(feedsOf('FUGR', '/NS/FG', ['(ns)fg.fugr.(ns)saplfg.reps.abap', '(ns)fg.fugr.(ns)lfgtop.reps.abap']).map((f) => f.feed)).toEqual([
      '/sap/bc/adt/functions/groups/%2Fns%2Ffg/source/main/versions',
      '/sap/bc/adt/functions/groups/%2Fns%2Ffg/includes/%2Fns%2Flfgtop/source/main/versions',
    ]);
  });
});

describe('history: the system clock', () => {
  it('the offset from the list\'s local `changedAt`, to 15 minutes; none without one', () => {
    const at = Date.parse('2026-10-09T15:08:40Z');
    expect(clockOffset('<tm:root adtcore:name="*" adtcore:changedAt="2026-10-09T16:08:51Z">', at)).toBe(60);
    expect(clockOffset('<tm:root adtcore:changedAt="2026-10-09T15:08:41Z">', at)).toBe(0);
    expect(clockOffset('<tm:root adtcore:changedAt="2026-10-09T09:38:41Z">', at)).toBe(-330);
    expect(clockOffset('<tm:root>', at)).toBeUndefined();
  });

  it('a local stamp as UTC; anything else none', () => {
    expect(localToUtc('20261009132904', 60)).toBe('2026-10-09T12:29:04Z');
    expect(localToUtc('20261009003000', 60)).toBe('2026-10-08T23:30:00Z');
    expect(localToUtc('', 60)).toBeUndefined();
    expect(localToUtc('00000000000000', 60)).toBeUndefined();
    expect(localToUtc(undefined, 0)).toBeUndefined();
  });
});

describe('history: the released list', () => {
  it('released requests with their own entries; comments, tasks and other sections left out', () => {
    const xml =
      '<tm:root><tm:workbench><tm:modifiable><tm:request tm:number="DEVK1" tm:status="D" tm:owner="A" tm:desc="open">' +
      '<tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZOPEN"/></tm:request></tm:modifiable>' +
      '<tm:released tm:status="Freigegeben"><tm:request tm:number="DEVK914324" tm:parent="" tm:owner="DEVELOPER" tm:desc="adtplus &amp; reads" tm:type="K" tm:status="R" tm:lastchanged_timestamp="20261007063807">' +
      '<tm:long_desc/><atom:link href="/x"/>' +
      '<tm:abap_object tm:pgmid="CORR" tm:type="RELE" tm:name="DEVK914325 20261007 063801 DEVELOPER"/>' +
      '<tm:abap_object tm:pgmid="LIMU" tm:type="REPS" tm:name="ZNFL_BOOKINGS_LIST" tm:wbtype="PROG/P"/>' +
      '<tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZNFL_DEMO_AUTH" tm:obj_func="D" tm:wbtype="PROG/P"/>' +
      '<tm:task tm:number="DEVK914325" tm:parent="DEVK914324" tm:owner="DEVELOPER" tm:status="R">' +
      '<tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZNFL_DEMO_AUTH"/></tm:task></tm:request></tm:released></tm:workbench></tm:root>';
    expect(parseReleased(xml)).toEqual([
      {
        number: 'DEVK914324',
        owner: 'DEVELOPER',
        description: 'adtplus & reads',
        releasedLocal: '20261007063807',
        objects: [
          { pgmid: 'LIMU', type: 'REPS', name: 'ZNFL_BOOKINGS_LIST', deleted: false },
          { pgmid: 'R3TR', type: 'PROG', name: 'ZNFL_DEMO_AUTH', deleted: true },
        ],
      },
    ]);
  });
});
