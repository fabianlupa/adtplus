import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import { RawAdtError, type RawAdtClient } from '../../src/backends/rawadt.js';
import { ThrottledError } from '../../src/daemon/ratelimit.js';
import * as transport from '../../src/capabilities/transport.js';
import type { Destination } from '../../src/core/destinations.js';

/** Objects resolve into package ZADTPLUS_TEST unless named ZCL_FOREIGN (core/placement.ts). */
function fakeAdt(): AdtLsClient {
  return {
    lifecycle: {
      resolveAffUri: vi.fn(async (ref: { name: string }) => {
        const pkg = ref.name === 'ZCL_FOREIGN' ? 'ZADTPLUS_ELSEWHERE' : 'ZADTPLUS_TEST';
        return `abap:/repotree-v1/adtplus_onprem/System%20Library/${pkg}/Source%20Code%20Library/Classes/${ref.name}/${ref.name.toLowerCase()}.clas.abap`;
      }),
    },
    repository: {
      readFile: vi.fn(async () => 'source'),
      readDirectory: vi.fn(async () => [
        { name: 'zcl_x.clas.abap', kind: 'file' },
        { name: 'zcl_x.clas.implementations.abap', kind: 'file' },
        { name: 'zcl_x.clas.json', kind: 'file' },
        { name: 'zcl_x.clas.texts.en.properties', kind: 'file' },
        // Another object's file in the same folder (a function group's modules share one).
        { name: 'zcl_y.clas.abap', kind: 'file' },
      ]),
    },
    raw: { lsp: vi.fn(async () => true) },
    transport: {
      list: vi.fn(async () => ({ transportRequests: [] })),
      find: vi.fn(async () => ({})),
      // Locked in a request unless a test says otherwise.
      check: vi.fn(async () => ({ isLockedInRequests: true, locks: [{ number: 'DEVK901733' }] })),
      create: vi.fn(async () => ({ transportRequestNumber: 'DEVK999999' })),
      // The SDK's lock read-back names DEVK901733 unless a test overrides it.
      assign: vi.fn(async (args: { name: string; objectType: string; transport: string }) => ({
        ...args,
        object: args.name,
        assigned: true,
        lockedIn: ['DEVK901733'],
      })),
    },
  } as unknown as AdtLsClient;
}

const destination: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: ['ZADTPLUS_TEST'],
};

