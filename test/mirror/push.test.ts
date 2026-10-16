import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination } from '../../src/core/destinations.js';
import { ThrottledError } from '../../src/daemon/ratelimit.js';
import { contentHash } from '../../src/mirror/normalize.js';
import { init, pull } from '../../src/mirror/pull.js';
import { activateMirror } from '../../src/mirror/activate.js';
import { push, type PushDeps } from '../../src/mirror/push.js';
import { status } from '../../src/mirror/status.js';
import { PACKAGE, fakeDeps, fakeSystem } from './fake.js';

let ws: string;
let root: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-push-')));
  root = path.join(ws, 'mirror');
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const destination = (allow: Destination['writeAllowlist'] = [{ package: 'ZADTPLUS_A', subpackages: true }]): Destination => ({
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: allow,
});
const loc = () => ({ root, workspaceFolders: [ws], system: 'onprem' });
const file = (rel: string) => path.join(root, ...rel.split('/'));
const read = (rel: string) => readFileSync(file(rel), 'utf8');
const write = (rel: string, text: string) => writeFileSync(file(rel), text);
const manifest = () => JSON.parse(read('.adtplus/mirror.json'));

const CLS = 'src/zadtplus_a/zcl_a.clas.abap';
const CLS_JSON = 'src/zadtplus_a/zcl_a.clas.json';
const VIEW = 'src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds';
const CLS_REMOTE = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap';
const CLS_JSON_REMOTE = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.json';
const VIEW_REMOTE = 'ZADTPLUS_A/ZADTPLUS_A_SUB/Core Data Services/Data Definitions/ZI_B/zi_b.ddls.acds';

async function mirrored(files: Record<string, string> = PACKAGE) {
  const sys = fakeSystem(files);
  const { deps: base, held } = fakeDeps(sys.adt);
  await init(base, {}, { ...loc(), package: 'zadtplus_a' });
  await pull(base, {}, loc());
  const log: string[] = [];
  const deps: PushDeps = {
    ...base,
    destination: destination(),
    logWrite: (cmd, params, error) => log.push(`${cmd} ${String(params.file ?? '')}${error ? ` ! ${error}` : ''}`),
  };
  return { sys, deps, held, log };
}

const writes = (sys: ReturnType<typeof fakeSystem>) =>
  vi.mocked(sys.adt.lifecycle.update).mock.calls.length + vi.mocked(sys.adt.repository.writeFile).mock.calls.length;

