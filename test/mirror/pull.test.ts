import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThrottledError } from '../../src/daemon/ratelimit.js';
import { contentHash } from '../../src/mirror/normalize.js';
import { init, pull } from '../../src/mirror/pull.js';
import { status } from '../../src/mirror/status.js';
import { PACKAGE, fakeDeps, fakeSystem } from './fake.js';

let ws: string;
let root: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-mirror-')));
  root = path.join(ws, 'mirror');
});
afterEach(() => {
  // Read-only files inside a folder don't block rm -rf, but be explicit.
  rmSync(ws, { recursive: true, force: true });
});

const loc = () => ({ root, workspaceFolders: [ws], system: 'onprem' });
const file = (rel: string) => path.join(root, ...rel.split('/'));
const read = (rel: string) => readFileSync(file(rel), 'utf8');
const manifest = () => JSON.parse(read('.adtplus/mirror.json'));
const CLS = 'src/zadtplus_a/zcl_a.clas.abap';
const CLS_REMOTE = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap';
const VIEW = 'src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds';
const VIEW_REMOTE = 'ZADTPLUS_A/ZADTPLUS_A_SUB/Core Data Services/Data Definitions/ZI_B/zi_b.ddls.acds';
const FUGR_REMOTE = 'ZADTPLUS_A/Source Code Library/Function Groups/ZFG/zfg.fugr.abap';

async function pulled(files: Record<string, string> = PACKAGE) {
  const sys = fakeSystem(files);
  const { deps, held } = fakeDeps(sys.adt);
  await init(deps, {}, { ...loc(), package: 'zadtplus_a' });
  const result = await pull(deps, {}, loc());
  return { sys, deps, held, result };
}