describe('transport capability', () => {
  it('list/find/check pass through to the SDK', async () => {
    const adt = fakeAdt();
    await transport.list(adt, { query: 'DEVELOPER' });
    expect(adt.transport.list).toHaveBeenCalledWith({ query: 'DEVELOPER' });

    await transport.find(adt, {
      objectName: 'ZCL_X',
      objectType: 'CLAS/OC',
      developmentPackage: 'ZADTPLUS_TEST',
      isCreation: true,
    });
    expect(adt.transport.find).toHaveBeenCalled();

    await transport.check(adt, { name: 'ZCL_X', objectType: 'CLAS/OC', operation: 'MODIFY' });
    expect(adt.transport.check).toHaveBeenCalledWith({ name: 'ZCL_X', objectType: 'CLAS/OC', operation: 'MODIFY' });
  });

  describe('assign', () => {
    const sdkAssign = (adt: AdtLsClient) => vi.mocked(adt.transport.assign);
    const lockedIn = (adt: AdtLsClient, locks: { number: string }[], assigned = true) =>
      sdkAssign(adt).mockImplementation(async (args: { name: string; objectType: string; transport: string }) => ({
        ...args,
        object: args.name,
        assigned,
        lockedIn: locks.map((l) => l.number),
      }));

    it('assigns through the SDK and confirms from its lock read-back', async () => {
      const adt = fakeAdt();
      const result = await transport.assign(adt, destination, {
        name: 'ZCL_X',
        objectType: 'CLAS/OC',
        transport: 'devk901733',
      });
      expect(sdkAssign(adt)).toHaveBeenCalledWith({
        name: 'ZCL_X',
        objectType: 'CLAS/OC',
        uri: expect.any(String),
        transport: 'DEVK901733',
      });
      expect(result).toEqual({
        assigned: true,
        object: 'ZCL_X',
        objectType: 'CLAS/OC',
        transport: 'DEVK901733',
        lockedIn: 'DEVK901733',
      });
    });

    it('fails when SAP shows no lock (a transport that does not exist)', async () => {
      const adt = fakeAdt();
      lockedIn(adt, [], false);
      await expect(
        transport.assign(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'DEVK000000' }),
      ).rejects.toThrow(/DEVK000000 was not assigned .*SAP shows no lock on it/);
    });

    // The SDK reports `assigned: true` whenever the object had no lock before,
    // even if the lock then names another request.
    it('fails when the SDK says assigned but the lock names a different request', async () => {
      const adt = fakeAdt();
      lockedIn(adt, [{ number: 'DEVK901733' }]);
      await expect(
        transport.assign(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'DEVK000000' }, async () => [
          'DEVK901734',
        ]),
      ).rejects.toThrow(/SAP shows it locked in DEVK901733/);
    });

    it('accepts a task number through its parent request', async () => {
      const adt = fakeAdt();
      const readTasks = vi.fn(async () => ['DEVK901734']);
      const result = await transport.assign(
        adt,
        destination,
        { name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'DEVK901734' },
        readTasks,
      );
      expect(readTasks).toHaveBeenCalledWith('DEVK901733');
      expect(result).toMatchObject({ transport: 'DEVK901734', lockedIn: 'DEVK901733' });
    });

    it('assigns an object in no open request for its next write, without a check after the assign', async () => {
      const adt = fakeAdt();
      vi.mocked(adt.transport.check).mockResolvedValue({ isLockedInRequests: false, locks: [] });
      const result = await transport.assign(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'devk901800' });
      expect(result).toMatchObject({ assigned: 'onNextWrite', transport: 'DEVK901800', lockedIn: null, note: expect.stringContaining('next write') });
      // adt-ls keeps an assignment per file: each file adt+ writes gets one (not the `.properties`).
      expect(vi.mocked(adt.raw.lsp).mock.calls.map(([m, p]) => [m, String((p as { objectUri: string }).objectUri).split('/').pop(), (p as { transport: string }).transport])).toEqual(
        ['zcl_x.clas.abap', 'zcl_x.clas.implementations.abap', 'zcl_x.clas.json'].map((f) => ['adtLs/cts/transport/assignTransportToObject', f, 'DEVK901800']),
      );
      // The SDK's assign reads the lock back, which would cancel the assignment.
      expect(sdkAssign(adt)).not.toHaveBeenCalled();
      expect(adt.transport.check).toHaveBeenCalledTimes(1);
    });

    it('refuses an object that records no changes (local package)', async () => {
      const adt = fakeAdt();
      vi.mocked(adt.transport.check).mockResolvedValue({ isRecordingRequired: false, isLockedInRequests: false, locks: [] });
      await expect(transport.assign(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'DEVK901800' })).rejects.toThrow(
        /needs no transport/,
      );
      expect(adt.raw.lsp).not.toHaveBeenCalled();
    });

    it('a file other than the main source that refuses the assignment costs only that file', async () => {
      const adt = fakeAdt();
      vi.mocked(adt.transport.check).mockResolvedValue({ isLockedInRequests: false, locks: [] });
      vi.mocked(adt.raw.lsp).mockImplementation(async (_m: string, p: unknown) => {
        if (String((p as { objectUri: string }).objectUri).endsWith('.json')) throw new Error("The Semantic file store doesn't exist");
        return true;
      });
      const result = await transport.assign(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'devk901800' });
      expect(result).toMatchObject({ assigned: 'onNextWrite', unassigned: ['zcl_x.clas.json'], note: expect.stringContaining('not zcl_x.clas.json') });
      expect(adt.raw.lsp).toHaveBeenCalledTimes(3);
    });

    it('assigns the main source alone when the folder cannot be read', async () => {
      const adt = fakeAdt();
      vi.mocked(adt.transport.check).mockResolvedValue({ isLockedInRequests: false, locks: [] });
      vi.mocked(adt.repository.readDirectory).mockRejectedValue(new Error('no folder'));
      await transport.assign(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'devk901800' });
      expect(adt.raw.lsp).toHaveBeenCalledTimes(1);
      expect(adt.raw.lsp).toHaveBeenCalledWith('adtLs/cts/transport/assignTransportToObject', {
        objectUri: expect.stringContaining('/ZCL_X/zcl_x.clas.abap'),
        transport: 'DEVK901800',
      });
    });

    // ONPREM answers `isRecordingRequired: false` for an object already locked in an open request.
    it('assigns an object that is locked in a request though the check says it needs no recording', async () => {
      const adt = fakeAdt();
      vi.mocked(adt.transport.check).mockResolvedValue({ isRecordingRequired: false, isLockedInRequests: true, locks: [{ number: 'DEVK901733' }] });
      const result = await transport.assign(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'DEVK901733' });
      expect(result).toMatchObject({ assigned: true, lockedIn: 'DEVK901733' });
    });

    it('a task number without a task reader fails as unconfirmed', async () => {
      const adt = fakeAdt();
      await expect(
        transport.assign(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'DEVK901734' }),
      ).rejects.toThrow(/was not assigned/);
    });
  });

  it('create refuses a package outside the write allowlist', async () => {
    const adt = fakeAdt();
    await expect(
      transport.create(adt, destination, {
        developmentPackage: 'ZNOT_ALLOWED',
        transportDescription: 'nope',
        isCreation: true,
        objectName: 'ZCL_X',
        objectType: 'CLAS/OC',
      }),
    ).rejects.toThrow(/not in the write allowlist/);
    expect(adt.transport.create).not.toHaveBeenCalled();
  });

  it('create gives adt-ls the subtype for a bare type, and refuses a bare type it can\'t map', async () => {
    const adt = fakeAdt();
    const input = { developmentPackage: 'ZADTPLUS_TEST', transportDescription: 'x', isCreation: true, objectName: 'ZCL_X' };
    await transport.create(adt, destination, { ...input, objectType: 'clas' });
    expect(adt.transport.create).toHaveBeenLastCalledWith({ ...input, objectType: 'CLAS/OC' });
    await transport.create(adt, destination, { ...input, objectType: 'DDLS/DF' });
    expect(adt.transport.create).toHaveBeenLastCalledWith({ ...input, objectType: 'DDLS/DF' });
    await expect(transport.create(adt, destination, { ...input, objectType: 'FUGR' })).rejects.toThrow(/"FUGR": give it with its subtype/);
    expect(adt.transport.create).toHaveBeenCalledTimes(2);
  });

  it('assign refuses an object outside the write allowlist', async () => {
    const adt = fakeAdt();
    await expect(
      transport.assign(adt, destination, { name: 'ZCL_FOREIGN', objectType: 'CLAS/OC', transport: 'DEVK901733' }),
    ).rejects.toThrow(/package "ZADTPLUS_ELSEWHERE" is not in the write allowlist/);
    expect(adt.transport.assign).not.toHaveBeenCalled();
  });

  it('create for an existing object checks where it really is, not the package the caller names', async () => {
    const adt = fakeAdt();
    await expect(
      transport.create(adt, destination, {
        developmentPackage: 'ZADTPLUS_TEST',
        transportDescription: 'claims the allowlisted package',
        isCreation: false,
        objectName: 'ZCL_FOREIGN',
        objectType: 'CLAS/OC',
      }),
    ).rejects.toThrow(/package "ZADTPLUS_ELSEWHERE" is not in the write allowlist/);
    expect(adt.transport.create).not.toHaveBeenCalled();
  });
});

