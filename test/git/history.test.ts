import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownersOfEntry } from '../../src/git/history.js';
import { realGit } from '../../src/git/git.js';
import { privateRef } from '../../src/git/protocol.js';
import { shadowMatches } from '../../src/git/state.js';
import { PACKAGE, fakeSystem } from '../mirror/fake.js';
import { gitWorld, type FakeVersion } from './setup.js';

const REF = privateRef('origin');
const CLASS_FEED = '/sap/bc/adt/oo/classes/zcl_a/includes/main/versions';
const VIEW_FEED = '/sap/bc/adt/ddic/ddl/sources/zi_b/versions';
const VIEW = 'ZADTPLUS_A/ZADTPLUS_A_SUB/Core Data Services/Data Definitions/ZI_B/';
const SHADOW = (repo: string) => path.join(repo, '.git', 'adtplus', 'origin');

const v = (id: string, request: string, updated: string, content: string, author = 'DEVELOPER'): FakeVersion => ({
  id,
  request,
  description: { DEVK1: 'First', DEVK2: 'Second', DEVK3: 'Third' }[request] ?? request,
  author,
  updated,
  content,
});

let world: ReturnType<typeof gitWorld>;
beforeEach(() => {
  world = gitWorld();
});
afterEach(() => world.cleanup());

/** A system with two released requests over the class and the view, and one before `since`. */
function systemWithHistory() {
  const sys = fakeSystem(PACKAGE);
  const d = world.daemonWith(sys);
  d.rest.versions[CLASS_FEED] = [
    { id: '00000', author: 'DEVELOPER', updated: '2026-05-01T00:00:00Z', content: 'CLASS zcl_a DEFINITION.\r\nENDCLASS.\r\n' },
    v('00003', 'DEVK2', '2026-03-01T10:00:00Z', 'CLASS zcl_a DEFINITION.\r\nENDCLASS.\r\n', 'DEV2'),
    v('00002', 'DEVK1', '2025-12-01T10:00:00Z', 'CLASS zcl_a DEFINITION. "v1\r\nENDCLASS.\r\n'),
    v('00001', 'DEVK0', '2024-01-01T00:00:00Z', 'too old'),
  ];
  d.rest.versions[VIEW_FEED] = [v('00001', 'DEVK1', '2025-12-01T10:00:00Z', 'define view entity ZI_B as select from t000 { key mandt }')];
  d.rest.requests.DEVK1 = { owner: 'OWNER1', description: 'First' };
  d.rest.requests.DEVK2 = { owner: 'DEVELOPER', description: 'Second' };
  world.git('config', 'adtplus.history', 'transports');
  world.git('config', 'adtplus.since', '2025-10-01');
  return { sys, ...d };
}