describe('mirror push', () => {
  it('plans without calling SAP on a dry run, and sorts what it would not send', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  PUBLIC SECTION.\nENDCLASS.\n');
    chmodSync(file('src/zadtplus_a/zde_a.dtelde.jsonc'), 0o644);
    write('src/zadtplus_a/zde_a.dtelde.jsonc', '// mine\n');
    rmSync(file('src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json'));
    write('src/zadtplus_a/zcl_new.clas.abap', 'CLASS zcl_new DEFINITION.\nENDCLASS.\n');
    write('src/zadtplus_a/zcl_a.clas.testclasses.abap', '" tests\n');
    write('src/zadtplus_a/zcl_a.clas.locals_imp.abap', '" handler\n');
    const reads = vi.mocked(sys.adt.repository.readFile).mock.calls.length;
    const result = await push(deps, {}, { ...loc(), dryRun: true });
    expect(result).toMatchObject({
      dryRun: true,
      planned: { count: 1, paths: ['CLAS ZCL_A'] },
      pushed: { count: 0 },
      notSent: { paths: ['src/zadtplus_a/zde_a.dtelde.jsonc'] },
      deletedLocally: { paths: ['src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json'] },
      newLocally: { paths: ['src/zadtplus_a/zcl_a.clas.testclasses.abap'] },
      toCreate: { count: 0 },
      cannotCreate: [{ object: 'CLAS ZCL_NEW (src/zadtplus_a)', message: expect.stringContaining('no clas.json') }],
      misnamed: [{ object: 'src/zadtplus_a/zcl_a.clas.locals_imp.abap', message: expect.stringContaining('zcl_a.clas.implementations.abap') }],
      complete: false,
      calls: 0,
    });
    expect(vi.mocked(sys.adt.repository.readFile).mock.calls.length).toBe(reads);
  });

  it('writes in the system style, takes the new base from a refreshed read, and logs every write', async () => {
    const { sys, deps, held, log } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  PUBLIC SECTION.\nENDCLASS.\n');
    write(CLS_JSON, '{\n  "header": {"description": "A"}\n}\n');
    const result = await push(deps, {}, loc());
    expect(result).toMatchObject({ pushed: { paths: ['CLAS ZCL_A'] }, written: { count: 2 }, conflicts: [], refused: [], failed: [] });
    // Sent CRLF as the system had it; the .json without the final newline it had.
    expect(vi.mocked(sys.adt.lifecycle.update).mock.calls[0]![0]).toMatchObject({ source: 'CLASS zcl_a DEFINITION.\r\n  PUBLIC SECTION.\r\nENDCLASS.\r\n' });
    expect(sys.state.files[CLS_JSON_REMOTE]).toBe('{\n  "header": {"description": "A"}\n}');
    // Source before metadata; one call-log line each.
    expect(log).toEqual(['object.update zcl_a.clas.abap', 'object.update zcl_a.clas.json', 'object.activate ']);
    const m = manifest();
    expect(m.objects['CLAS ZCL_A'].unactivated).toBeUndefined();
    expect(m.objects['CLAS ZCL_A'].files['zcl_a.clas.abap']).toEqual({ hash: contentHash(sys.state.files[CLS_REMOTE]!) });
    expect(result.activation).toMatchObject({ activated: { paths: ['CLAS ZCL_A'] }, notActivated: { count: 0 }, errors: 0 });
    expect(result.complete).toBe(true);
    expect(sys.adt.raw.lsp).toHaveBeenCalledWith('adtLs/fileSystem/forceRefresh', expect.anything());
    expect(held).toContain('CLAS ZCL_A');
    // Local files untouched, and nothing left to push.
    expect(read(CLS)).toBe('CLASS zcl_a DEFINITION.\n  PUBLIC SECTION.\nENDCLASS.\n');
    expect((await status(loc())).modified.count).toBe(0);
    expect((await push(deps, {}, { ...loc(), dryRun: true })).planned.count).toBe(0);
  });

  it('takeSystemVersion: a written file takes what the system kept, so local, base and system agree', async () => {
    const files = { ...PACKAGE, [CLS_JSON_REMOTE]: '{\n  "formatVersion": "1",\n  "header": {}\n}' };
    const sent = '{\n  "header": {"description": "A"}\n}\n';
    for (const take of [false, true]) {
      rmSync(root, { recursive: true, force: true });
      const { sys, deps } = await mirrored(files);
      write(CLS_JSON, sent);
      const result = await push(deps, {}, { ...loc(), takeSystemVersion: take });
      // The system keeps the key the sent file dropped.
      expect(sys.state.files[CLS_JSON_REMOTE]).toContain('formatVersion');
      expect(result.complete).toBe(true);
      expect(result.rewritten.paths).toEqual(take ? [CLS_JSON] : []);
      expect(read(CLS_JSON)).toBe(take ? `${sys.state.files[CLS_JSON_REMOTE]}\n` : sent);
      expect((await status(loc())).modified.count).toBe(take ? 0 : 1);
    }
  });

  it('writes nothing of an object changed on the system, and goes on with the others', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    sys.state.files[CLS_REMOTE] = 'CLASS zcl_a DEFINITION.\r\n  " theirs\r\nENDCLASS.\r\n';
    const result = await push(deps, {}, loc());
    expect(result.conflicts).toEqual([{ object: 'CLAS ZCL_A', message: expect.stringContaining(`${CLS} changed on the system`) }]);
    expect(result.pushed.paths).toEqual(['DDLS ZI_B']);
    expect(sys.state.files[CLS_REMOTE]).toContain('theirs');
    expect(result.complete).toBe(false);
  });

  it('refuses objects outside the allowlist and objects moved on the system, before any write', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    const result = await push({ ...deps, destination: destination(['ZADTPLUS_A']) }, {}, loc());
    expect(result.refused).toEqual([{ object: 'DDLS ZI_B', message: expect.stringContaining('package "ZADTPLUS_A_SUB" is not in the write allowlist') }]);
    expect(result.pushed.paths).toEqual(['CLAS ZCL_A']);

    // The view moves to ZADTPLUS_A on the system: the manifest's package isn't trusted.
    const moved = VIEW_REMOTE.replace('ZADTPLUS_A/ZADTPLUS_A_SUB/', 'ZADTPLUS_A/');
    for (const p of Object.keys(sys.state.files).filter((k) => k.startsWith('ZADTPLUS_A/ZADTPLUS_A_SUB/Core'))) {
      sys.state.files[p.replace('ZADTPLUS_A/ZADTPLUS_A_SUB/', 'ZADTPLUS_A/')] = sys.state.files[p]!;
      delete sys.state.files[p];
    }
    const before = writes(sys);
    const again = await push(deps, {}, loc());
    expect(again.refused).toEqual([{ object: 'DDLS ZI_B', message: expect.stringContaining('moved on the system, pull first') }]);
    expect(writes(sys)).toBe(before);
    expect(sys.state.files[moved]).not.toContain('mtext');
  });

  it('refuses an object whose files were moved to another package folder', async () => {
    const { deps } = await mirrored();
    mkdirSync(file('src/zadtplus_a/zadtplus_a_other'));
    renameSync(file(VIEW), file('src/zadtplus_a/zadtplus_a_other/zi_b.ddls.acds'));
    const result = await push(deps, {}, loc());
    expect(result.moved.paths).toEqual(['src/zadtplus_a/zadtplus_a_other/zi_b.ddls.acds']);
    expect(result.planned.count).toBe(0);
    expect(result.complete).toBe(false);
  });

  it('blocks a class whose main source has a comment in the class frame, writing nothing of it', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\nENDCLASS.\n" trailing\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    const result = await push(deps, {}, loc());
    expect(result.blocked).toEqual([
      { object: 'CLAS ZCL_A', message: expect.stringMatching(/^zcl_a\.clas\.abap: line 5: a comment after the last ENDCLASS/) },
    ]);
    expect(result.pushed).toEqual({ count: 1, paths: ['DDLS ZI_B'] });
    expect(vi.mocked(sys.adt.lifecycle.update).mock.calls.map(([a]) => a.name)).not.toContain('ZCL_A');
    expect(result.complete).toBe(false);
  });

  it("pushes a class whose frame comment is the system's own", async () => {
    const own = 'CLASS zcl_a DEFINITION.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\nENDCLASS. "zcl_a implementation\n';
    const { deps } = await mirrored({ ...PACKAGE, [CLS_REMOTE]: own });
    write(CLS, own.replace('CLASS zcl_a DEFINITION.', 'CLASS zcl_a DEFINITION.\n  PUBLIC SECTION.'));
    const result = await push(deps, {}, loc());
    expect(result).toMatchObject({ blocked: [], pushed: { paths: ['CLAS ZCL_A'] } });
  });

  it('reports a locked object as blocked and a broken write as failed, keeping the base', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    const base = manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.abap'].hash;
    sys.state.failWrite = (p) =>
      p === CLS_REMOTE ? new Error('Object ZCL_A is locked by user OTHER in request DEVK900001') : p === VIEW_REMOTE ? new Error('HTTP 500') : undefined;
    const result = await push(deps, {}, loc());
    expect(result.blocked).toEqual([{ object: 'CLAS ZCL_A', message: expect.stringContaining('locked by user OTHER') }]);
    expect(result.failed).toEqual([{ object: 'DDLS ZI_B', message: expect.stringContaining('HTTP 500') }]);
    expect(manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.abap'].hash).toBe(base);
    expect(manifest().objects['CLAS ZCL_A'].unactivated).toBeUndefined();
  });

  it('leaves an object it wrote only partly out of the activation; the next push writes the rest and activates it', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(CLS_JSON, '{\n  "header": {"description": "B"}\n}\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    sys.state.failWrite = (p) => (p === CLS_JSON_REMOTE ? new Error('HTTP 500') : undefined);
    const first = await push(deps, {}, loc());
    expect(first.written.paths).toEqual(expect.arrayContaining([CLS]));
    expect(first.failed).toEqual([{ object: 'CLAS ZCL_A', message: expect.stringContaining('HTTP 500') }]);
    expect(first.pushed.paths).toEqual(['DDLS ZI_B']);
    expect(first.activation).toMatchObject({ activated: { paths: ['DDLS ZI_B'] } });
    expect(first.unactivated.paths).toEqual(['CLAS ZCL_A']);

    sys.state.failWrite = () => undefined;
    const second = await push(deps, {}, loc());
    expect(second).toMatchObject({ written: { paths: [CLS_JSON] }, activation: { activated: { paths: ['CLAS ZCL_A'] } }, complete: true });
  });

  it('still activates what an earlier push wrote completely when this push writes nothing of the object', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    await push(deps, {}, { ...loc(), activate: false });
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine again\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    sys.state.failWrite = (p) => (p === CLS_REMOTE ? new Error('Object ZCL_A is locked by user OTHER') : undefined);
    const result = await push(deps, {}, loc());
    expect(result.blocked).toEqual([{ object: 'CLAS ZCL_A', message: expect.stringContaining('locked by user OTHER') }]);
    expect(result.activation).toMatchObject({ activated: { paths: expect.arrayContaining(['CLAS ZCL_A', 'DDLS ZI_B']) } });
  });

  it('writes one object at a time and tries a write again while adt-ls is busy locking', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    let busy = 2;
    sys.state.failWrite = (p) =>
      p === VIEW_REMOTE && busy-- > 0 ? new Error('Object cannot be locked: Another lock attempt is still in progress') : undefined;
    const waits: number[] = [];
    const result = await push({ ...deps, sleep: async (ms) => void waits.push(ms) }, {}, loc());
    expect(result).toMatchObject({ pushed: { count: 2 }, blocked: [], complete: true });
    expect(waits).toEqual([500, 1000]);

    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt }\n');
    sys.state.failWrite = () => new Error('Object cannot be locked: Another lock attempt is still in progress');
    const stuck = await push({ ...deps, sleep: async () => {} }, {}, loc());
    expect(stuck.blocked).toEqual([{ object: 'DDLS ZI_B', message: expect.stringContaining('Another lock attempt') }]);
  });

  it('settles a conflict through the .remote a re-pull left (ADR-007)', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    sys.state.files[CLS_REMOTE] = 'CLASS zcl_a DEFINITION.\r\n  " theirs\r\nENDCLASS.\r\n';
    expect((await push(deps, {}, loc())).conflicts).toHaveLength(1);
    await pull(deps, {}, loc());
    expect(read(`${CLS}.remote`)).toContain('theirs');

    // Merged by hand: both lines. The system still has what the .remote shows, so it's written.
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " theirs\n  " mine\nENDCLASS.\n');
    const result = await push(deps, {}, loc());
    expect(result).toMatchObject({ pushed: { paths: ['CLAS ZCL_A'] }, resolved: { paths: [CLS] }, conflicts: [], complete: true });
    expect(sys.state.files[CLS_REMOTE]).toBe('CLASS zcl_a DEFINITION.\r\n  " theirs\r\n  " mine\r\nENDCLASS.\r\n');
    expect((await status(loc())).remote.count).toBe(0);
    expect((await pull(deps, {}, loc())).written.count).toBe(0);
  });

  it("settles a conflict without a write when the merge is the system's version, and refuses one the system moved past", async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mine }\n');
    sys.state.files[CLS_REMOTE] = 'CLASS zcl_a DEFINITION.\r\n  " theirs\r\nENDCLASS.\r\n';
    sys.state.files[VIEW_REMOTE] = 'define view entity ZI_B as select from t000 { key mandt, theirs }';
    await pull(deps, {}, loc());
    // Took theirs for the class; the view changes once more on the system after the re-pull.
    write(CLS, read(`${CLS}.remote`));
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, theirs, mine }\n');
    sys.state.files[VIEW_REMOTE] = 'define view entity ZI_B as select from t000 { key mandt, third }';
    const before = writes(sys);
    const result = await push(deps, {}, loc());
    expect(result.resolved.paths).toEqual([CLS]);
    expect(result.pushed.count).toBe(0);
    expect(result.conflicts).toEqual([{ object: 'DDLS ZI_B', message: expect.stringContaining('since its zi_b.ddls.acds.remote was written') }]);
    expect(writes(sys)).toBe(before);
    expect((await status(loc())).modified.paths).toEqual([VIEW]);
  });

  it('records an object that is in no open request in the given transport, assigned once', async () => {
    const { sys, deps, log } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(CLS_JSON, '{\n  "header": {"description": "A"}\n}\n');
    const folder = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/';
    sys.state.noTransport.add(folder);
    sys.state.requests.add('DEVK900002');

    const without = await push(deps, {}, loc());
    expect(without.blocked).toEqual([{ object: 'CLAS ZCL_A', message: expect.stringMatching(/Object not assigned to a transport \(pass a transport request/) }]);
    expect(writes(sys)).toBe(1);

    const wrong = await push(deps, {}, { ...loc(), transport: 'DEVK999999' });
    expect(wrong.blocked).toEqual([{ object: 'CLAS ZCL_A', message: expect.stringContaining('transport DEVK999999 was not taken') }]);

    log.length = 0;
    const result = await push(deps, {}, { ...loc(), transport: 'devk900002' });
    expect(result).toMatchObject({ pushed: { paths: ['CLAS ZCL_A'] }, written: { count: 2 }, blocked: [], complete: true });
    expect(sys.state.recorded.get(folder)).toBe('DEVK900002');
    // One assign, logged; the .json after it needs none.
    expect(vi.mocked(sys.adt.raw.lsp).mock.calls.filter(([m]) => m === 'adtLs/cts/transport/assignTransportToObject').length).toBe(2);
    expect(log.filter((l) => l.startsWith('transport.assign'))).toEqual(['transport.assign zcl_a.clas.abap']);
    expect(log.indexOf(log.find((l) => l.startsWith('transport.assign'))!)).toBe(1);
  });

  const assignedUris = (sys: ReturnType<typeof fakeSystem>) =>
    vi.mocked(sys.adt.raw.lsp).mock.calls
      .filter(([m]) => m === 'adtLs/cts/transport/assignTransportToObject')
      .map(([, p]) => decodeURIComponent(String((p as { objectUri: string }).objectUri).split('/').pop()!));

  it('assigns on the file it writes: a class include or a .json alone', async () => {
    const include = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.implementations.abap';
    for (const [remote, local, text] of [
      [include, 'src/zadtplus_a/zcl_a.clas.implementations.abap', '" mine\n'],
      [CLS_JSON_REMOTE, CLS_JSON, '{\n  "header": {"description": "A"}\n}\n'],
    ] as const) {
      const { sys, deps } = await mirrored({ ...PACKAGE, [include]: '" impl\r\n' });
      write(local, text);
      const folder = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/';
      sys.state.noTransport.add(folder);
      sys.state.requests.add('DEVK900002');

      const result = await push(deps, {}, { ...loc(), transport: 'DEVK900002' });
      expect(result).toMatchObject({ pushed: { paths: ['CLAS ZCL_A'] }, blocked: [], failed: [] });
      expect(sys.state.recorded.get(folder)).toBe('DEVK900002');
      expect(assignedUris(sys)).toEqual([remote.split('/').pop()]);
    }
  });

  it('assigns again for the next file after a write the system recorded nothing for', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(CLS_JSON, '{\n  "header": {"description": "A"}\n}\n');
    const folder = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/';
    sys.state.noTransport.add(folder);
    sys.state.requests.add('DEVK900002');
    sys.state.recordsNothing = (p) => p === CLS_REMOTE;

    const result = await push(deps, {}, { ...loc(), transport: 'DEVK900002' });
    expect(result).toMatchObject({ pushed: { paths: ['CLAS ZCL_A'] }, written: { count: 2 }, blocked: [], failed: [] });
    expect(assignedUris(sys)).toEqual(['zcl_a.clas.abap', 'zcl_a.clas.json']);
    expect(sys.state.recorded.get(folder)).toBe('DEVK900002');
  });

  it('stops at a 429 with what it wrote saved, and the next run finishes', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    sys.state.failWrite = (p) => (p === VIEW_REMOTE ? new ThrottledError('429', 1000) : undefined);
    await expect(push(deps, {}, loc())).rejects.toBeInstanceOf(ThrottledError);
    expect(manifest().objects['CLAS ZCL_A'].unactivated).toBe(true);
    sys.state.failWrite = () => undefined;
    const again = await push(deps, {}, loc());
    expect(again.planned.paths).toEqual(['DDLS ZI_B']);
    expect(again.pushed.paths).toEqual(['DDLS ZI_B']);
  });

  it('refuses more objects than the ceiling, another system and a pull that did not finish', async () => {
    const { deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    await expect(push(deps, { maxObjects: 1 }, loc())).rejects.toThrow(/would write 2 objects, more than 1/);
    await expect(push(deps, {}, { ...loc(), system: 'cloud-erp' })).rejects.toThrow(/mirrors system "onprem", not "cloud-erp"/);
    const m = manifest();
    writeFileSync(file('.adtplus/mirror.json'), JSON.stringify({ ...m, pull: { id: 'x', startedAt: 'y' } }));
    await expect(push(deps, {}, loc())).rejects.toThrow(/pull stopped/);
  });

  it('notes a stale manifest when most objects conflict', async () => {
    const files = { ...PACKAGE, 'ZADTPLUS_A/Source Code Library/Interfaces/ZIF_C/zif_c.intf.abap': 'INTERFACE zif_c.\r\nENDINTERFACE.\r\n' };
    const { sys, deps } = await mirrored(files);
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    write('src/zadtplus_a/zif_c.intf.abap', 'INTERFACE zif_c.\n  " mine\nENDINTERFACE.\n');
    for (const p of [CLS_REMOTE, VIEW_REMOTE, 'ZADTPLUS_A/Source Code Library/Interfaces/ZIF_C/zif_c.intf.abap']) sys.state.files[p] += ' ';
    const result = await push(deps, {}, loc());
    expect(result.conflicts).toHaveLength(3);
    expect(result.note).toMatch(/manifest may be stale/);
  });
});