describe('mirror init', () => {
  it('writes the manifest and AFF .editorconfig, and adds a second package of the same system', async () => {
    const sys = fakeSystem({ ...PACKAGE, 'ZADTPLUS_B/zadtplus_b.devck.jsonc': '{}' });
    const { deps } = fakeDeps(sys.adt);
    const first = await init(deps, {}, { ...loc(), package: 'zadtplus_a' });
    expect(first).toMatchObject({ found: true, alreadyListed: false, editorconfig: 'written' });
    expect(read('.editorconfig')).toContain('end_of_line = lf');
    writeFileSync(file('.editorconfig'), 'mine');
    const second = await init(deps, {}, { ...loc(), package: 'ZADTPLUS_B', subpackages: false });
    expect(second.editorconfig).toBe('kept');
    expect(read('.editorconfig')).toBe('mine');
    expect(manifest()).toEqual({
      version: 1,
      system: 'onprem',
      packages: [
        { name: 'ZADTPLUS_A', subpackages: true },
        { name: 'ZADTPLUS_B', subpackages: false },
      ],
      objects: {},
    });
  });

  it('refuses another system in the same root, and packages outside Z, Y, $ and the namespaces', async () => {
    const sys = fakeSystem({ ...PACKAGE, 'SAP_X/sap_x.devck.jsonc': '{}', '(NSPC)P/(nspc)p.devck.jsonc': '{}' });
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    await expect(init(deps, {}, { ...loc(), system: 'cloud-erp', package: 'ZADTPLUS_A' })).rejects.toThrow(/mirrors system "onprem"|already mirrors/);
    await expect(init(deps, {}, { ...loc(), package: 'SAP_X' })).rejects.toThrow(/can't be mirrored/);
    await expect(init(deps, {}, { ...loc(), package: '/NSPC/P' })).rejects.toThrow(/can't be mirrored/);
    await expect(init(deps, { namespaces: ['/NSPC/'] }, { ...loc(), package: '/NSPC/P' })).resolves.toBeDefined();
  });

  it('allows a package the system doesn\'t have yet, with a note', async () => {
    const { deps } = fakeDeps(fakeSystem({}).adt);
    const res = await init(deps, {}, { ...loc(), package: 'ZADTPLUS_NEW' });
    expect(res.found).toBe(false);
    expect(res.note).toMatch(/not found/);
  });

  it('refuses a root outside the workspace folders', async () => {
    const { deps } = fakeDeps(fakeSystem(PACKAGE).adt);
    await expect(init(deps, {}, { ...loc(), root: path.join(ws, '..', 'elsewhere'), package: 'ZADTPLUS_A' })).rejects.toThrow(/outside/);
  });
});

describe('mirror pull', () => {
  it('writes every object flat into its package folder, LF with a final newline, stubs and texts read-only', async () => {
    const { result, held } = await pulled();
    expect(read(CLS)).toBe('CLASS zcl_a DEFINITION.\nENDCLASS.\n');
    expect(read('src/zadtplus_a/zcl_a.clas.json')).toBe('{\n  "header": {}\n}\n');
    expect(read(VIEW)).toBe('define view entity ZI_B as select from t000 { key mandt }  \n');
    expect(statSync(file('src/zadtplus_a/zcl_a.clas.texts.en.properties')).mode & 0o777).toBe(0o444);
    expect(statSync(file('src/zadtplus_a/zde_a.dtelde.jsonc')).mode & 0o777).toBe(0o444);
    expect(statSync(file(CLS)).mode & 0o200).toBe(0o200);
    expect(existsSync(file('src/zadtplus_a/zadtplus_a.devck.jsonc'))).toBe(false);

    const m = manifest();
    expect(Object.keys(m.objects)).toEqual(['CLAS ZCL_A', 'DDLS ZI_B', 'DTELDE ZDE_A']);
    expect(m.objects['DDLS ZI_B']).toMatchObject({ package: 'ZADTPLUS_A_SUB', dir: 'src/zadtplus_a/zadtplus_a_sub' });
    expect(m.objects['CLAS ZCL_A'].files['zcl_a.clas.abap']).toEqual({ hash: contentHash(PACKAGE[CLS_REMOTE]) });
    expect(m.objects['CLAS ZCL_A'].files['zcl_a.clas.texts.en.properties'].readOnly).toBe(true);
    expect(m.adtLs).toBe('1.1.2');
    expect(m.pull).toBeUndefined();

    expect(result).toMatchObject({ objects: 3, files: 6, packages: ['ZADTPLUS_A', 'ZADTPLUS_A_SUB'], resumed: 0 });
    expect(result.written.count).toBe(6);
    expect(held.sort()).toEqual(['CLAS ZCL_A', 'DDLS ZI_B', 'DTEL ZDE_A']);
    // Package locate (2) + 11 directories + 6 readFile + 1 listInactive; no abapStat, nothing is a draft.
    expect(result.calls).toBe(2 + 11 + 6 + 1);
    // In units (ADR-008): lookup 1 + 1, folders 1 each, reads 2 each, listInactive untraced (3).
    expect(result.units).toBe(2 + 11 + 12 + 3);
  });

  it('flags drafts per file', async () => {
    const sys = fakeSystem(PACKAGE);
    sys.state.drafts.add(CLS_REMOTE);
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    await pull(deps, {}, loc());
    expect(manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.abap'].draft).toBe(true);
    expect(manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.json'].draft).toBeUndefined();
  });

  it('stats only the files of objects the inactive list names', async () => {
    const sys = fakeSystem(PACKAGE);
    sys.state.drafts.add(CLS_REMOTE);
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    await pull(deps, {}, loc());
    expect(sys.adt.repository.listInactive).toHaveBeenCalledTimes(1);
    const stated = vi.mocked(sys.adt.repository.abapStat).mock.calls.map(([uri]) => decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1)));
    expect(stated.sort()).toEqual(['zcl_a.clas.abap', 'zcl_a.clas.json', 'zcl_a.clas.texts.en.properties']);
    expect(manifest().objects['DDLS ZI_B'].files['zi_b.ddls.acds'].draft).toBeUndefined();
  });

  it('stats every file when the inactive list fails', async () => {
    const sys = fakeSystem(PACKAGE);
    sys.state.drafts.add(VIEW_REMOTE);
    vi.mocked(sys.adt.repository.listInactive).mockRejectedValue(new Error('HTTP 500'));
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    const res = await pull(deps, {}, loc());
    expect(res.errors).toEqual([]);
    expect(sys.adt.repository.abapStat).toHaveBeenCalledTimes(5);
    expect(manifest().objects['DDLS ZI_B'].files['zi_b.ddls.acds'].draft).toBe(true);
  });

  it('stats a type whose drafts the inactive list names otherwise, file by file', async () => {
    const sys = fakeSystem({ ...PACKAGE, [FUGR_REMOTE]: 'FUNCTION-POOL zfg.\n', [FUGR_REMOTE.replace('.abap', '.json')]: '{}' });
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    await pull(deps, {}, loc());
    const stated = vi.mocked(sys.adt.repository.abapStat).mock.calls.map(([uri]) => decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1)));
    expect(stated.sort()).toEqual(['zfg.fugr.abap', 'zfg.fugr.json']);
  });

  it('changes nothing on disk when nothing changed', async () => {
    const { deps } = await pulled();
    const before = [CLS, VIEW, '.adtplus/mirror.json'].map(read);
    const again = await pull(deps, {}, loc());
    expect([CLS, VIEW, '.adtplus/mirror.json'].map(read)).toEqual(before);
    expect(again.written.count).toBe(0);
    expect(again.conflicts.count).toBe(0);
  });

  it('applies the re-pull rule per file', async () => {
    const { sys, deps } = await pulled();
    const P = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/';
    // remote changed, local not → taken
    sys.state.files[`${P}zcl_a.clas.abap`] = 'CLASS zcl_a DEFINITION.\r\n  " remote\r\nENDCLASS.\r\n';
    // local changed, remote not → kept
    writeFileSync(file(VIEW), 'local edit\n');
    // both changed differently → .remote, base kept
    sys.state.files[`${P}zcl_a.clas.json`] = '{"remote":1}';
    writeFileSync(file('src/zadtplus_a/zcl_a.clas.json'), '{"local":1}\n');
    const jsonBase = manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.json'].hash;
    // both changed the same way (CRLF on one side) → base moves, nothing written
    const sub = 'ZADTPLUS_A/ZADTPLUS_A_SUB/Core Data Services/Data Definitions/ZI_B/zi_b.ddls.json';
    sys.state.files[sub] = '{\r\n  "same": 1\r\n}';
    writeFileSync(file('src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json'), '{\n  "same": 1\n}\n');

    const res = await pull(deps, {}, loc());
    expect(read(CLS)).toBe('CLASS zcl_a DEFINITION.\n  " remote\nENDCLASS.\n');
    expect(read(VIEW)).toBe('local edit\n');
    expect(read('src/zadtplus_a/zcl_a.clas.json')).toBe('{"local":1}\n');
    expect(read('src/zadtplus_a/zcl_a.clas.json.remote')).toBe('{"remote":1}\n');
    expect(existsSync(file('src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json.remote'))).toBe(false);

    const m = manifest();
    expect(m.objects['CLAS ZCL_A'].files['zcl_a.clas.json'].hash).toBe(jsonBase);
    expect(m.objects['DDLS ZI_B'].files['zi_b.ddls.json'].hash).toBe(contentHash('{\n  "same": 1\n}'));
    expect(res.written.paths).toEqual([CLS]);
    expect(res.keptLocal.paths).toEqual([VIEW]);
    expect(res.conflicts.paths).toEqual(['src/zadtplus_a/zcl_a.clas.json']);
  });

  it('overwrites a read-only file changed only on the system, and keeps it read-only', async () => {
    const { sys, deps } = await pulled();
    sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.texts.en.properties'] = 'T01=Hi\r\n';
    await pull(deps, {}, loc());
    expect(read('src/zadtplus_a/zcl_a.clas.texts.en.properties')).toBe('T01=Hi\n');
    expect(statSync(file('src/zadtplus_a/zcl_a.clas.texts.en.properties')).mode & 0o777).toBe(0o444);
  });

  it('writes new objects, and a .remote where a local file of that name already differs', async () => {
    const { sys, deps } = await pulled();
    sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_NEW/zcl_new.clas.abap'] = 'new';
    sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_MINE/zcl_mine.clas.abap'] = 'theirs';
    writeFileSync(file('src/zadtplus_a/zcl_mine.clas.abap'), 'mine\n');
    const res = await pull(deps, {}, loc());
    expect(read('src/zadtplus_a/zcl_new.clas.abap')).toBe('new\n');
    expect(read('src/zadtplus_a/zcl_mine.clas.abap')).toBe('mine\n');
    expect(read('src/zadtplus_a/zcl_mine.clas.abap.remote')).toBe('theirs\n');
    expect(res.conflicts.paths).toEqual(['src/zadtplus_a/zcl_mine.clas.abap']);
    expect(manifest().objects['CLAS ZCL_MINE'].files['zcl_mine.clas.abap'].hash).toBeUndefined();
  });

  it('deletes what is gone on the system when unchanged locally, keeps and reports it otherwise', async () => {
    const { sys, deps } = await pulled();
    for (const p of Object.keys(sys.state.files)) if (p.includes('/ZI_B/')) delete sys.state.files[p];
    delete sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.texts.en.properties'];
    writeFileSync(file(VIEW), 'local edit\n');
    const res = await pull(deps, {}, loc());
    expect(existsSync(file('src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json'))).toBe(false);
    expect(existsSync(file('src/zadtplus_a/zcl_a.clas.texts.en.properties'))).toBe(false);
    expect(read(VIEW)).toBe('local edit\n');
    expect(res.deleted.paths.sort()).toEqual(['src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json', 'src/zadtplus_a/zcl_a.clas.texts.en.properties']);
    expect(res.goneKept.paths).toEqual([VIEW]);
    const m = manifest();
    expect(Object.keys(m.objects['DDLS ZI_B'].files)).toEqual(['zi_b.ddls.acds']);
    expect(m.objects['CLAS ZCL_A'].files['zcl_a.clas.texts.en.properties']).toBeUndefined();
  });

  it('deletes nothing when a folder failed to list', async () => {
    const { sys, deps } = await pulled();
    sys.state.failDir = (p) => (p.endsWith('ZADTPLUS_A_SUB') ? new Error('HTTP 500') : undefined);
    const res = await pull(deps, {}, loc());
    expect(res.unreadable).toEqual([{ path: 'ZADTPLUS_A/ZADTPLUS_A_SUB', message: 'HTTP 500' }]);
    expect(res.deleted.count).toBe(0);
    expect(existsSync(file(VIEW))).toBe(true);
    expect(manifest().objects['DDLS ZI_B']).toBeDefined();
  });

  it('writes a file whose version adt-ls can\'t tell, without a draft flag', async () => {
    const sys = fakeSystem(PACKAGE);
    sys.state.drafts.add(CLS_REMOTE);
    (sys.adt.repository.abapStat as unknown as { mockImplementation: (f: () => Promise<never>) => void }).mockImplementation(
      async () => {
        throw new Error('abapStat returned no version');
      },
    );
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    const res = await pull(deps, {}, loc());
    expect(res.errors).toEqual([]);
    expect(res.written.count).toBe(6);
    expect(manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.abap']).toEqual({ hash: contentHash(PACKAGE[CLS_REMOTE]) });
  });

  it('records a failed read in the manifest and goes on', async () => {
    const sys = fakeSystem(PACKAGE);
    sys.state.failRead = (p) => (p === CLS_REMOTE ? new Error('boom') : undefined);
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    const res = await pull(deps, {}, loc());
    expect(res.errors).toEqual([{ path: CLS, message: 'boom' }]);
    expect(manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.abap']).toEqual({ error: 'boom' });
    expect(res.written.count).toBe(5);
  });

  it('stops on a 429, keeps what it has, and the next run finishes without re-reading', async () => {
    const sys = fakeSystem(PACKAGE);
    let throttle = true;
    sys.state.failRead = (p) => (throttle && p.includes('/ZI_B/') ? new ThrottledError('throttled', 30_000) : undefined);
    const { deps } = fakeDeps(sys.adt, 1);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    await expect(pull(deps, {}, loc())).rejects.toThrow(ThrottledError);
    const stopped = manifest();
    expect(stopped.pull?.id).toMatch(/^[0-9a-f]+$/);
    const done = Object.keys(stopped.objects);
    expect(done.length).toBeGreaterThan(0);
    expect(done).not.toContain('DDLS ZI_B');
    // Progress for a watcher (G5b): what was read when it stopped.
    expect(stopped.pull).toMatchObject({ total: 3, done: done.length });
    expect(stopped.pull.units).toBeGreaterThan(0);

    throttle = false;
    const reads = (sys.adt.repository.readFile as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const res = await pull(deps, {}, loc());
    expect(res.resumed).toBe(done.length);
    expect(manifest().pull).toBeUndefined();
    expect(JSON.stringify(manifest())).not.toContain('"pull"');
    const reread = (sys.adt.repository.readFile as unknown as { mock: { calls: unknown[] } }).mock.calls.length - reads;
    expect(reread).toBe(2);
    expect(read(VIEW)).toBeDefined();
  });

  it('a resume reads again what `reread` names, though the stopped pull read it', async () => {
    const sys = fakeSystem(PACKAGE);
    let throttle = true;
    sys.state.failRead = (p) => (throttle && p.includes('/ZI_B/') ? new ThrottledError('throttled', 30_000) : undefined);
    const { deps } = fakeDeps(sys.adt, 1);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    await expect(pull(deps, {}, loc())).rejects.toThrow(ThrottledError);
    const done = Object.keys(manifest().objects);
    expect(done).toContain('CLAS ZCL_A');

    throttle = false;
    sys.state.files[CLS_REMOTE] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    const res = await pull(deps, {}, { ...loc(), reread: ['CLAS ZCL_A'] });
    expect(res.resumed).toBe(done.length - 1);
    expect(read(CLS)).toBe('CLASS zcl_a DEFINITION FINAL.\nENDCLASS.\n');
  });

  describe('of named objects', () => {
    it('skips a best-effort object whose path names no package, without a full pull', async () => {
      const { sys, deps } = await pulled();
      sys.state.files[CLS_REMOTE] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
      const byName = vi.mocked(sys.adt.lifecycle.resolveAffUri).getMockImplementation()!;
      vi.mocked(sys.adt.lifecycle.resolveAffUri).mockImplementation(async (ref) =>
        ref.name === 'ZI_B' ? 'file:///elsewhere/zi_b.ddls.acds' : byName(ref),
      );
      const res = await pull(deps, {}, { ...loc(), objects: ['CLAS ZCL_A'], bestEffort: ['DDLS ZI_B'] });
      expect(res.fallback).toBeUndefined();
      expect(res.skipped).toEqual([{ object: 'DDLS ZI_B', message: expect.stringMatching(/no package in its path/) }]);
      expect(read(CLS)).toBe('CLASS zcl_a DEFINITION FINAL.\nENDCLASS.\n');
    });

    it('deletes nothing when the folder doesn\'t list the file the search named (stale index)', async () => {
      const { sys, deps } = await pulled();
      vi.mocked(sys.adt.repository.readDirectory).mockResolvedValueOnce([]);
      const res = await pull(deps, {}, { ...loc(), objects: ['CLAS ZCL_A'] });
      expect(res.fallback).toMatch(/doesn't list zcl_a\.clas\.abap \(stale search index\?\)/);
      expect(res.deleted.count).toBe(0);
      expect(existsSync(file(CLS))).toBe(true);
      expect(manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.abap']).toBeDefined();
    });

    it('with nothing to read, leaves the manifest file alone', async () => {
      const { deps } = await pulled();
      const before = statSync(file('.adtplus/mirror.json')).mtimeMs;
      await new Promise((r) => setTimeout(r, 20));
      const res = await pull(deps, {}, { ...loc(), objects: [] });
      expect(res.fallback).toBeUndefined();
      expect(statSync(file('.adtplus/mirror.json')).mtimeMs).toBe(before);
    });

    it('a stop keeps the bases of the files already taken', async () => {
      const { sys, deps } = await pulled();
      const changed = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
      sys.state.files[CLS_REMOTE] = changed;
      sys.state.failRead = (p) => (p.endsWith('zcl_a.clas.json') ? new ThrottledError('throttled', 30_000) : undefined);
      await expect(pull(deps, {}, { ...loc(), objects: ['CLAS ZCL_A'] })).rejects.toThrow(ThrottledError);
      expect(read(CLS)).toBe('CLASS zcl_a DEFINITION FINAL.\nENDCLASS.\n');
      expect(manifest().objects['CLAS ZCL_A'].files['zcl_a.clas.abap'].hash).toBe(contentHash(changed));
    });
  });

  it('refuses a pull over the ceiling before writing anything', async () => {
    const sys = fakeSystem(PACKAGE);
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    await expect(pull(deps, { maxObjects: 2 }, loc())).rejects.toThrow(/more than 2 objects/);
    expect(manifest().objects).toEqual({});
    expect(manifest().pull).toBeUndefined();
    await expect(pull(deps, { maxObjects: 2 }, { ...loc(), maxObjects: 3 })).resolves.toMatchObject({ objects: 3 });
  });

  it('skips subpackages when init said so', async () => {
    const sys = fakeSystem(PACKAGE);
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A', subpackages: false });
    const res = await pull(deps, {}, loc());
    expect(res.packages).toEqual(['ZADTPLUS_A']);
    expect(Object.keys(manifest().objects)).toEqual(['CLAS ZCL_A', 'DTELDE ZDE_A']);
  });

  it('writes neither of two objects that map to the same local file', async () => {
    const sys = fakeSystem({
      ...PACKAGE,
      'ZADTPLUS_A/Other/Classes/ZCL_A/zcl_a.clas.abap': 'twin',
    });
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    const res = await pull(deps, {}, loc());
    expect(res.collisions.count).toBeGreaterThan(0);
    expect(existsSync(file(CLS))).toBe(false);
    expect(manifest().objects['CLAS ZCL_A']).toBeUndefined();
  });

  it('names namespaced objects and packages as AFF does', async () => {
    const sys = fakeSystem({
      'ZADTPLUS_A/zadtplus_a.devck.jsonc': '{}',
      'ZADTPLUS_A/(NSPC)SUB/(nspc)sub.devck.jsonc': '{}',
      'ZADTPLUS_A/(NSPC)SUB/Dictionary/Database Tables/(NSPC)TAB/(nspc)tab.tabl.ddic': 'x',
    });
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    await pull(deps, {}, loc());
    expect(read('src/zadtplus_a/(nspc)sub/(nspc)tab.tabl.ddic')).toBe('x\n');
    expect(manifest().objects['TABL /NSPC/TAB']).toMatchObject({ package: '/NSPC/SUB', dir: 'src/zadtplus_a/(nspc)sub' });
  });

  it('never writes through a symlinked package folder', async () => {
    const { deps } = await pulled();
    const outside = mkdtempSync(path.join(tmpdir(), 'adtplus-outside-'));
    try {
      rmSync(file('src/zadtplus_a/zadtplus_a_sub'), { recursive: true, force: true });
      symlinkSync(outside, file('src/zadtplus_a/zadtplus_a_sub'));
      const m = manifest();
      delete m.objects['DDLS ZI_B'];
      writeFileSync(file('.adtplus/mirror.json'), JSON.stringify(m));
      const res = await pull(deps, {}, loc());
      expect(res.errors.map((e) => e.message)).toEqual([expect.stringMatching(/leaves the mirror root/), expect.stringMatching(/leaves/)]);
      expect(existsSync(path.join(outside, 'zi_b.ddls.acds'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a manifest that points outside src/', async () => {
    const { deps } = await pulled();
    const m = manifest();
    m.objects['CLAS ZCL_A'].dir = 'src/../..';
    writeFileSync(file('.adtplus/mirror.json'), JSON.stringify(m));
    await expect(pull(deps, {}, loc())).rejects.toThrow(/invalid mirror manifest/);
  });
});

describe('mirror status', () => {
  it('reports local changes against the manifest without calling SAP', async () => {
    const { sys } = await pulled();
    writeFileSync(file(CLS), 'changed\n');
    writeFileSync(file('src/zadtplus_a/zcl_a.clas.json'), '{\r\n  "header": {}\r\n}\r\n'); // line endings only
    chmodSync(file('src/zadtplus_a/zde_a.dtelde.jsonc'), 0o644);
    writeFileSync(file('src/zadtplus_a/zde_a.dtelde.jsonc'), 'edited stub');
    rmSync(file(VIEW));
    writeFileSync(file('src/zadtplus_a/zcl_new.clas.abap'), 'new\n');
    writeFileSync(file('src/zadtplus_a/.DS_Store'), '');
    writeFileSync(file('src/zadtplus_a/zi_b.ddls.json.remote'), '{}');
    sys.state.files[CLS_REMOTE] = 'whatever';
    const calls = (sys.adt.repository.readFile as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    const res = await status({ root, workspaceFolders: [ws], adtLsVersion: '1.2.0' });
    expect((sys.adt.repository.readFile as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
    expect(res).toMatchObject({
      system: 'onprem',
      objects: 3,
      files: 6,
      modified: { count: 1, paths: [CLS] },
      readOnlyChanged: { count: 1, paths: ['src/zadtplus_a/zde_a.dtelde.jsonc'] },
      deleted: { count: 1, paths: [VIEW] },
      added: { count: 1, paths: ['src/zadtplus_a/zcl_new.clas.abap'] },
      remote: { count: 1, paths: ['src/zadtplus_a/zi_b.ddls.json.remote'] },
      adtLsChanged: { pulled: '1.1.2', running: '1.2.0' },
    });
    expect(res.unfinishedPull).toBeUndefined();
  });

  it('reports an unfinished pull and read errors', async () => {
    const sys = fakeSystem(PACKAGE);
    sys.state.failRead = (p) =>
      p === CLS_REMOTE ? new Error('boom') : p.includes('/ZI_B/') ? new ThrottledError('throttled', 1000) : undefined;
    const { deps } = fakeDeps(sys.adt, 1);
    await init(deps, {}, { ...loc(), package: 'ZADTPLUS_A' });
    await expect(pull(deps, {}, loc())).rejects.toThrow(ThrottledError);
    const res = await status({ root, workspaceFolders: [ws] });
    expect(res.unfinishedPull).toBeDefined();
    expect(res.readErrors).toEqual([{ path: CLS, message: 'boom' }]);
  });

  it('needs a mirror', async () => {
    mkdirSync(root);
    await expect(status({ root, workspaceFolders: [ws] })).rejects.toThrow(/no mirror/);
  });

  it('keeps an object the listing leaves out while a name search still finds it (ONPREM, never-activated view)', async () => {
    const sys = fakeSystem(PACKAGE);
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'zadtplus_a' });
    await pull(deps, {}, loc());
    const view = 'src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds';
    sys.state.unlisted.add('ZADTPLUS_A/ZADTPLUS_A_SUB/Core Data Services/Data Definitions/ZI_B/');
    const kept = await pull(deps, {}, loc());
    expect(kept).toMatchObject({ notListed: { paths: ['DDLS ZI_B'] }, deleted: { count: 0 } });
    expect(readFileSync(path.join(root, ...view.split('/')), 'utf8')).toContain('ZI_B');
    // Really gone: the search finds nothing, so the unchanged files go.
    for (const p of Object.keys(sys.state.files)) if (p.includes('/ZI_B/')) delete sys.state.files[p];
    const gone = await pull(deps, {}, loc());
    expect(gone).toMatchObject({ notListed: { count: 0 }, deleted: { count: 2 } });
  });
});
