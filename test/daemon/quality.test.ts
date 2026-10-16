import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination } from '../../src/core/destinations.js';
import type { SessionManager } from '../../src/core/session.js';
import { createDaemonServer } from '../../src/daemon/server.js';
import { PACKAGE, fakeSystem } from '../mirror/fake.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-dquality-')));
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
  vfsMount: 'DEV-100',
};

function daemonWith(files: Record<string, string> = PACKAGE) {
  const sys = fakeSystem(files);
  const adt = sys.adt as unknown as Record<string, unknown>;
  const runAtc = vi.fn(async (ref: { name: string }) => ({
    atcRunCheckResults: [
      { lineNumber: 3, priority: 2, location: `abap:/repotree-v1/adtplus_onprem/X/${ref.name}/f.abap`, message: 'm', checkTitle: 'C' },
    ],
  }));
  adt.quality = { runAtc };
  const sessionManager = {
    get: vi.fn(async () => ({ adt: sys.adt, info: { adtLsVersion: '1.1.2' } })),
    register: vi.fn((d: Destination) => d.id),
    disposeAll: vi.fn(async () => {}),
  } as unknown as SessionManager;
  const daemon = createDaemonServer({
    sessionManager,
    destinations: { onprem },
    socketPath: path.join(dir, 's.sock'),
    readOnly: true,
    deny: [],
    callLog: null,
    resolveAdtLsPath: () => {
      throw new Error('no adt-ls in this test');
    },
  });
  return { daemon, runAtc };
}

describe('batch quality checks in the daemon', () => {
  it('runAtc over a package checks its source objects, with subpackages on request', async () => {
    const { daemon, runAtc } = daemonWith();
    try {
      const flat = await daemon.handleRequest({ cmd: 'quality.atc', system: 'onprem', package: 'ZADTPLUS_A' });
      expect(flat).toMatchObject({ ok: true, result: { objects: 1, checked: 1, counts: { warning: 1 } } });
      expect(runAtc).toHaveBeenCalledWith({ name: 'ZCL_A', objectType: 'CLAS' }, expect.anything());

      const deep = await daemon.handleRequest({ cmd: 'quality.atc', system: 'onprem', package: 'ZADTPLUS_A', subpackages: true });
      expect(deep).toMatchObject({ ok: true, result: { objects: 2 } });
      expect(runAtc).toHaveBeenCalledWith({ name: 'ZI_B', objectType: 'DDLS' }, expect.anything());
    } finally {
      await daemon.close();
    }
  });

  it('runAtc over refs answers with one summary whose URIs open in VS Code', async () => {
    const { daemon, runAtc } = daemonWith();
    try {
      const refs = [
        { name: 'ZCL_A', objectType: 'CLAS/OC' },
        { name: 'ZCL_B', objectType: 'CLAS/OC' },
      ];
      const res = await daemon.handleRequest({ cmd: 'quality.atc', system: 'onprem', refs, checkVariant: 'V' });
      expect(runAtc).toHaveBeenCalledTimes(2);
      expect(res).toMatchObject({ ok: true, result: { objects: 2, counts: { warning: 2 } } });
      const uris = (res as { result: { findings: Array<{ uri: string }> } }).result.findings.map((f) => f.uri);
      expect(uris.every((u) => !u.startsWith('abap:/repotree-v1/adtplus_onprem/'))).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('one ref keeps the single-object result; two targets, or none, are refused', async () => {
    const { daemon, runAtc } = daemonWith();
    try {
      const single = await daemon.handleRequest({ cmd: 'quality.atc', system: 'onprem', ref: { name: 'ZCL_A', objectType: 'CLAS/OC' } });
      expect(single).toMatchObject({ ok: true, result: { atcRunCheckResults: [{ priority: 2 }] } });

      const both = await daemon.handleRequest({
        cmd: 'quality.atc',
        system: 'onprem',
        ref: { name: 'ZCL_A', objectType: 'CLAS/OC' },
        package: 'ZADTPLUS_A',
      });
      expect(both).toMatchObject({ ok: false, error: expect.stringMatching(/exactly one/) });
      const none = await daemon.handleRequest({ cmd: 'quality.syntax', system: 'onprem' });
      expect(none).toMatchObject({ ok: false, error: expect.stringMatching(/exactly one/) });
      expect(runAtc).toHaveBeenCalledTimes(1);
    } finally {
      await daemon.close();
    }
  });

  it('counts only the checkable objects of a package against the batch size', async () => {
    const files: Record<string, string> = { ...PACKAGE };
    for (let i = 0; i < 60; i++) files[`ZADTPLUS_A/Dictionary/Data Elements/ZDE_${i}/zde_${i}.dtel.json`] = '{}';
    const { daemon, runAtc } = daemonWith(files);
    try {
      const res = await daemon.handleRequest({ cmd: 'quality.atc', system: 'onprem', package: 'ZADTPLUS_A' });
      expect(res).toMatchObject({ ok: true, result: { objects: 1 } });
      expect(runAtc).toHaveBeenCalledTimes(1);
    } finally {
      await daemon.close();
    }
  });

  it('refuses a package the system does not have', async () => {
    const { daemon } = daemonWith();
    try {
      const res = await daemon.handleRequest({ cmd: 'quality.abaplint', system: 'onprem', package: 'ZADTPLUS_NOPE' });
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/ZADTPLUS_NOPE not found/) });
    } finally {
      await daemon.close();
    }
  });
});
