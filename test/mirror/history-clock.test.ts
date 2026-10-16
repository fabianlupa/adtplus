import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawAdtClient } from '../../src/backends/rawadt.js';
import type { ClockRead } from '../../src/core/clock.js';
import { historyVersions, releasedRequests, type HistoryIndex } from '../../src/mirror/history.js';
import { emptyManifest, saveManifest } from '../../src/mirror/manifest.js';
import { contentHash } from '../../src/mirror/normalize.js';

// The version feed's times on ONPREM's scale (2026-10-12): an hour behind UTC (ADR-016).
const FEED = '/sap/bc/adt/oo/interfaces/zif_x/source/main/versions';
const CONTENT = `${FEED}/1/00001/content`;
const ONPREM: ClockRead = { localOffsetMinutes: 60, feedOffsetMinutes: -60, measuredAt: 'x' };

let ws: string;
let root: string;
beforeEach(async () => {
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-history-')));
  root = path.join(ws, 'mirror');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/zif_x.intf.abap'), 'INTERFACE zif_x.\nENDINTERFACE.\n');
  await saveManifest(root, {
    ...emptyManifest('onprem'),
    adtLs: '1.1.2',
    objects: { 'INTF ZIF_X': { package: 'ZADTPLUS_A', dir: 'src', files: { 'zif_x.intf.abap': { hash: contentHash('INTERFACE zif_x.\nENDINTERFACE.\n') } } } },
  });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

function rest(): RawAdtClient {
  const bodies: Record<string, string> = {
    [FEED]:
      '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:adtcore="a"><atom:entry><atom:author><atom:name>DEV-A</atom:name></atom:author>' +
      `<atom:content type="text/plain" src="${CONTENT}"/><atom:id>00001</atom:id>` +
      '<atom:link adtcore:name="DEVK1" href="/x" type="application/vnd.sap.adt.transportrequests.v1+xml" title="t"/>' +
      '<atom:updated>2026-10-07T07:38:21Z</atom:updated></atom:entry></atom:feed>',
    [CONTENT]: 'INTERFACE zif_x.\nENDINTERFACE.\n',
    '/sap/bc/adt/cts/transportrequests/DEVK1': '<tm:root xmlns:tm="t"><tm:request tm:number="DEVK1" tm:owner="DEV-A" tm:lastchanged_timestamp="20261007093832"/></tm:root>',
    '/sap/bc/adt/cts/transportrequests': '<tm:root xmlns:tm="t" xmlns:adtcore="a" adtcore:changedAt="2026-01-01T00:00:00Z"/>',
  };
  return {
    expectOk: async (_m: string, p: string) => {
      if (bodies[p] === undefined) throw new Error(`unexpected ${p}`);
      return { status: 200, headers: new Headers(), body: bodies[p] };
    },
  } as unknown as RawAdtClient;
}

const run = (clock: ClockRead | undefined, id = 'clone 2026-10-01') =>
  historyVersions({ withRest: (fn) => fn(rest()), concurrency: 1, clock }, { root, workspaceFolders: [ws], system: 'onprem', run: id, since: '2026-10-07T08:00:00Z' });
const index = async () => JSON.parse(await readFile(path.join(root, 'history/index.json'), 'utf8')) as HistoryIndex;

describe('history.versions and the system clock (ADR-016)', () => {
  it('writes UTC times, filters `since` on them, and returns the clock offset', async () => {
    const res = await run(ONPREM);
    expect(res).toMatchObject({ versions: 1, localOffsetMinutes: 60 });
    expect((await index()).versions[0]!.at).toBe('2026-10-07T08:38:21Z');
  });

  it('leaves the feed time as sent without a clock, so `since` drops it', async () => {
    expect(await run(undefined)).toMatchObject({ versions: 0 });
  });

  it('starts an index over when its times are in another scale', async () => {
    await run({ localOffsetMinutes: 0, feedOffsetMinutes: 0, measuredAt: 'x' });
    expect((await index()).versions).toEqual([]);
    expect((await index()).done).toEqual(['INTF ZIF_X']);
    await run(ONPREM);
    expect((await index()).versions.map((v) => v.at)).toEqual(['2026-10-07T08:38:21Z']);
  });
});

describe('history.released and the system clock', () => {
  it("takes the shared measurement over the list's own time", async () => {
    expect(await releasedRequests({ withRest: (fn) => fn(rest()), concurrency: 1, clock: ONPREM })).toMatchObject({ clockOffsetMinutes: 60 });
  });
});