describe('mirror push activation and mirror activate', () => {
  it('activates everything written in one call and maps diagnostics to local files, each once', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, nosuch }\n');
    sys.state.activationErrors.set(VIEW_REMOTE, { line: 0, message: 'Field NOSUCH unknown' });
    const result = await push(deps, {}, loc());
    expect(vi.mocked(sys.adt.raw.lsp).mock.calls.filter(([m]) => m === 'adtLs/activation/activate')).toHaveLength(1);
    expect(result.activation).toMatchObject({
      activated: { paths: ['CLAS ZCL_A'] },
      notActivated: { paths: ['DDLS ZI_B'] },
      errors: 2,
      diagnostics: [
        { path: 'src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds', line: 1, col: 3, severity: 'error', message: 'Field NOSUCH unknown' },
        { path: 'src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json', line: 0, severity: 'error', message: 'not activated' },
      ],
    });
    expect(result.unactivated.paths).toEqual(['DDLS ZI_B']);
    expect(result.complete).toBe(false);

    // Fixed locally and pushed again: written and activated.
    sys.state.activationErrors.clear();
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt }\n');
    const fixed = await push(deps, {}, loc());
    expect(fixed.activation?.activated.paths).toEqual(['DDLS ZI_B']);
    expect(fixed.unactivated.count).toBe(0);
  });

  it('leaves activation to mirror activate with activate: false', async () => {
    const { sys, deps, log } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    const result = await push(deps, {}, { ...loc(), activate: false });
    expect(result).toMatchObject({ unactivated: { paths: ['CLAS ZCL_A'] }, complete: true });
    expect(result.activation).toBeUndefined();
    expect(sys.state.drafts.has(CLS_REMOTE)).toBe(true);

    const activated = await activateMirror(deps, loc());
    expect(activated).toMatchObject({ refused: [], activation: { activated: { paths: ['CLAS ZCL_A'] } }, complete: true });
    expect(log.at(-1)).toBe('object.activate ');
    expect(manifest().objects['CLAS ZCL_A'].unactivated).toBeUndefined();
    expect(await activateMirror(deps, loc())).toMatchObject({ note: expect.stringContaining('nothing to activate') });
  });

  it('mirror activate gates again, and an activation call that fails leaves the objects waiting', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    await push(deps, {}, { ...loc(), activate: false });
    sys.state.failActivation = new Error('activation service down');
    const result = await activateMirror({ ...deps, destination: destination(['ZADTPLUS_A']) }, loc());
    expect(result.refused).toEqual([{ object: 'DDLS ZI_B', message: expect.stringContaining('not in the write allowlist') }]);
    expect(result.activation).toMatchObject({ failure: 'activation service down', notActivated: { paths: ['CLAS ZCL_A'] } });
    expect(result.complete).toBe(false);
    expect(manifest().objects['CLAS ZCL_A'].unactivated).toBe(true);
  });
});

