import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination } from '../../src/core/destinations.js';
import type { SessionManager } from '../../src/core/session.js';
import { createDaemonServer } from '../../src/daemon/server.js';
import { PACKAGE, fakeSystem } from '../mirror/fake.js';

let dir: string;
let ws: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-dmirror-')));
  ws = path.join(dir, 'ws');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: [],
  languageVersion: 'cloudDevelopment',
  mirror: { maxObjects: 10 },
};

function daemonWith(
  sys: ReturnType<typeof fakeSystem>,
  readOnly = false,
  extra: { deny?: string[]; destination?: Partial<Destination>; logPath?: string } = {},
) {
  const sessionManager = {
    get: vi.fn(async () => ({ adt: sys.adt, info: { adtLsVersion: '1.1.2' } })),
    register: vi.fn((d: Destination) => d.id),
    disposeAll: vi.fn(async () => {}),
  } as unknown as SessionManager;
  return createDaemonServer({
    sessionManager,
    destinations: { onprem: { ...onprem, ...extra.destination } },
    socketPath: path.join(dir, 's.sock'),
    readOnly,
    deny: extra.deny ?? [],
    callLog: extra.logPath ? { path: extra.logPath, detail: 'full' } : null,
    resolveAdtLsPath: () => {
      throw new Error('no adt-ls in this test');
    },
  });
}