const organizerXml = (taskStatus = 'D', owner = 'DEVELOPER', status = 'D', type = 'K') =>
  '<?xml version="1.0" encoding="utf-8"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm">' +
  '<tm:workbench><tm:target tm:name="VIR"><tm:modifiable>' +
  `<tm:request tm:number="DEVK900001" tm:owner="${owner}" tm:desc="adt+ &amp; test" tm:type="${type}" tm:status="${status}" tm:target="VIR">` +
  `<tm:task tm:number="DEVK900002" tm:owner="DEVELOPER" tm:status="${taskStatus}"><tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZADTPLUS_ADTP_P1"/></tm:task>` +
  '<tm:task tm:number="DEVK900003" tm:owner="DEVELOPER" tm:status="D"/>' +
  '</tm:request>' +
  '</tm:modifiable></tm:target></tm:workbench></tm:root>';

/** A task's document (ONPREM, 2026-10-10): `object_type="T"`, its request first, then the task. */
const taskXml = (owner = 'DEVELOPER', status = 'D') =>
  '<tm:root tm:object_type="T" xmlns:tm="http://www.sap.com/cts/adt/tm">' +
  '<tm:request tm:number="DEVK900001" tm:owner="MEIER" tm:status="D" tm:target="VIR"><tm:long_desc/></tm:request>' +
  `<tm:task tm:number="DEVK900002" tm:owner="${owner}" tm:status="${status}" tm:status_text="Modifiable">` +
  '<tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZADTPLUS_ADTP_P1"/></tm:task></tm:root>';