describe('mirror push: new objects', () => {
  const NEW_CLS = 'src/zadtplus_a/zcl_new.clas.abap';
  const NEW_JSON = 'src/zadtplus_a/zcl_new.clas.json';
  const NEW_SOURCE = 'CLASS zcl_new DEFINITION PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\n\nCLASS zcl_new IMPLEMENTATION.\nENDCLASS.\n';
  const NEW_META = '{\n  "formatVersion": "1",\n  "header": {\n    "description": "New one",\n    "originalLanguage": "en"\n  }\n}\n';
  const NEW_REMOTE = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_NEW/zcl_new.clas.abap';
  const newClass = (dir = 'src/zadtplus_a') => {
    mkdirSync(file(dir), { recursive: true });
    write(`${dir}/zcl_new.clas.abap`, NEW_SOURCE);
    write(`${dir}/zcl_new.clas.json`, NEW_META);
  };
  const creates = (sys: ReturnType<typeof fakeSystem>) => vi.mocked(sys.adt.lifecycle.create).mock.calls.map(([a]) => a);

  it('does not create a class whose main source has text between its includes', async () => {
    const { sys, deps } = await mirrored();
    newClass();
    write(NEW_CLS, NEW_SOURCE.replace('\nCLASS zcl_new IMPLEMENTATION', '\n* between\nCLASS zcl_new IMPLEMENTATION'));
    const result = await push(deps, {}, loc());
    expect(result.cannotCreate).toEqual([
      { object: 'CLAS ZCL_NEW (src/zadtplus_a)', message: expect.stringMatching(/^zcl_new\.clas\.abap: line 5: a comment between the definition/) },
    ]);
    expect(creates(sys)).toEqual([]);
  });

  it('checks a new class file named in upper case, and reports every reason it cannot be created', async () => {
    const { sys, deps } = await mirrored();
    mkdirSync(file('src/zadtplus_a'), { recursive: true });
    write('src/zadtplus_a/ZCL_NEW.clas.abap', `${NEW_SOURCE}* trailing\n`);
    write('src/zadtplus_a/ZCL_NEW.clas.json', '{\n  "formatVersion": "1",\n  "header": {\n    "originalLanguage": "en"\n  }\n}\n');
    const result = await push(deps, {}, loc());
    expect(result.cannotCreate).toHaveLength(1);
    expect(result.cannotCreate[0]!.message).toMatch(/description/i);
    expect(result.cannotCreate[0]!.message).toMatch(/zcl_new\.clas\.abap: line 7: a comment after the last ENDCLASS/);
    expect(result.cannotCreate[0]!.message).toMatch(/rename ZCL_NEW\.clas\.abap to zcl_new\.clas\.abap/);
    expect(creates(sys)).toEqual([]);
  });

  it('does not create an object whose file names are not lower case (its files would not be sent)', async () => {
    const { sys, deps } = await mirrored();
    mkdirSync(file('src/zadtplus_a'), { recursive: true });
    write('src/zadtplus_a/ZCL_NEW.clas.abap', NEW_SOURCE);
    write('src/zadtplus_a/zcl_new.clas.json', NEW_META);
    const result = await push(deps, {}, loc());
    expect(result.cannotCreate).toEqual([
      {
        object: 'CLAS ZCL_NEW (src/zadtplus_a)',
        message: 'file names are lower case on the system: rename ZCL_NEW.clas.abap to zcl_new.clas.abap',
      },
    ]);
    expect(creates(sys)).toEqual([]);
  });

  it('creates a new object, writes its files over the template, takes the system version locally and activates it', async () => {
    const { sys, deps, log } = await mirrored();
    newClass();
    const dry = await push(deps, {}, { ...loc(), dryRun: true });
    expect(dry).toMatchObject({ toCreate: { paths: ['CLAS ZCL_NEW'] }, planned: { count: 0 }, cannotCreate: [], calls: 0 });

    const result = await push(deps, {}, loc());
    expect(creates(sys)).toEqual([
      { objectType: 'CLAS/OC', name: 'ZCL_NEW', packageName: 'ZADTPLUS_A', description: 'New one', transportRequestNumber: '' },
    ]);
    expect(result).toMatchObject({
      created: { paths: ['CLAS ZCL_NEW'] },
      pushed: { paths: ['CLAS ZCL_NEW'] },
      written: { paths: [NEW_CLS, NEW_JSON] },
      rewritten: { paths: [NEW_JSON] },
      activation: { activated: { paths: ['CLAS ZCL_NEW'] } },
      complete: true,
    });
    expect(sys.state.files[NEW_REMOTE]).toBe(NEW_SOURCE.replace(/\n/g, '\r\n'));
    expect(log).toEqual(['object.create ', 'object.update zcl_new.clas.abap', 'object.update zcl_new.clas.json', 'object.activate ']);
    // The source stays as written (the system's CRLF is no change); the .json is the system's now.
    expect(read(NEW_CLS)).toBe(NEW_SOURCE);
    expect(JSON.parse(read(NEW_JSON)).header).toMatchObject({ description: 'New one', abapLanguageVersion: 'standard' });
    expect(manifest().objects['CLAS ZCL_NEW']).toMatchObject({ package: 'ZADTPLUS_A', dir: 'src/zadtplus_a' });
    expect((await status(loc())).modified.count).toBe(0);
    const again = await push(deps, {}, { ...loc(), dryRun: true });
    expect(again).toMatchObject({ toCreate: { count: 0 }, planned: { count: 0 } });
  });

  it('creates in a subpackage the manifest has no objects of, once the system confirms where it is', async () => {
    const { sys, deps } = await mirrored({ ...PACKAGE, 'ZADTPLUS_A/ZADTPLUS_A_NEW/zadtplus_a_new.devck.jsonc': '{}' });
    newClass('src/zadtplus_a/zadtplus_a_new');
    write('src/zadtplus_a/zadtplus_a_sub/zadtplus_a_new.txt', '');
    const result = await push(deps, {}, loc());
    expect(result.created.paths).toEqual(['CLAS ZCL_NEW']);
    expect(creates(sys)[0]).toMatchObject({ packageName: 'ZADTPLUS_A_NEW' });
    expect(manifest().objects['CLAS ZCL_NEW']).toMatchObject({ package: 'ZADTPLUS_A_NEW', dir: 'src/zadtplus_a/zadtplus_a_new' });
  });

  it('refuses a folder that is no package in that place, and a package outside the allowlist, before any create', async () => {
    const { sys, deps } = await mirrored({ ...PACKAGE, 'ZADTPLUS_A/ZADTPLUS_A_NEW/zadtplus_a_new.devck.jsonc': '{}' });
    newClass('src/zadtplus_a/zadtplus_a_sub/zadtplus_a_new');
    let result = await push(deps, {}, loc());
    expect(result.refused).toEqual([{ object: 'CLAS ZCL_NEW', message: expect.stringContaining("doesn't match package ZADTPLUS_A_NEW's place") }]);
    rmSync(file('src/zadtplus_a/zadtplus_a_sub/zadtplus_a_new'), { recursive: true });
    newClass('src/zadtplus_a/zadtplus_a_sub');
    result = await push({ ...deps, destination: destination(['ZADTPLUS_A']) }, {}, loc());
    expect(result.refused).toEqual([{ object: 'CLAS ZCL_NEW', message: expect.stringContaining('not in the write allowlist') }]);
    expect(result.complete).toBe(false);
    expect(creates(sys)).toEqual([]);
  });

  it('creates in the given transport, and reports a missing one as blocked', async () => {
    const { sys, deps } = await mirrored();
    sys.state.transportable.add('ZADTPLUS_A');
    newClass();
    const blocked = await push(deps, {}, loc());
    expect(blocked.blocked).toEqual([{ object: 'CLAS ZCL_NEW', message: expect.stringContaining('pass a transport request to create it in') }]);
    expect(manifest().objects['CLAS ZCL_NEW']).toBeUndefined();
    const result = await push(deps, {}, { ...loc(), transport: 'DEVK900002' });
    expect(creates(sys).at(-1)).toMatchObject({ transportRequestNumber: 'DEVK900002' });
    expect(result.created.paths).toEqual(['CLAS ZCL_NEW']);
  });

  it('creates nothing in a package that records changes unless a transport is given', async () => {
    const { sys, deps } = await mirrored();
    newClass();
    const recordsChanges = vi.fn(async (pkg: string) => (pkg === 'ZADTPLUS_A' ? true : undefined));
    const result = await push({ ...deps, recordsChanges }, {}, loc());
    expect(result.blocked).toEqual([{ object: 'CLAS ZCL_NEW', message: 'package ZADTPLUS_A records changes: pass a transport request to create it in' }]);
    expect(creates(sys)).toEqual([]);
    expect((await push({ ...deps, recordsChanges }, {}, { ...loc(), transport: 'DEVK900002' })).created.paths).toEqual(['CLAS ZCL_NEW']);
    expect(recordsChanges).toHaveBeenCalledTimes(1);
  });

  it('activates the objects an earlier push left waiting together with what it writes', async () => {
    const { sys, deps } = await mirrored();
    newClass();
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, nosuch }\n');
    sys.state.activationErrors.set(VIEW_REMOTE, { line: 0, message: 'Field NOSUCH unknown' });
    const first = await push(deps, {}, loc());
    expect(first.activation?.notActivated.paths).toEqual(['DDLS ZI_B']);
    // The failing view takes the class down with it, as SAP's mass activation does (M4 live).
    sys.state.drafts.add(NEW_REMOTE);
    const m = manifest();
    m.objects['CLAS ZCL_NEW'].unactivated = true;
    writeFileSync(file('.adtplus/mirror.json'), JSON.stringify(m));
    sys.state.activationErrors.clear();
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt }\n');
    const fixed = await push(deps, {}, loc());
    expect(fixed.planned.paths).toEqual(['DDLS ZI_B']);
    expect(fixed.activation?.activated.paths).toEqual(['CLAS ZCL_NEW', 'DDLS ZI_B']);
    expect(fixed.unactivated.count).toBe(0);
  });

  it('takes a name that exists on the system as a conflict, settled by pull and push', async () => {
    const { deps } = await mirrored({ ...PACKAGE, [NEW_REMOTE]: 'CLASS zcl_new DEFINITION.\r\nENDCLASS.\r\n' });
    rmSync(file(NEW_CLS));
    rmSync(file(NEW_JSON), { force: true });
    const m = manifest();
    delete m.objects['CLAS ZCL_NEW'];
    writeFileSync(file('.adtplus/mirror.json'), JSON.stringify(m));
    newClass();
    const result = await push(deps, {}, loc());
    expect(result.conflicts).toEqual([{ object: 'CLAS ZCL_NEW', message: expect.stringContaining('exists on the system') }]);
    // The pull takes the system's class into the mirror; local and system differ, neither has a base.
    expect((await pull(deps, {}, loc())).conflicts.paths).toEqual([NEW_CLS]);
    expect(manifest().objects['CLAS ZCL_NEW'].files['zcl_new.clas.abap'].hash).toBeUndefined();
    const settled = await push(deps, {}, loc());
    expect(settled).toMatchObject({ written: { paths: [NEW_CLS] }, resolved: { paths: [NEW_CLS] }, conflicts: [], complete: true });
  });

  it('keeps an object waiting for activation across a pull', async () => {
    const { deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    await push(deps, {}, { ...loc(), activate: false });
    await pull(deps, {}, loc());
    expect(manifest().objects['CLAS ZCL_A'].unactivated).toBe(true);
  });

  it('asks the deny list about object.create only when something is new, before any write', async () => {
    const { sys, deps } = await mirrored();
    const refusal = vi.fn((cmd: string) => (cmd === 'object.create' ? 'adt+ refuses "object.create" (ADTPLUS_DENY)' : undefined));
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    await push({ ...deps, refusal }, {}, { ...loc(), activate: false });
    expect(refusal).not.toHaveBeenCalled();
    newClass();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine again\nENDCLASS.\n');
    expect((await push({ ...deps, refusal }, {}, { ...loc(), dryRun: true })).toCreate.count).toBe(1);
    await expect(push({ ...deps, refusal }, {}, loc())).rejects.toThrow(/refused before any write: .*object\.create/);
    expect(creates(sys)).toEqual([]);
    expect(writes(sys)).toBe(1);
  });

  it("writes a class include the fresh class doesn't serve, and finishes a push that stopped after the create", async () => {
    const { sys, deps } = await mirrored();
    newClass();
    write('src/zadtplus_a/zcl_new.clas.testclasses.abap', '" tests\n');
    sys.state.failWrite = (p) => (p.endsWith('zcl_new.clas.json') ? new Error('backend hiccup') : undefined);
    const first = await push(deps, {}, loc());
    expect(first).toMatchObject({ created: { paths: ['CLAS ZCL_NEW'] }, failed: [{ object: 'CLAS ZCL_NEW' }], complete: false });
    expect(sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_NEW/zcl_new.clas.testclasses.abap']).toBe('" tests\r\n');
    sys.state.failWrite = () => undefined;
    const again = await push(deps, {}, loc());
    expect(again).toMatchObject({ toCreate: { count: 0 }, planned: { paths: ['CLAS ZCL_NEW'] }, written: { paths: [NEW_JSON] }, complete: true });
    expect(again.activation?.activated.paths).toEqual(['CLAS ZCL_NEW']);
  });

  it('enters a created object in the manifest before reading it, so a failed read leaves it for pull and push', async () => {
    const { sys, deps } = await mirrored();
    newClass();
    sys.state.failDir = (p) => (p.endsWith('ZCL_NEW') ? new Error('HTTP 500') : undefined);
    const first = await push(deps, {}, loc());
    expect(first).toMatchObject({
      created: { paths: ['CLAS ZCL_NEW'] },
      failed: [{ object: 'CLAS ZCL_NEW', message: expect.stringContaining('created, but reading its files failed') }],
      complete: false,
    });
    expect(manifest().objects['CLAS ZCL_NEW']).toMatchObject({ created: true, unactivated: true, files: {} });
    sys.state.failDir = () => undefined;
    // Known now: never created twice. The pull takes the system's files, the push writes the local ones over them.
    expect((await push(deps, {}, { ...loc(), dryRun: true })).toCreate.count).toBe(0);
    await pull(deps, {}, loc());
    const again = await push(deps, {}, loc());
    expect(again).toMatchObject({ failed: [], conflicts: [], complete: true });
    expect(again.written.paths).toContain(NEW_CLS);
    expect(vi.mocked(sys.adt.lifecycle.create)).toHaveBeenCalledTimes(1);
  });

  describe('read-back after activation', () => {
    const DEF = 'src/zadtplus_a/zcl_new.clas.locals_def.abap';
    const TEXTS = 'src/zadtplus_a/zcl_new.clas.texts.en.properties';
    const VIEW_JSON = 'src/zadtplus_a/zi_new.ddls.json';
    /** What ONPREM and cloud-erp add or change at a new object's activation (M4 live). */
    const completing = (sys: ReturnType<typeof fakeSystem>) => {
      sys.state.onActivate = (folder) => {
        if (folder.endsWith('/ZCL_NEW/')) {
          sys.state.files[`${folder}zcl_new.clas.locals_def.abap`] ??= '*"* use this source file for any type of declarations\r\n';
          sys.state.files[`${folder}zcl_new.clas.texts.en.properties`] ??= '';
        }
        if (folder.endsWith('/ZI_NEW/')) {
          const json = JSON.parse(sys.state.files[`${folder}zi_new.ddls.json`]!);
          sys.state.files[`${folder}zi_new.ddls.json`] = JSON.stringify({ ...json, sourceType: 'projectionView' }, null, 2);
        }
      };
    };
    const newView = () => {
      write('src/zadtplus_a/zi_new.ddls.acds', 'define view entity ZI_NEW as projection on ZI_B { key mandt }\n');
      write(VIEW_JSON, '{\n  "formatVersion": "1",\n  "header": {\n    "description": "New view",\n    "originalLanguage": "en"\n  }\n}\n');
    };

    it('takes what the activation added or changed into the mirror, so no pull is needed', async () => {
      const { sys, deps } = await mirrored();
      completing(sys);
      newClass();
      newView();
      const result = await push(deps, {}, loc());
      expect(result).toMatchObject({
        created: { paths: ['CLAS ZCL_NEW', 'DDLS ZI_NEW'] },
        activation: { activated: { count: 2 }, readBack: { taken: { paths: [DEF, TEXTS, VIEW_JSON] }, conflicts: { count: 0 }, failed: [] } },
        complete: true,
      });
      expect(read(DEF)).toBe('*"* use this source file for any type of declarations\n');
      expect(JSON.parse(read(VIEW_JSON)).sourceType).toBe('projectionView');
      const objects = manifest().objects;
      expect(objects['CLAS ZCL_NEW'].created).toBeUndefined();
      expect(objects['CLAS ZCL_NEW'].files['zcl_new.clas.texts.en.properties']).toMatchObject({ readOnly: true });
      expect(objects['DDLS ZI_NEW'].created).toBeUndefined();
      expect(await status(loc())).toMatchObject({ modified: { count: 0 }, added: { count: 0 } });
      expect((await pull(deps, {}, loc())).written.count).toBe(0);
      // An existing object's activation reads nothing back.
      write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
      expect((await push(deps, {}, loc())).activation?.readBack).toBeUndefined();
    });

    it('keeps a local file the activation also brings, with the system version in .remote', async () => {
      const { sys, deps } = await mirrored();
      completing(sys);
      newClass();
      write(TEXTS, 'T01=Mine\n');
      const result = await push(deps, {}, loc());
      expect(result.notSent.paths).toEqual([TEXTS]);
      expect(result.activation?.readBack).toMatchObject({ taken: { paths: [DEF] }, conflicts: { paths: [TEXTS] } });
      expect(result.complete).toBe(false);
      expect(read(TEXTS)).toBe('T01=Mine\n');
      expect(read(`${TEXTS}.remote`)).toBe('');
    });

    it('reads back a created object when a later activation takes it, across a pull', async () => {
      const { sys, deps } = await mirrored();
      completing(sys);
      newClass();
      sys.state.failActivation = new Error('activation down');
      const first = await push(deps, {}, loc());
      expect(first.activation).toMatchObject({ notActivated: { paths: ['CLAS ZCL_NEW'] }, failure: 'activation down' });
      expect(first.activation?.readBack).toBeUndefined();
      await pull(deps, {}, loc());
      expect(manifest().objects['CLAS ZCL_NEW']).toMatchObject({ unactivated: true, created: true });
      sys.state.failActivation = undefined;
      const activated = await activateMirror(deps, loc());
      expect(activated).toMatchObject({ activation: { readBack: { taken: { paths: [DEF, TEXTS] } } }, complete: true });
      expect(manifest().objects['CLAS ZCL_NEW'].created).toBeUndefined();
    });
  });
});