describe('git fetch with transport history (G6)', () => {
  it('a clone: one commit per released request since adtplus.since, oldest first, then the sync commit', async () => {
    const { send } = systemWithHistory();
    const { said } = await world.fetchInto(send);
    const log = world.git('log', '--format=%an <%ae>|%at|%s|%(trailers:only,unfold,separator=%x2C)', REF).trim().split('\n');
    const at = (iso: string) => Date.parse(iso) / 1000;
    expect(log).toEqual([
      `ONPREM <adtplus@onprem.invalid>|${at('2026-10-07T08:00:00Z')}|ONPREM: ZADTPLUS_A at 2026-10-07T08:00:00Z|New: DTELDE ZDE_A,Changed: CLAS ZCL_A, DDLS ZI_B`,
      `DEV2 <dev2@onprem.invalid>|${at('2026-03-01T10:00:00Z')}|DEVK2: Second|Transport: DEVK2,Owner: DEVELOPER`,
      `DEVELOPER <developer@onprem.invalid>|${at('2025-12-01T10:00:00Z')}|DEVK1: First|Transport: DEVK1,Owner: OWNER1`,
    ]);
    // A request's commit holds its versions, as a pull writes files (LF).
    expect(world.git('show', `${REF}~2:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION. "v1\nENDCLASS.\n');
    expect(world.git('ls-tree', '-r', '--name-only', `${REF}~2`).trim().split('\n')).toEqual(['src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds', 'src/zadtplus_a/zcl_a.clas.abap']);
    expect(world.git('show', '--stat', '--format=', `${REF}~1`)).toContain('zcl_a.clas.abap');
    // The sync commit adds the rest: what no version holds.
    expect(world.git('ls-tree', '-r', '--name-only', REF).trim().split('\n')).toHaveLength(6);
    expect(said.join('\n')).toMatch(/3 released version\(s\) in 2 request\(s\), 2 version list\(s\) read/);
    expect(said).toContain('adtplus: 2 transport commit(s)');
    // The shadow's bases are the tip's state: a push can go ahead.
    expect(await shadowMatches(realGit(world.repo), SHADOW(world.repo), world.git('rev-parse', REF).trim())).toBe(true);
  });

  it('a later fetch: only the requests released since, from the released list, only their objects\' feeds read', async () => {
    const { send, rest, sys } = systemWithHistory();
    await world.fetchInto(send);
    const before = world.git('rev-parse', REF).trim();

    rest.versions[CLASS_FEED]!.splice(1, 0, v('00004', 'DEVK3', '2026-10-07T08:30:00Z', 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n'));
    sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap'] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    rest.requests.DEVK3 = { owner: 'DEVELOPER', description: 'Third' };
    rest.released.push(
      { number: 'DEVK2', owner: 'DEVELOPER', description: 'Second', objects: [{ pgmid: 'R3TR', type: 'CLAS', name: 'ZCL_A' }] },
      { number: 'DEVK3', owner: 'DEVELOPER', description: 'Third', objects: [{ pgmid: 'LIMU', type: 'METH', name: 'ZCL_A                         DO_IT' }] },
      { number: 'DEVK9', owner: 'X', description: 'elsewhere', objects: [{ pgmid: 'R3TR', type: 'CLAS', name: 'ZCL_OTHER' }] },
    );
    rest.calls.length = 0;
    const { said } = await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z');

    expect(said).toContain("adtplus: 2 request(s) released lately, 1 of the clone's objects in them");
    expect(rest.calls.filter((c) => c.endsWith('/versions'))).toEqual([CLASS_FEED]);
    // The change came with its release: no sync commit on top.
    expect(world.git('log', '--format=%s', `${before}..${REF}`).trim()).toBe('DEVK3: Third');
    expect(world.git('show', `${REF}:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION FINAL.\nENDCLASS.\n');
    expect(await shadowMatches(realGit(world.repo), SHADOW(world.repo), world.git('rev-parse', REF).trim())).toBe(true);

    // The same list again: nothing new.
    const again = await world.fetchInto(send, undefined, '2026-10-07T10:00:00Z');
    expect(again.stream).toBe('feature done\ndone\n');
  });

  it('an object a released request deleted: its files go in that request\'s commit', async () => {
    const { send, rest, sys } = systemWithHistory();
    await world.fetchInto(send);
    for (const p of Object.keys(sys.state.files)) if (p.startsWith(VIEW)) delete sys.state.files[p];
    rest.requests.DEVK3 = { owner: 'DEVELOPER', description: 'Third' };
    rest.released.push({ number: 'DEVK3', owner: 'DEVELOPER', description: 'Third', objects: [{ pgmid: 'R3TR', type: 'DDLS', name: 'ZI_B', deleted: true }] });
    await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(world.git('log', '-1', '--format=%s', REF).trim()).toBe('DEVK3: Third');
    expect(world.git('show', '--name-status', '--format=', REF).trim().split('\n')).toEqual([
      'D\tsrc/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds',
      'D\tsrc/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json',
    ]);
  });

  it('a fetch more than two weeks after the last: every feed read again, known requests never twice', async () => {
    const { send, rest } = systemWithHistory();
    await world.fetchInto(send);
    rest.versions[VIEW_FEED]!.unshift(v('00002', 'DEVK3', '2026-10-20T08:00:00Z', 'define view entity ZI_B as select from t000 { key mandt }  '));
    rest.requests.DEVK3 = { owner: 'DEVELOPER', description: 'Third' };
    rest.calls.length = 0;
    const { said } = await world.fetchInto(send, undefined, '2026-10-30T08:00:00Z');
    expect(said.join('\n')).toMatch(/last checked for releases 2026-10-07, more than 13 days ago/);
    // Read once, for the system clock only: too old to name what was released.
    expect(rest.calls.filter((c) => c === '/sap/bc/adt/cts/transportrequests')).toHaveLength(1);
    expect(rest.calls.filter((c) => c.endsWith('/versions')).sort()).toEqual([VIEW_FEED, CLASS_FEED]);
    expect(world.git('log', '--format=%s', REF).trim().split('\n').filter((s) => s.startsWith('DEVK'))).toEqual([
      'DEVK3: Third',
      'DEVK2: Second',
      'DEVK1: First',
    ]);
  });

  it('a clone dates each request by its release, less the system clock\'s offset; the order follows', async () => {
    const { send, rest } = systemWithHistory();
    rest.clock.offsetMinutes = 60;
    // Local times: DEVK1 released after DEVK2, whatever its versions' feed times say.
    rest.requests.DEVK1!.releasedLocal = '20260401113000';
    rest.requests.DEVK2!.releasedLocal = '20260301113000';
    await world.fetchInto(send);
    const log = world.git('log', '--format=%at %s', REF).trim().split('\n').slice(1);
    expect(log).toEqual([`${Date.parse('2026-04-01T10:30:00Z') / 1000} DEVK1: First`, `${Date.parse('2026-03-01T10:30:00Z') / 1000} DEVK2: Second`]);
  });

  it('one request without a release time of its own: every request takes its versions\' time, never a mix', async () => {
    const { send, rest } = systemWithHistory();
    rest.clock.offsetMinutes = 60;
    rest.requests.DEVK1!.releasedLocal = '20260401113000';
    await world.fetchInto(send);
    const log = world.git('log', '--format=%at %s', REF).trim().split('\n').slice(1);
    expect(log).toEqual([`${Date.parse('2026-03-01T10:00:00Z') / 1000} DEVK2: Second`, `${Date.parse('2025-12-01T10:00:00Z') / 1000} DEVK1: First`]);
  });

  it('a request that only deletes is dated by its release, not the fetch', async () => {
    const { send, rest, sys } = systemWithHistory();
    await world.fetchInto(send);
    rest.clock.offsetMinutes = 60;
    for (const p of Object.keys(sys.state.files)) if (p.startsWith(VIEW)) delete sys.state.files[p];
    rest.requests.DEVK3 = { owner: 'DEVELOPER', description: 'Third' };
    rest.released.push({
      number: 'DEVK3',
      owner: 'DEVELOPER',
      description: 'Third',
      releasedLocal: '20261007093000',
      objects: [{ pgmid: 'R3TR', type: 'DDLS', name: 'ZI_B', deleted: true }],
    });
    await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(world.git('log', '-1', '--format=%at %s', REF).trim()).toBe(`${Date.parse('2026-10-07T08:30:00Z') / 1000} DEVK3: Third`);
  });

  it('history switched on after the clone starts with that fetch', async () => {
    const { send } = systemWithHistory();
    world.git('config', 'adtplus.history', 'none');
    await world.fetchInto(send);
    world.git('config', 'adtplus.history', 'transports');
    const { said } = await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(said).toContain('adtplus: transport history starts with this fetch; a clone takes earlier releases');
    expect(world.git('log', '--format=%s', REF).trim().split('\n')).toHaveLength(1);
  });

  it('refuses an unknown history mode or since', async () => {
    const { send } = systemWithHistory();
    world.git('config', 'adtplus.history', 'all');
    await expect(world.fetchInto(send)).rejects.toThrow('adtplus.history must be none or transports, not "all"');
    world.git('config', 'adtplus.history', 'transports');
    world.git('config', 'adtplus.since', 'last year');
    await expect(world.fetchInto(send)).rejects.toThrow('adtplus.since must be a date');
  });

  it('a version list that fails is tried again at once, then on the next fetch, its requests\' commits appended then', async () => {
    const { send, rest } = systemWithHistory();
    rest.failFeeds.add(VIEW_FEED);
    const { said } = await world.fetchInto(send);
    expect(world.git('log', '--format=%s', REF).trim().split('\n').slice(1)).toEqual(['DEVK2: Second', 'DEVK1: First']);
    expect(world.git('ls-tree', '-r', '--name-only', `${REF}~1`).trim()).toBe('src/zadtplus_a/zcl_a.clas.abap');
    expect(said.join('\n')).toMatch(/versions not read: src\/zadtplus_a\/zadtplus_a_sub\/zi_b\.ddls\.acds: .*HTTP 500.*; read again on the next fetch/);
    // Read twice: the immediate retry.
    expect(rest.calls.filter((c) => c === VIEW_FEED)).toHaveLength(2);

    rest.failFeeds.clear();
    await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    // DEVK1 is in git already: the view's version of it isn't committed twice, nothing else is new.
    expect(world.git('log', '--format=%s', REF).trim().split('\n')).toHaveLength(3);
    const state = JSON.parse(readFileSync(path.join(SHADOW(world.repo), 'history.json'), 'utf8')) as { retry?: unknown };
    expect(state.retry).toBeUndefined();
  });

  it('a retried object\'s request git doesn\'t hold yet gets its commit on the next fetch', async () => {
    const { send, rest } = systemWithHistory();
    rest.versions[VIEW_FEED]!.unshift(v('00002', 'DEVK3', '2026-04-01T10:00:00Z', 'define view entity ZI_B as select from t000 { key mandt }  '));
    rest.requests.DEVK3 = { owner: 'DEVELOPER', description: 'Third' };
    rest.failFeeds.add(VIEW_FEED);
    await world.fetchInto(send);
    rest.failFeeds.clear();
    await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    // Its version is what the clone's sync commit already shows: the commit only names the request.
    expect(world.git('log', '-2', '--format=%s', REF).trim().split('\n')).toEqual(['DEVK3: Third', 'ONPREM: ZADTPLUS_A at 2026-10-07T08:00:00Z']);
  });

  it('a fetch stopped mid-read and resumed with a new release reads the done objects again', async () => {
    const { send, rest, sys } = systemWithHistory();
    await world.fetchInto(send);
    const release = (number: string, objects: Array<{ pgmid: string; type: string; name: string }>) => {
      rest.requests[number] = { owner: 'DEVELOPER', description: number };
      rest.released.push({ number, owner: 'DEVELOPER', description: number, objects });
    };
    rest.versions[CLASS_FEED]!.splice(1, 0, v('00004', 'DEVK3', '2026-10-07T08:30:00Z', 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n'));
    rest.versions[VIEW_FEED]!.unshift(v('00002', 'DEVK3', '2026-10-07T08:30:00Z', 'define view entity ZI_B as select from t000 { key mandt }  '));
    release('DEVK3', [{ pgmid: 'R3TR', type: 'CLAS', name: 'ZCL_A' }, { pgmid: 'R3TR', type: 'DDLS', name: 'ZI_B' }]);
    rest.throttleFeeds.add(VIEW_FEED);
    await expect(world.fetchInto(send, undefined, '2026-10-07T09:00:00Z')).rejects.toThrow('throttled');

    // Released in between: the class is in it too, though the stopped read had it done.
    rest.throttleFeeds.clear();
    rest.versions[CLASS_FEED]!.splice(1, 0, v('00005', 'DEVK4', '2026-10-07T09:10:00Z', 'CLASS zcl_a DEFINITION FINAL. "4\r\nENDCLASS.\r\n'));
    sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap'] = 'CLASS zcl_a DEFINITION FINAL. "4\r\nENDCLASS.\r\n';
    release('DEVK4', [{ pgmid: 'LIMU', type: 'CINC', name: 'ZCL_A=========================CCAU' }]);
    await world.fetchInto(send, undefined, '2026-10-07T09:20:00Z');
    expect(world.git('log', '-2', '--format=%s', REF).trim().split('\n')).toEqual(['DEVK4: DEVK4', 'DEVK3: DEVK3']);
    expect(world.git('show', `${REF}:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION FINAL. "4\nENDCLASS.\n');
  });

  it('the newest release equal to the active version takes the source, not the version store\'s rebuilt text', async () => {
    const { send, rest, sys } = systemWithHistory();
    const CLASS = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap';
    // As ONPREM keeps a class written in source form: the source as typed, the versions rebuilt.
    sys.state.files[CLASS] = 'CLASS zcl_a DEFINITION.\r\nENDCLASS.\r\nCLASS zcl_a IMPLEMENTATION.\r\nENDCLASS.\r\n';
    const rebuilt = 'CLASS zcl_a DEFINITION.\r\nENDCLASS.\r\nCLASS ZCL_A IMPLEMENTATION.\r\n\r\n\r\nENDCLASS.\r\n';
    rest.versions[CLASS_FEED]![0]!.content = rebuilt;
    rest.versions[CLASS_FEED]![1]!.content = rebuilt;
    const { said } = await world.fetchInto(send);
    // DEVK2 (newest) holds the source; DEVK1 (older) the version store's text, the only one there is.
    expect(world.git('show', `${REF}~1:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\nENDCLASS.\n');
    expect(world.git('show', `${REF}~2:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION. "v1\nENDCLASS.\n');
    expect(world.git('diff', '--name-only', `${REF}~1`, REF)).not.toContain('zcl_a.clas.abap');
    expect(said.join('\n')).toMatch(/1 newest release\(s\) as the source/);

    // Changed after the release (the active version differs): the release keeps the version's text.
    rest.versions[CLASS_FEED]![0]!.content = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    rest.versions[CLASS_FEED]!.splice(1, 0, v('00004', 'DEVK3', '2026-10-07T08:30:00Z', rebuilt));
    rest.requests.DEVK3 = { owner: 'DEVELOPER', description: 'Third' };
    rest.released.push({ number: 'DEVK3', owner: 'DEVELOPER', description: 'Third', objects: [{ pgmid: 'R3TR', type: 'CLAS', name: 'ZCL_A' }] });
    sys.state.files[CLASS] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(world.git('show', `${REF}~1:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION.\nENDCLASS.\nCLASS ZCL_A IMPLEMENTATION.\n\n\nENDCLASS.\n');
  });

  it('the user\'s own draft keeps the release\'s text: the pulled file is the draft; another user\'s draft doesn\'t', async () => {
    const { send, rest, sys } = systemWithHistory();
    const CLASS = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap';
    const rebuilt = 'CLASS ZCL_A DEFINITION.\r\n\r\nENDCLASS.\r\n';
    rest.versions[CLASS_FEED]![0]!.content = rebuilt;
    rest.versions[CLASS_FEED]![1]!.content = rebuilt;
    // Another user's draft is in the feed, but the pull reads the active source.
    rest.versions[CLASS_FEED]!.unshift({ id: '99999', author: 'OTHER', updated: '2026-06-01T00:00:00Z', content: 'draft' });
    await world.fetchInto(send);
    expect(world.git('show', `${REF}~1:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION.\nENDCLASS.\n');

    // The user's own draft: the pull reads it, so it is no active state.
    const again = gitWorld();
    try {
      const d = again.daemonWith(sys);
      Object.assign(d.rest.versions, rest.versions);
      Object.assign(d.rest.requests, rest.requests);
      sys.state.drafts.add(CLASS);
      again.git('config', 'adtplus.history', 'transports');
      again.git('config', 'adtplus.since', '2025-10-01');
      await again.fetchInto(d.send);
      expect(again.git('show', `${REF}~1:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS ZCL_A DEFINITION.\n\nENDCLASS.\n');
    } finally {
      await again.cleanup();
    }
  });

  it('a pulled file that differs by more than layout keeps the release\'s text, and costs no read of the active version', async () => {
    const { send, rest, sys } = systemWithHistory();
    // Changed after the pull would have read it: the file is a later state than the release.
    sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap'] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    rest.versions[CLASS_FEED]![1]!.content = 'CLASS ZCL_A DEFINITION.\r\nENDCLASS.\r\n';
    rest.versions[CLASS_FEED]![0]!.content = 'CLASS ZCL_A DEFINITION.\r\nENDCLASS.\r\n';
    rest.calls.length = 0;
    await world.fetchInto(send);
    expect(world.git('show', `${REF}~1:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS ZCL_A DEFINITION.\nENDCLASS.\n');
    expect(rest.calls.filter((c) => c.endsWith('/00000/content'))).toEqual([]);
  });

  it('a deletion goes to the request that marks it, not to one that only changed the object', async () => {
    const { send, rest, sys } = systemWithHistory();
    await world.fetchInto(send);
    for (const p of Object.keys(sys.state.files)) if (p.startsWith(VIEW)) delete sys.state.files[p];
    rest.versions[VIEW_FEED]!.unshift(v('00002', 'DEVK3', '2026-10-07T08:30:00Z', 'define view entity ZI_B as select from t000 { key mandt }  '));
    for (const [number, deleted] of [['DEVK3', false], ['DEVK4', true]] as const) {
      rest.requests[number] = { owner: 'DEVELOPER', description: number };
      rest.released.push({ number, owner: 'DEVELOPER', description: number, objects: [{ pgmid: 'R3TR', type: 'DDLS', name: 'ZI_B', deleted }] });
    }
    // The view's feed after its deletion: what the clone never reads, since the object is gone.
    await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(world.git('log', '--format=%s', REF).trim().split('\n').slice(0, 1)).toEqual(['DEVK4: DEVK4']);
    expect(world.git('show', '--name-status', '--format=', REF).trim().split('\n')).toEqual([
      'D\tsrc/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds',
      'D\tsrc/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json',
    ]);
  });
});

describe('released entries → the clone\'s objects', () => {
  const ids = ['CLAS ZCL_A', 'PROG ZP', 'FUGR ZFG', 'DTELDE ZDE_A'];
  const parts = new Map([['LZFGTOP', 'FUGR ZFG'], ['Z_FM', 'FUGR ZFG']]);
  const of = (pgmid: string, type: string, name: string) => ownersOfEntry({ pgmid, type, name, deleted: false }, ids, parts);
  it('maps objects and their parts', () => {
    expect(of('R3TR', 'CLAS', 'ZCL_A')).toEqual(['CLAS ZCL_A']);
    expect(of('LIMU', 'METH', 'ZCL_A                         DO_IT')).toEqual(['CLAS ZCL_A']);
    expect(of('LIMU', 'CPUB', 'ZCL_A')).toEqual(['CLAS ZCL_A']);
    expect(of('LIMU', 'REPS', 'ZP')).toEqual(['PROG ZP']);
    expect(of('LIMU', 'REPS', 'LZFGTOP')).toEqual(['FUGR ZFG']);
    expect(of('LIMU', 'FUNC', 'Z_FM')).toEqual(['FUGR ZFG']);
    expect(of('R3TR', 'DTEL', 'ZDE_A')).toEqual(['DTELDE ZDE_A']);
    expect(of('LIMU', 'CINC', 'ZCL_A=========================CCAU')).toEqual(['CLAS ZCL_A']);
    expect(of('LIMU', 'CINC', 'ZCL_A=========================CCIMP')).toEqual(['CLAS ZCL_A']);
    expect(of('R3TR', 'CLAS', 'ZCL_OTHER')).toEqual([]);
    expect(of('R3TR', 'PROG', 'ZCL_A')).toEqual([]);
  });
});