describe('mirror commands in the daemon', () => {
  it('init, pull and status run on a read-only daemon: they write only local files', async () => {
    const daemon = daemonWith(fakeSystem(PACKAGE), true);
    const location = { root: path.join(ws, 'm'), workspaceFolders: [ws] };
    try {
      mkdirSync(ws);
      const init = await daemon.handleRequest({ cmd: 'mirror.init', system: 'onprem', package: 'ZADTPLUS_A', ...location });
      expect(init).toMatchObject({ ok: true, result: { found: true } });
      const pulled = await daemon.handleRequest({ cmd: 'mirror.pull', system: 'onprem', ...location });
      expect(pulled).toMatchObject({ ok: true, result: { objects: 3, written: { count: 6 } } });
      expect(readFileSync(path.join(ws, 'm', 'src', 'zadtplus_a', 'zcl_a.clas.abap'), 'utf8')).toBe('CLASS zcl_a DEFINITION.\nENDCLASS.\n');
      const status = await daemon.handleRequest({ cmd: 'mirror.status', ...location });
      expect(status).toMatchObject({ ok: true, result: { modified: { count: 0 }, objects: 3 } });
    } finally {
      await daemon.close();
    }
  });

  it('a pull runs in the bulk lane: no per-minute pacing, its units outside the interactive budget (ADR-008)', async () => {
    const daemon = daemonWith(fakeSystem(PACKAGE), false, { destination: { rateLimit: { perMinute: 5 } } });
    const location = { root: path.join(ws, 'm'), workspaceFolders: [ws] };
    try {
      mkdirSync(ws);
      await daemon.handleRequest({ cmd: 'mirror.init', system: 'onprem', package: 'ZADTPLUS_A', ...location });
      // 28 units against a budget of 5: paced at ⅔ of it, this would wait minutes.
      const pulled = await daemon.handleRequest({ cmd: 'mirror.pull', system: 'onprem', ...location });
      expect(pulled).toMatchObject({ ok: true, result: { objects: 3, units: 28 } });
      const resolved = await daemon.handleRequest({ cmd: 'object.resolve', system: 'onprem', ref: { name: 'ZCL_A', objectType: 'CLAS/OC' } });
      expect(resolved).toMatchObject({ ok: true });
    } finally {
      await daemon.close();
    }
  });

  it('check and new run on a read-only daemon, with the system\'s language version and no SAP call', async () => {
    const sys = fakeSystem(PACKAGE);
    const daemon = daemonWith(sys, true);
    const location = { root: path.join(ws, 'm'), workspaceFolders: [ws] };
    try {
      mkdirSync(ws);
      await daemon.handleRequest({ cmd: 'mirror.init', system: 'onprem', package: 'ZADTPLUS_A', ...location });
      const created = await daemon.handleRequest({ cmd: 'mirror.new', system: 'onprem', type: 'CLAS', name: 'ZCL_ADTPLUS_NEW', ...location });
      expect(created).toMatchObject({ ok: true, result: { object: 'CLAS ZCL_ADTPLUS_NEW', files: ['src/zadtplus_a/zcl_adtplus_new.clas.abap', 'src/zadtplus_a/zcl_adtplus_new.clas.json'] } });
      expect(JSON.parse(readFileSync(path.join(ws, 'm', 'src', 'zadtplus_a', 'zcl_adtplus_new.clas.json'), 'utf8')).header.abapLanguageVersion).toBe('cloudDevelopment');
      const calls = vi.mocked(sys.adt.repository.readDirectory).mock.calls.length;
      const checked = await daemon.handleRequest({ cmd: 'mirror.check', system: 'onprem', ...location });
      expect(checked).toMatchObject({ ok: true, result: { ok: true, languageVersion: 'cloud', files: 2, objects: 1 } });
      expect(vi.mocked(sys.adt.repository.readDirectory).mock.calls.length).toBe(calls);
    } finally {
      await daemon.close();
    }
  });

  it('takes the ceiling from the system\'s mirror policy', async () => {
    const daemon = daemonWith(fakeSystem(PACKAGE));
    const location = { root: ws, workspaceFolders: [ws] };
    try {
      mkdirSync(ws);
      await daemon.handleRequest({ cmd: 'mirror.init', system: 'onprem', package: 'ZADTPLUS_A', ...location });
      const res = await daemon.handleRequest({ cmd: 'mirror.pull', system: 'onprem', maxObjects: 2, ...location });
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('more than 2 objects') });
    } finally {
      await daemon.close();
    }
  });

  it('refuses a root outside the workspace folders the client sent', async () => {
    const daemon = daemonWith(fakeSystem(PACKAGE));
    try {
      mkdirSync(ws);
      const res = await daemon.handleRequest({ cmd: 'mirror.init', system: 'onprem', package: 'ZADTPLUS_A', root: dir, workspaceFolders: [ws] });
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('outside the workspace folders') });
    } finally {
      await daemon.close();
    }
  });

  describe('push and activate', () => {
    const CLS = () => path.join(ws, 'm', 'src', 'zadtplus_a', 'zcl_a.clas.abap');
    async function pulledDaemon(extra: Parameters<typeof daemonWith>[2] = {}, readOnly = false) {
      const sys = fakeSystem(PACKAGE);
      const setup = daemonWith(sys);
      const location = { root: path.join(ws, 'm'), workspaceFolders: [ws] };
      mkdirSync(ws);
      await setup.handleRequest({ cmd: 'mirror.init', system: 'onprem', package: 'ZADTPLUS_A', ...location });
      await setup.handleRequest({ cmd: 'mirror.pull', system: 'onprem', ...location });
      await setup.close();
      writeFileSync(CLS(), 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n');
      const daemon = daemonWith(sys, readOnly, { destination: { writeAllowlist: [{ package: 'ZADTPLUS_A', subpackages: true }] }, ...extra });
      return { sys, daemon, location };
    }
    const writes = (sys: ReturnType<typeof fakeSystem>) =>
      vi.mocked(sys.adt.lifecycle.update).mock.calls.length + vi.mocked(sys.adt.repository.writeFile).mock.calls.length;

    it('pushes, activates and logs one call-log line per write', async () => {
      const logPath = path.join(dir, 'calls.jsonl');
      const { sys, daemon, location } = await pulledDaemon({ logPath });
      try {
        const res = await daemon.handleRequest({ cmd: 'mirror.push', system: 'onprem', client: 'cli', ...location });
        expect(res).toMatchObject({ ok: true, result: { pushed: { paths: ['CLAS ZCL_A'] }, complete: true } });
        expect(writes(sys)).toBe(1);
        const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cmd: string; ok: boolean });
        expect(lines.map((l) => l.cmd)).toEqual(['object.update', 'object.activate', 'mirror.push']);
        expect(lines.every((l) => l.ok)).toBe(true);
      } finally {
        await daemon.close();
      }
    });

    it('refuses in read-only mode and under a deny rule on any command the push uses, before any write', async () => {
      const { sys, daemon, location } = await pulledDaemon({}, true);
      try {
        const res = await daemon.handleRequest({ cmd: 'mirror.push', system: 'onprem', ...location });
        expect(res).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
      } finally {
        await daemon.close();
      }
      for (const [deny, args] of [
        ['object.update', {}],
        ['object.activate', {}],
        ['transport.assign', { transport: 'DEVK900001' }],
        ['object.*', {}],
      ] as const) {
        const d = daemonWith(sys, false, { deny: [deny], destination: { writeAllowlist: [{ package: 'ZADTPLUS_A', subpackages: true }] } });
        try {
          const res = await d.handleRequest({ cmd: 'mirror.push', system: 'onprem', ...args, ...location });
          expect(res, deny).toMatchObject({ ok: false, error: expect.stringContaining('refused before any write') });
        } finally {
          await d.close();
        }
      }
      expect(writes(sys)).toBe(0);
      // Without activation, a deny rule on activation doesn't stand in the way; a dry run writes nothing at all.
      const d = daemonWith(sys, false, { deny: ['object.activate', 'object.update'], destination: { writeAllowlist: ['ZADTPLUS_A'] } });
      try {
        const dry = await d.handleRequest({ cmd: 'mirror.push', system: 'onprem', dryRun: true, ...location });
        expect(dry).toMatchObject({ ok: true, result: { planned: { paths: ['CLAS ZCL_A'] } } });
        const act = await d.handleRequest({ cmd: 'mirror.activate', system: 'onprem', ...location });
        expect(act).toMatchObject({ ok: false, error: expect.stringContaining('object.activate') });
      } finally {
        await d.close();
      }
      expect(writes(sys)).toBe(0);
    });
  });
});