describe('mirror push: a good base clears an old read error', () => {
  it("a pull's failed read stays in status only until a push writes and reads the file back", async () => {
    const { sys, deps } = await mirrored();
    sys.state.failRead = (p) => (p === CLS_JSON_REMOTE ? new Error('HTTP 503') : undefined);
    await pull(deps, {}, loc());
    sys.state.failRead = () => undefined;
    expect(manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.json']).toMatchObject({ hash: expect.any(String), error: expect.any(String) });

    write(CLS_JSON, '{\n  "header": {"description": "B"}\n}\n');
    expect(await push(deps, {}, loc())).toMatchObject({ failed: [], written: { paths: [CLS_JSON] } });
    expect(manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.json'].error).toBeUndefined();
    expect((await status(loc())).readErrors).toEqual([]);
  });
});

describe('mirror push: a failure costs its object, not the push', () => {
  it("a failed read of the system's version fails that object; the others are written and activated", async () => {
    const { sys, deps } = await mirrored();
    write(CLS_JSON, '{\n  "header": {"description": "A"}\n}\n');
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    // Resolving reads the main source; the .json is read only by the conflict check.
    sys.state.failRead = (p) => (p === CLS_JSON_REMOTE ? new Error('HTTP 404') : undefined);
    const result = await push(deps, {}, loc());
    expect(result.failed).toEqual([{ object: 'CLAS ZCL_A', message: expect.stringContaining("reading the system's version failed, nothing written: HTTP 404") }]);
    expect(result.pushed.paths).toEqual(['DDLS ZI_B']);
    expect(result.activation?.activated.paths).toEqual(['DDLS ZI_B']);
    expect(result.complete).toBe(false);
  });

  it('a failed read-back is a read error in status, and push refuses the file until a pull', async () => {
    const { sys, deps } = await mirrored();
    write(CLS_JSON, '{\n  "header": {"description": "A"}\n}\n');
    // Only the read-back after the write fails.
    sys.state.failRead = (p) => (p === CLS_JSON_REMOTE && writes(sys) > 0 ? new Error('HTTP 503') : undefined);
    const first = await push(deps, {}, loc());
    expect(first.failed).toEqual([{ object: 'CLAS ZCL_A', message: expect.stringContaining('reading it back failed') }]);
    sys.state.failRead = () => undefined;
    expect((await status(loc())).readErrors).toEqual([{ path: CLS_JSON, message: expect.stringContaining('HTTP 503') }]);

    write(CLS_JSON, '{\n  "header": {"description": "B"}\n}\n');
    const before = writes(sys);
    const again = await push(deps, {}, loc());
    expect(again.failed).toEqual([{ object: 'CLAS ZCL_A', message: expect.stringContaining(`${CLS_JSON}: no base to compare with`) }]);
    expect(again.complete).toBe(false);
    expect(writes(sys)).toBe(before);
    // A dry run says so too.
    expect((await push(deps, {}, { ...loc(), dryRun: true })).failed).toHaveLength(1);

    // The pull leaves the system's version in a .remote; the push settles against it.
    await pull(deps, {}, loc());
    // Status and push share one scan: what push will send shows as modified.
    expect((await status(loc())).modified.paths).toEqual([CLS_JSON]);
    expect((await push(deps, {}, { ...loc(), dryRun: true })).planned.paths).toEqual(['CLAS ZCL_A']);
    const settled = await push(deps, {}, loc());
    expect(settled).toMatchObject({ failed: [], written: { paths: [CLS_JSON] }, resolved: { paths: [CLS_JSON] }, complete: true });
  });
});

describe('mirror activation: what counts as active', () => {
  it('a file whose stat fails after a failed activation stays waiting; after a clean one it counts as active', async () => {
    const { sys, deps } = await mirrored();
    write(CLS, 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
    await push(deps, {}, { ...loc(), activate: false });
    sys.state.failActivation = new Error('activation service down');
    vi.mocked(sys.adt.repository.abapStat).mockRejectedValue(new Error('stat failed'));
    const failed = await activateMirror(deps, loc());
    expect(failed.activation).toMatchObject({ notActivated: { paths: ['CLAS ZCL_A'] }, activated: { count: 0 } });
    expect(manifest().objects['CLAS ZCL_A'].unactivated).toBe(true);

    sys.state.failActivation = undefined;
    const clean = await activateMirror(deps, loc());
    expect(clean.activation).toMatchObject({ activated: { paths: ['CLAS ZCL_A'] }, notActivated: { count: 0 } });
    expect(manifest().objects['CLAS ZCL_A'].unactivated).toBeUndefined();
  });

  it("push doesn't list the entry a move leaves as unactivated", async () => {
    const { deps } = await mirrored();
    const m = manifest();
    m.objects['CLAS ZCL_A (was ZOLD)'] = { ...m.objects['CLAS ZCL_A'], unactivated: true };
    write('.adtplus/mirror.json', JSON.stringify(m));
    write(VIEW, 'define view entity ZI_B as select from t000 { key mandt, mtext }\n');
    const result = await push(deps, {}, loc());
    expect(result.unactivated.count).toBe(0);
  });

  it('mirror activate passes over the entry a move leaves', async () => {
    const { sys, deps } = await mirrored();
    const m = manifest();
    m.objects['CLAS ZCL_A (was ZOLD)'] = { ...m.objects['CLAS ZCL_A'], unactivated: true };
    write('.adtplus/mirror.json', JSON.stringify(m));
    const result = await activateMirror(deps, loc());
    expect(result).toMatchObject({ refused: [], complete: true, note: expect.stringContaining('nothing to activate') });
    expect(sys.adt.lifecycle.resolveAffUri).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'ZCL_A (was ZOLD)' }));
  });
});