const releaseXml = (status: string, message?: string) =>
  '<tm:root xmlns:tm="x" xmlns:chkrun="y"><tm:releasereports>' +
  `<chkrun:checkReport chkrun:reporter="transportrelease" chkrun:status="${status}" chkrun:statusText="Status ${status}">` +
  (message ? `<chkrun:checkMessageList><chkrun:checkMessage chkrun:type="E" chkrun:shortText="${message}"/></chkrun:checkMessageList>` : '') +
  '</chkrun:checkReport></tm:releasereports></tm:root>';

describe('transport release (REST fallback)', () => {
  /** `documents`: the organizer document per number; the logon user from system information, `user`. */
  function fakeRestFor(
    releases: Record<string, string>,
    documents: Record<string, string> = { DEVK900001: organizerXml() },
    user: string | null | ThrottledError = 'developer',
  ): RawAdtClient & { posts: string[] } {
    const posts: string[] = [];
    return {
      posts,
      expectOk: vi.fn(async (method: string, path: string, context: string) => {
        if (path.endsWith('/systeminformation')) {
          if (user instanceof ThrottledError) throw user;
          if (!user) throw new RawAdtError(404, undefined, 'not found', context);
          return { status: 200, headers: new Headers(), body: JSON.stringify({ systemID: 'DEV', userName: user }) };
        }
        const id = method === 'GET' ? path.split('/').at(-1)! : path.split('/').at(-2)!;
        if (method === 'GET') {
          if (documents[id] === undefined) throw new RawAdtError(404, undefined, 'not found', context);
          return { status: 200, headers: new Headers(), body: documents[id] };
        }
        posts.push(id);
        const body = releases[id];
        if (body === undefined) throw new RawAdtError(500, undefined, 'unexpected', context);
        return { status: 200, headers: new Headers(), body };
      }),
    } as unknown as RawAdtClient & { posts: string[] };
  }

  it('parses the request, its tasks, and decodes attributes', () => {
    expect(transport.parseTransportRequest(organizerXml(), 'DEVK900001')).toEqual({
      number: 'DEVK900001',
      owner: 'DEVELOPER',
      status: 'D',
      description: 'adt+ & test',
      target: 'VIR',
      lastChanged: '',
      tasks: [
        { number: 'DEVK900002', owner: 'DEVELOPER', status: 'D' },
        { number: 'DEVK900003', owner: 'DEVELOPER', status: 'D' },
      ],
    });
    expect(transport.parseTransportRequest(organizerXml(), 'DEVK999999')).toBeUndefined();
  });

  it('requires confirm', async () => {
    const rest = fakeRestFor({});
    await expect(transport.release(rest, destination, { transport: 'DEVK900001' })).rejects.toThrow(/confirm: true/);
    expect(rest.expectOk).not.toHaveBeenCalled();
  });

  it('refuses a request of another owner', async () => {
    const rest = fakeRestFor({}, { DEVK900001: organizerXml('D', 'MEIER') });
    await expect(transport.release(rest, destination, { transport: 'devk900001', confirm: true })).rejects.toThrow(
      /request DEVK900001 belongs to MEIER, not DEVELOPER/,
    );
    expect(rest.posts).toEqual([]);
  });

  it('refuses a released request', async () => {
    const rest = fakeRestFor({}, { DEVK900001: organizerXml('R', 'DEVELOPER', 'R') });
    await expect(transport.release(rest, destination, { transport: 'DEVK900001', confirm: true })).rejects.toThrow(/not modifiable \(status R/);
    expect(rest.posts).toEqual([]);
  });

  it('refuses a request that is not a workbench or customizing request', async () => {
    const rest = fakeRestFor({}, { DEVK900001: organizerXml('D', 'DEVELOPER', 'D', 'T') });
    await expect(transport.release(rest, destination, { transport: 'DEVK900001', confirm: true })).rejects.toThrow(
      /request DEVK900001 is of type T: only workbench \(K\) and customizing \(W\)/,
    );
    expect(rest.posts).toEqual([]);
  });

  it('passes the rate limit\'s refusal on instead of falling back to the configured user', async () => {
    const throttled = new ThrottledError('over the budget', 10);
    const rest = fakeRestFor({}, undefined, throttled);
    await expect(transport.release(rest, { ...destination, user: 'DEVELOPER' }, { transport: 'DEVK900001', confirm: true })).rejects.toBe(throttled);
    expect(rest.posts).toEqual([]);
  });

  it('a task document without its request is still released as a task, once', async () => {
    const xml = taskXml().replace(/<tm:request\b[\s\S]*?<\/tm:request>/, '');
    const rest = fakeRestFor({ DEVK900002: releaseXml('released') }, { DEVK900002: xml });
    const res = await transport.release(rest, destination, { transport: 'DEVK900002', confirm: true });
    expect(rest.posts).toEqual(['DEVK900002']);
    expect(res.request).toBeUndefined();
    expect(res.releasedTasks).toEqual(['DEVK900002']);
  });

  it('falls back to the configured user, and refuses when no user is known', async () => {
    const released = { DEVK900002: releaseXml('released'), DEVK900003: releaseXml('released'), DEVK900001: releaseXml('released') };
    const withUser = fakeRestFor(released, undefined, null);
    await transport.release(withUser, { ...destination, user: 'developer' }, { transport: 'DEVK900001', confirm: true });
    expect(withUser.posts).toEqual(['DEVK900002', 'DEVK900003', 'DEVK900001']);

    const noUser = fakeRestFor(released, undefined, null);
    await expect(transport.release(noUser, destination, { transport: 'DEVK900001', confirm: true })).rejects.toThrow(/logon user is unknown/);
    expect(noUser.posts).toEqual([]);
  });

  it('releases unreleased tasks first, then the request', async () => {
    const rest = fakeRestFor({ DEVK900002: releaseXml('released'), DEVK900003: releaseXml('released'), DEVK900001: releaseXml('released') });

    const res = await transport.release(rest, destination, { transport: 'DEVK900001', confirm: true });

    expect(rest.posts).toEqual(['DEVK900002', 'DEVK900003', 'DEVK900001']);
    expect(res).toMatchObject({
      transport: 'DEVK900001',
      target: 'VIR',
      releasedTasks: ['DEVK900002', 'DEVK900003'],
      via: 'rest-fallback',
      nativeAvailable: null,
    });
    expect(res.request).toBeUndefined();
  });

  it('skips released tasks', async () => {
    const rest = fakeRestFor({ DEVK900003: releaseXml('released'), DEVK900001: releaseXml('released') }, { DEVK900001: organizerXml('R') });
    const res = await transport.release(rest, destination, { transport: 'DEVK900001', confirm: true });
    expect(rest.posts).toEqual(['DEVK900003', 'DEVK900001']);
    expect(res.releasedTasks).toEqual(['DEVK900003']);
  });

  it('a task with objects that fails stops before the request, with the task\'s messages', async () => {
    const rest = fakeRestFor({
      DEVK900002: releaseXml('abortrelapifail', 'Object CLSD ZCL_X is inactive'),
      DEVK900001: releaseXml('released'),
    });
    await expect(transport.release(rest, destination, { transport: 'DEVK900001', confirm: true })).rejects.toThrow(
      /DEVK900001 was not released: its task DEVK900002 failed:[\s\S]*Object CLSD ZCL_X is inactive/,
    );
    expect(rest.posts).toEqual(['DEVK900002']);
  });

  it('an empty task that fails is folded into the request release; a failed request release is fatal', async () => {
    const rest = fakeRestFor({
      DEVK900002: releaseXml('released'),
      DEVK900003: releaseXml('abortrelapifail'),
      DEVK900001: releaseXml('abortrelapifail', 'Objekt gesperrt'),
    });
    await expect(transport.release(rest, destination, { transport: 'DEVK900001', confirm: true })).rejects.toThrow(
      /DEVK900001 was not released:\n[\s\S]*Objekt gesperrt/,
    );
    expect(rest.posts).toEqual(['DEVK900002', 'DEVK900003', 'DEVK900001']);
  });

  it('a task holding only translations (LANG) isn\'t empty: its failure stops the release', async () => {
    const withLang = organizerXml().replace(
      '<tm:task tm:number="DEVK900003" tm:owner="DEVELOPER" tm:status="D"/>',
      '<tm:task tm:number="DEVK900003" tm:owner="DEVELOPER" tm:status="D"><tm:abap_object tm:pgmid="LANG" tm:type="MSAG" tm:name="ZADTPLUS_M"/></tm:task>',
    );
    const rest = fakeRestFor(
      { DEVK900002: releaseXml('released'), DEVK900003: releaseXml('abortrelapifail', 'LANG MSAG ZADTPLUS_M gesperrt'), DEVK900001: releaseXml('released') },
      { DEVK900001: withLang },
    );
    await expect(transport.release(rest, destination, { transport: 'DEVK900001', confirm: true })).rejects.toThrow(
      /its task DEVK900003 failed[\s\S]*ZADTPLUS_M gesperrt/,
    );
    expect(rest.posts).toEqual(['DEVK900002', 'DEVK900003']);
  });

  it('releases an own task in someone else\'s request, and only the task', async () => {
    const rest = fakeRestFor({ DEVK900002: releaseXml('released') }, { DEVK900002: taskXml() });
    const res = await transport.release(rest, destination, { transport: 'devk900002', confirm: true });
    expect(rest.posts).toEqual(['DEVK900002']);
    expect(res).toMatchObject({ transport: 'DEVK900002', request: 'DEVK900001', target: '', releasedTasks: ['DEVK900002'] });
  });

  it('refuses a task of another owner, and a released one', async () => {
    const foreign = fakeRestFor({}, { DEVK900002: taskXml('MEIER') });
    await expect(transport.release(foreign, destination, { transport: 'DEVK900002', confirm: true })).rejects.toThrow(
      /task DEVK900002 belongs to MEIER, not DEVELOPER/,
    );
    const released = fakeRestFor({}, { DEVK900002: taskXml('DEVELOPER', 'R') });
    await expect(transport.release(released, destination, { transport: 'DEVK900002', confirm: true })).rejects.toThrow(
      /task DEVK900002 is not modifiable/,
    );
    expect([...foreign.posts, ...released.posts]).toEqual([]);
  });

  it('a failed task release reports the task\'s messages', async () => {
    const rest = fakeRestFor({ DEVK900002: releaseXml('abortrelapifail', 'Object CPUB ZCL_X is inactive') }, { DEVK900002: taskXml() });
    await expect(transport.release(rest, destination, { transport: 'DEVK900002', confirm: true })).rejects.toThrow(
      /task DEVK900002 was not released:[\s\S]*Object CPUB ZCL_X is inactive/,
    );
  });
});