describe('update on an object a mirror this session used holds (ADR-009)', () => {
  async function mirrored() {
    const sys = fakeSystem(PACKAGE);
    const daemon = daemonWith(sys);
    const root = path.join(ws, 'm');
    mkdirSync(ws);
    await daemon.handleRequest({ cmd: 'mirror.init', system: 'onprem', package: 'ZADTPLUS_A', root, workspaceFolders: [ws] });
    await daemon.handleRequest({ cmd: 'mirror.pull', system: 'onprem', root, workspaceFolders: [ws] });
    const update = (extra: Record<string, unknown> = {}, ref = { name: 'ZCL_A', objectType: 'CLAS/OC' }) =>
      daemon.handleRequest({ cmd: 'object.update', system: 'onprem', ref, source: 'x', mirrorRoots: [root], workspaceFolders: [ws], ...extra });
    return { sys, daemon, root, update };
  }

  it('is refused before any SAP call, naming the files to edit', async () => {
    const { sys, daemon, update } = await mirrored();
    try {
      const res = await update();
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('CLAS ZCL_A is mirrored at') });
      expect(res).toMatchObject({ error: expect.stringContaining('src/zadtplus_a/zcl_a.clas.abap') });
      expect(res).toMatchObject({ error: expect.not.stringContaining('properties') });
      expect(sys.adt.repository.writeFile).not.toHaveBeenCalled();
    } finally {
      await daemon.close();
    }
  });

  it('goes on to the usual gates when nothing holds the object', async () => {
    const { daemon, root, update } = await mirrored();
    // The fake system's allowlist is empty: reaching that gate shows the mirror check let it through.
    const notMirrored = { ok: false, error: expect.stringContaining('not in the write allowlist') };
    try {
      // the CLI, or a session that used no mirror
      expect(await update({ mirrorRoots: undefined })).toMatchObject(notMirrored);
      // an object of stubs only can't be pushed
      // (the fake's search doesn't find stubs, so it stops there instead)
      expect(await update({}, { name: 'ZDE_A', objectType: 'DTEL/DE' })).toMatchObject({ ok: false, error: expect.not.stringContaining('mirrored') });
      // a root outside the workspace folders
      expect(await update({ workspaceFolders: [path.join(dir, 'elsewhere')] })).toMatchObject(notMirrored);
      // another system's mirror
      const manifest = path.join(root, '.adtplus', 'mirror.json');
      const text = readFileSync(manifest, 'utf8');
      writeFileSync(manifest, text.replace('"system": "onprem"', '"system": "cloud-erp"'));
      expect(await update()).toMatchObject(notMirrored);
      // the mirror folder deleted after the task
      rmSync(root, { recursive: true });
      expect(await update()).toMatchObject(notMirrored);
    } finally {
      await daemon.close();
    }
  });

  it('a manifest that does not parse refuses the write', async () => {
    const { sys, daemon, root, update } = await mirrored();
    try {
      writeFileSync(path.join(root, '.adtplus', 'mirror.json'), '{');
      expect(await update()).toMatchObject({ ok: false, error: expect.stringContaining("manifest that doesn't parse") });
      expect(sys.adt.repository.writeFile).not.toHaveBeenCalled();
    } finally {
      await daemon.close();
    }
  });
});
