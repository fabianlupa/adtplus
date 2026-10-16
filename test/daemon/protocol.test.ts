import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonServer, type DaemonServer } from '../../src/daemon/server.js';
import { sendCommand } from '../../src/daemon/client.js';
import type { SessionManager } from '../../src/core/session.js';
import type { Destination } from '../../src/core/destinations.js';

let dir: string;
let socketPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adtplus-daemon-'));
  socketPath = path.join(dir, 'adtplus.sock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeSessionManager(overrides: Record<string, unknown> = {}): SessionManager {
  return {
    statusAll: vi.fn(() => ({ onprem: null })),
    restStatusAll: vi.fn(() => ({ onprem: null })),
    nativeStatusAll: vi.fn(() => ({ onprem: null })),
    getRest: vi.fn(),
    nativeSupport: vi.fn(),
    get: vi.fn(async (system: string) => ({
      adt: {} as never,
      info: {
        system,
        destination: `adtplus_${system}`,
        logonKind: 'basic' as const,
        connectedAt: '2026-09-17T00:00:00.000Z',
        lastUsedAt: '2026-09-17T00:00:00.000Z',
      },
    })),
    disposeAll: vi.fn(async () => undefined),
    disposeIdle: vi.fn(async () => undefined),
    status: vi.fn(() => null),
    restStatus: vi.fn(() => null),
    nativeStatus: vi.fn(() => null),
    register: vi.fn((destination: Destination) => destination.id),
    ...overrides,
  } as unknown as SessionManager;
}

function waitListening(daemon: DaemonServer): Promise<void> {
  return new Promise((resolve) => daemon.server.once('listening', () => resolve()));
}

describe('daemon protocol', () => {
  it('answers ping over the real unix socket', async () => {
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager(), socketPath });
    await waitListening(daemon);

    const res = await sendCommand({ cmd: 'ping' }, { socketPath });
    expect(res).toEqual({ ok: true, pong: true, identity: expect.any(Object), pid: process.pid });

    await daemon.close();
  });

  it('status reflects the session manager without connecting', async () => {
    const sessionManager = fakeSessionManager();
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({ cmd: 'system.status' });

    expect(res).toEqual(
      expect.objectContaining({ ok: true, sessions: { onprem: null }, restSessions: { onprem: null }, native: { onprem: null } }),
    );
    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(sessionManager.getRest).not.toHaveBeenCalled();
    expect(sessionManager.nativeSupport).not.toHaveBeenCalled();

    await daemon.close();
  });

  it('connect calls sessionManager.get and returns its session info', async () => {
    const sessionManager = fakeSessionManager();
    const daemon = createDaemonServer({ sessionManager, destinations: { 'cloud-erp': { ...onprem, id: 'cloud-erp' } }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({ cmd: 'system.connect', system: 'cloud-erp' });

    expect(sessionManager.get).toHaveBeenCalledWith('cloud-erp');
    expect(res).toEqual(
      expect.objectContaining({ ok: true, session: expect.objectContaining({ system: 'cloud-erp' }) }),
    );

    await daemon.close();
  });

  it('returns an error response for a failing command instead of throwing', async () => {
    const sessionManager = fakeSessionManager({
      get: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const daemon = createDaemonServer({ sessionManager, destinations: { 'cloud-erp': { ...onprem, id: 'cloud-erp' } }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({ cmd: 'system.connect', system: 'cloud-erp' });
    expect(res).toEqual({ ok: false, error: 'boom' });

    await daemon.close();
  });

  it('checkIdle triggers shutdown once idleTimeoutMs has elapsed with no activity', async () => {
    let time = 0;
    const onIdleShutdown = vi.fn(async () => undefined);
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager(),
      socketPath,
      idleTimeoutMs: 1000,
      now: () => time,
      onIdleShutdown,
    });
    await waitListening(daemon);

    time += 500;
    expect(await daemon.checkIdle()).toBe(false);
    expect(onIdleShutdown).not.toHaveBeenCalled();

    time += 600; // 1100ms since start, still no activity
    expect(await daemon.checkIdle()).toBe(true);
    expect(onIdleShutdown).toHaveBeenCalledTimes(1);

    await daemon.close();
  });

  it('is never idle while a request runs, however long; the idle clock starts when it ends', async () => {
    let time = 0;
    const onIdleShutdown = vi.fn(async () => undefined);
    let finish!: () => void;
    const manager = fakeSessionManager();
    manager.get = vi.fn(() => new Promise<never>((_resolve, reject) => (finish = () => reject(new Error('done')))));
    const daemon = createDaemonServer({
      sessionManager: manager,
      destinations: { 'cloud-erp': { ...onprem, id: 'cloud-erp' } },
      socketPath,
      idleTimeoutMs: 1000,
      now: () => time,
      onIdleShutdown,
    });
    await waitListening(daemon);

    const running = daemon.handleRequest({ cmd: 'system.connect', system: 'cloud-erp' });
    await new Promise((r) => setTimeout(r, 0));
    time += 5000; // far past the timeout, but the request still runs
    expect(await daemon.checkIdle()).toBe(false);
    finish();
    await running;
    time += 900; // 900ms since it ended
    expect(await daemon.checkIdle()).toBe(false);
    time += 200;
    expect(await daemon.checkIdle()).toBe(true);
    expect(onIdleShutdown).toHaveBeenCalledTimes(1);

    await daemon.close();
  });

  it('resets the idle clock on activity', async () => {
    let time = 0;
    const onIdleShutdown = vi.fn(async () => undefined);
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager(),
      socketPath,
      idleTimeoutMs: 1000,
      now: () => time,
      onIdleShutdown,
    });
    await waitListening(daemon);

    time += 900;
    await daemon.handleRequest({ cmd: 'ping' }); // activity resets the clock
    time += 900; // 1800ms since start, but only 900ms since the ping
    expect(await daemon.checkIdle()).toBe(false);
    expect(onIdleShutdown).not.toHaveBeenCalled();

    await daemon.close();
  });
});

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: ['ZADTPLUS_TEST'],
};

function fakeAdtForCapabilities() {
  return {
    lifecycle: {
      create: vi.fn(async () => ({ message: 'created' })),
      // Objects resolve into ZADTPLUS_TEST, so run's package check passes (docs/decisions/003-write-gates.md).
      resolveAffUri: vi.fn(
        async (r: { name: string }) =>
          `abap:/repotree-v1/adtplus_onprem/System%20Library/ZADTPLUS_TEST/Source%20Code%20Library/Classes/${r.name}/x.clas.abap`,
      ),
    },
    repository: { readFile: vi.fn(async () => 'source') },
    services: { runApplication: vi.fn(async () => ({ output: 'ok' })) },
  };
}

describe('daemon capability dispatch', () => {
  it('object.create refuses a package outside the write allowlist without touching the SDK', async () => {
    const adt = fakeAdtForCapabilities();
    const sessionManager = fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) });
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({
      cmd: 'object.create',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
      package: 'ZNOT_ALLOWED',
      description: 'x',
    });

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/not in the write allowlist/) });
    expect(adt.lifecycle.create).not.toHaveBeenCalled();

    await daemon.close();
  });

  it('object.create re-roots the created path and its message onto the VS Code mount', async () => {
    const adt = fakeAdtForCapabilities();
    const path = 'abap:/repotree-v1/adtplus_onprem/System%20Library/ZADTPLUS_TEST/Classes/ZCL_X/zcl_x.clas.abap';
    adt.lifecycle.create.mockResolvedValue({ message: `created ${path}`, filePath: path } as never);
    const sessionManager = fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) });
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem: { ...onprem, vfsMount: 'ONPREM 300' } }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({
      cmd: 'object.create',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
      package: 'ZADTPLUS_TEST',
      description: 'x',
    });

    const vfs = 'abap:/repotree-v1/ONPREM%20300/System%20Library/ZADTPLUS_TEST/Classes/ZCL_X/zcl_x.clas.abap';
    expect(res).toEqual({ ok: true, result: { message: `created ${vfs}`, filePath: vfs } });
    await daemon.close();
  });

  it('re-roots every repotree URI inside an error text onto the VS Code mount', async () => {
    const adt = fakeAdtForCapabilities();
    const uri = (n: string) => `abap:/repotree-v1/adtplus_onprem/ZADTPLUS_TEST/${n}/x.clas.abap`;
    adt.lifecycle.create.mockRejectedValue(new Error(`activate ${uri('ZCL_A')} and ${uri('ZCL_B')} first`));
    const sessionManager = fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) });
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem: { ...onprem, vfsMount: 'DEV-100' } }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({
      cmd: 'object.create',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
      package: 'ZADTPLUS_TEST',
      description: 'x',
    });

    expect(res).toEqual({
      ok: false,
      error: 'activate abap:/repotree-v1/DEV-100/ZADTPLUS_TEST/ZCL_A/x.clas.abap and abap:/repotree-v1/DEV-100/ZADTPLUS_TEST/ZCL_B/x.clas.abap first',
    });
    await daemon.close();
  });

  it('run.application refuses a system without allowRun: true before opening a session (ADR-005)', async () => {
    const adt = fakeAdtForCapabilities();
    const get = vi.fn(async () => ({ adt, info: {} }));
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager({ get }), destinations: { onprem }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({
      cmd: 'run.application',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
      confirm: true,
    });

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/run is off here\. It needs "allowRun": true/) });
    expect(get).not.toHaveBeenCalled();
    expect(adt.services.runApplication).not.toHaveBeenCalled();

    await daemon.close();
  });

  it.each([
    [{ refs: [{ name: 'ZCL_X', objectType: 'CLAS/OC' }], source: 'x' }, /"source" checks one object/],
    [{ ref: { name: 'ZCL_X', objectType: 'CLAS/OC' }, include: 'testclasses' }, /"include" goes with "source"/],
    [{ ref: { name: 'Z_SB', objectType: 'SRVB/SVB' }, source: 'x' }, /SRVB Z_SB has no source/],
    [{ ref: { name: 'ZIF_X', objectType: 'INTF/OI' }, source: 'x', include: 'testclasses' }, /only classes have includes/],
  ])('quality.syntax refuses %j before opening a session', async (target, error) => {
    const adt = fakeAdtForCapabilities();
    const get = vi.fn(async () => ({ adt, info: {} }));
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager({ get }), destinations: { onprem }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({ cmd: 'quality.syntax', system: 'onprem', ...target });

    expect(res).toEqual({ ok: false, error: expect.stringMatching(error) });
    expect(get).not.toHaveBeenCalled();

    await daemon.close();
  });

  it.each([
    [{ ref: { name: 'ZADTPLUS_I_TRIP', objectType: 'DDLS/DF' }, source: 'define view entity x as select from y { a }' }, /can't format DDLS text that isn't saved/],
    [{ ref: { name: 'Z_SB', objectType: 'SRVB/SVB' } }, /SRVB Z_SB has no source to format/],
    [{}, /"format" formats one object/],
  ])('quality.format refuses %j before opening a session', async (target, error) => {
    const get = vi.fn(async () => ({ adt: fakeAdtForCapabilities(), info: {} }));
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager({ get }), destinations: { onprem }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({ cmd: 'quality.format', system: 'onprem', ...target } as never);

    expect(res).toEqual({ ok: false, error: expect.stringMatching(error) });
    expect(get).not.toHaveBeenCalled();

    await daemon.close();
  });

  it.each([
    [{ cmd: 'runtime.dumps' }, { onprem }, /runtime logs are off here\. They need "allowRuntimeLogs": true/],
    [{ cmd: 'runtime.dump', id: 'x' }, { onprem }, /runtime logs are off here/],
    [{ cmd: 'runtime.dumps', from: 'yesterday' }, { onprem: { ...onprem, allowRuntimeLogs: true } }, /"from" must be a time/],
    [{ cmd: 'runtime.dump', id: '../x' }, { onprem: { ...onprem, allowRuntimeLogs: true } }, /is not a dump id/],
    [{ cmd: 'runtime.gatewayErrors' }, { onprem }, /runtime logs are off here/],
    [{ cmd: 'runtime.gatewayError', id: 'FrontendError/1' }, { onprem }, /runtime logs are off here/],
    [{ cmd: 'runtime.gatewayErrors', to: 'today' }, { onprem: { ...onprem, allowRuntimeLogs: true } }, /"to" must be a time/],
    [{ cmd: 'runtime.gatewayError', id: '../x' }, { onprem: { ...onprem, allowRuntimeLogs: true } }, /not a gateway error id/],
  ])('%j refuses before opening a session (ADR-015)', async (req, destinations, error) => {
    const adt = fakeAdtForCapabilities();
    const get = vi.fn(async () => ({ adt, info: {} }));
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager({ get }), destinations, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({ system: 'onprem', ...req } as never);

    expect(res).toEqual({ ok: false, error: expect.stringMatching(error) });
    expect(get).not.toHaveBeenCalled();

    await daemon.close();
  });

  it.each([
    [{ cmd: 'object.translations', ref: { name: 'ZM', objectType: 'MSAG/N' } }, { onprem }, /translations are off here\. They need "allowTranslations": true/],
    [{ cmd: 'object.read', ref: { name: 'ZP', objectType: 'TRPR' } }, { onprem }, /translations are off here/],
    [{ cmd: 'object.translations', ref: { name: 'ZT', objectType: 'TABL/DT' } }, { onprem: { ...onprem, allowTranslations: true } }, /not TABL\/DT/],
    [{ cmd: 'object.read', ref: { name: 'ZP', objectType: 'TRPR' }, method: 'x' }, { onprem: { ...onprem, allowTranslations: true } }, /a TRPR read takes .*not "method"/],
    [{ cmd: 'object.read', ref: { name: 'ZP', objectType: 'TRPR' }, cursor: 'x' }, { onprem: { ...onprem, allowTranslations: true } }, /"cursor" narrow a project's texts/],
    [{ cmd: 'object.read', ref: { name: 'ZCL_X', objectType: 'CLAS/OC' }, language: 'de' }, { onprem }, /"language" narrow a translation project's read \(TRPR\), not CLAS\/OC/],
    // Never adt-ls's generic create/update/delete, with or without the switch.
    [{ cmd: 'object.create', ref: { name: 'ZP', objectType: 'TRPR' }, package: 'ZPKG', description: 'x' }, { onprem }, /translations are off here/],
    [
      { cmd: 'object.create', ref: { name: 'ZP', objectType: 'TRPR' }, package: 'ZPKG', description: 'x', properties: { translations: [] } },
      { onprem: { ...onprem, allowTranslations: true } },
      /non-empty list/,
    ],
    [{ cmd: 'object.create', ref: { name: 'ZP', objectType: 'TRPR' }, package: 'ZPKG', description: 'x', additionalFields: { a: 1 } }, { onprem: { ...onprem, allowTranslations: true } }, /"properties", not additionalFields/],
    [{ cmd: 'object.validate', ref: { name: 'ZP', objectType: 'TRPR' }, package: 'ZPKG', description: 'x' }, { onprem: { ...onprem, allowTranslations: true } }, /validate takes a package/],
    [{ cmd: 'object.create', ref: { name: 'Z-P!', objectType: 'TRPR' }, package: 'ZPKG', description: 'x' }, { onprem: { ...onprem, allowTranslations: true } }, /the create was refused.*\n- "Z-P!" is not a project name/],
    [{ cmd: 'object.delete', ref: { name: 'ZP', objectType: 'TRPR' }, confirm: true }, { onprem }, /translations are off here/],
    [{ cmd: 'object.delete', ref: { name: 'ZP', objectType: 'TRPR' } }, { onprem: { ...onprem, allowTranslations: true } }, /requires confirm: true/],
    [{ cmd: 'object.update', ref: { name: 'ZP', objectType: 'TRPR' }, properties: { translations: [] } }, { onprem }, /translations are off here/],
    [{ cmd: 'object.update', ref: { name: 'ZP', objectType: 'TRPR' }, properties: {} }, { onprem: { ...onprem, allowTranslations: true } }, /nothing to change/],
    [{ cmd: 'object.update', ref: { name: 'ZP', objectType: 'TRPR' }, source: 'x' }, { onprem: { ...onprem, allowTranslations: true } }, /through "properties", not "source"/],
    [
      { cmd: 'object.update', ref: { name: 'ZP', objectType: 'TRPR' }, properties: { translations: [{ language: 'de', objectType: 'MSAG/N', name: 'ZM', key: 'K', target: '' }] } },
      { onprem: { ...onprem, allowTranslations: true } },
      /an empty "target" publishes an empty text/,
    ],
  ])('%j refuses before opening a session (ADR-019)', async (req, destinations, error) => {
    const get = vi.fn(async () => ({ adt: fakeAdtForCapabilities(), info: {} }));
    const getRest = vi.fn();
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager({ get, getRest, withRest: getRest }), destinations, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({ system: 'onprem', ...req } as never);

    expect(res).toEqual({ ok: false, error: expect.stringMatching(error) });
    expect(get).not.toHaveBeenCalled();
    expect(getRest).not.toHaveBeenCalled();

    await daemon.close();
  });

  it('data.query refuses a system without allowDataPreview: true before opening a session (ADR-013)', async () => {
    const adt = fakeAdtForCapabilities();
    const get = vi.fn(async () => ({ adt, info: {} }));
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager({ get }), destinations: { onprem }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({ cmd: 'data.query', system: 'onprem', statement: 'SELECT mandt FROM t000' });

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/data preview is off here\. It needs "allowDataPreview": true/) });
    expect(get).not.toHaveBeenCalled();

    await daemon.close();
  });

  it.each([
    ["DELETE FROM t000", /only one SELECT runs here/],
    ["SELECT * FROM t000 USING ALL CLIENTS", /reads another client/],
  ])('data.query refuses %j before opening a session, also where data preview is on', async (statement, error) => {
    const get = vi.fn(async () => ({ adt: fakeAdtForCapabilities(), info: {} }));
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager({ get }),
      destinations: { onprem: { ...onprem, allowDataPreview: true } },
      socketPath,
    });
    await waitListening(daemon);

    const res = await daemon.handleRequest({ cmd: 'data.query', system: 'onprem', statement });

    expect(res).toEqual({ ok: false, error: expect.stringMatching(error) });
    expect(get).not.toHaveBeenCalled();
    await daemon.close();
  });

  it('run.application refuses without confirm: true', async () => {
    const adt = fakeAdtForCapabilities();
    const sessionManager = fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) });
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem: { ...onprem, allowRun: true } }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({
      cmd: 'run.application',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
    });

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/requires confirm: true/) });
    expect(adt.services.runApplication).not.toHaveBeenCalled();

    await daemon.close();
  });

  it('run.application routes through to the session when confirmed', async () => {
    const adt = fakeAdtForCapabilities();
    const sessionManager = fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) });
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem: { ...onprem, allowRun: true } }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({
      cmd: 'run.application',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
      confirm: true,
    });

    expect(res).toEqual({ ok: true, result: { output: 'ok' } });
    expect(adt.services.runApplication).toHaveBeenCalledWith({ name: 'ZCL_X', objectType: 'CLAS/OC', uri: expect.any(String) });

    await daemon.close();
  });

  it('drops a uri a client sends on a ref: the gate checks only URIs adt+ resolved itself', async () => {
    const adt = fakeAdtForCapabilities();
    const sessionManager = fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) });
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem: { ...onprem, allowRun: true } }, socketPath });
    await waitListening(daemon);

    const crafted = 'abap:/repotree-v1/adtplus_onprem/System%20Library/ZADTPLUS_TEST/Classes/ZCL_FOREIGN/zcl_foreign.clas.abap';
    await daemon.handleRequest({
      cmd: 'run.application',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC', uri: crafted },
      confirm: true,
    });

    expect(adt.lifecycle.resolveAffUri).toHaveBeenCalledWith({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(adt.services.runApplication).not.toHaveBeenCalledWith(expect.objectContaining({ uri: crafted }));

    await daemon.close();
  });
});

describe('daemon M6 dispatch', () => {
  const cloud: Destination = { ...onprem, id: 'cloud-erp', kind: 'cloud', auth: 'interactive' };

  it('object.publish hands the destination to the policy gate: a disabled system is refused before opening a session', async () => {
    const adt = { lifecycle: { resolveAffUri: vi.fn() }, services: { listServices: vi.fn() }, raw: { lsp: vi.fn() } };
    const sessionManager = fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) });
    const daemon = createDaemonServer({
      sessionManager,
      destinations: { onprem, 'cloud-erp': { ...cloud, allowPublishService: false } },
      socketPath,
    });
    await waitListening(daemon);

    const res = await daemon.handleRequest({
      cmd: 'object.publish',
      system: 'cloud-erp',
      ref: { name: 'ZADTPLUS_X_SRVB', objectType: 'SRVB/SVB' },
      confirm: true,
    });

    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(/publish and unpublish are disabled here by "allowPublishService": false/),
    });
    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(adt.lifecycle.resolveAffUri).not.toHaveBeenCalled();
    expect(adt.raw.lsp).not.toHaveBeenCalled();

    await daemon.close();
  });

  it('object.unpublish without confirm is refused before opening a session', async () => {
    const sessionManager = fakeSessionManager({ get: vi.fn() });
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem, 'cloud-erp': cloud }, socketPath });
    await waitListening(daemon);

    const res = await daemon.handleRequest({
      cmd: 'object.unpublish',
      system: 'cloud-erp',
      ref: { name: 'ZADTPLUS_X_SRVB', objectType: 'SRVB/SVB' },
    });

    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/confirm/) });
    expect(sessionManager.get).not.toHaveBeenCalled();

    await daemon.close();
  });

  it('navigate.whereUsed with no symbol or position points at the object itself', async () => {
    const adt = { navigation: { findReferences: vi.fn(async () => []) } };
    const sessionManager = fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) });
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem }, socketPath });
    await waitListening(daemon);

    await daemon.handleRequest({
      cmd: 'navigate.whereUsed',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
    });
    expect(adt.navigation.findReferences).toHaveBeenCalledWith(
      { name: 'ZCL_X', objectType: 'CLAS/OC' },
      { symbol: 'ZCL_X', line: undefined, character: undefined },
      expect.anything(),
    );
    await daemon.close();
  });

  it('navigate.* returns {result, notes} intact', async () => {
    const adt = { navigation: { findReferences: vi.fn(async () => []), checkSyntax: vi.fn(async () => []) } };
    const sessionManager = fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) });
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem }, socketPath });
    await waitListening(daemon);

    const refs = await daemon.handleRequest({
      cmd: 'navigate.whereUsed',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
      symbol: 'ZCL_X',
      timeoutMs: 999,
    });
    expect(refs).toEqual({
      ok: true,
      result: {
        result: [],
        notes: [
          expect.stringMatching(/does NOT show that nothing uses the symbol/),
          expect.stringMatching(/own main source can be missing/),
        ],
      },
    });
    expect(adt.navigation.findReferences).toHaveBeenCalledWith(
      { name: 'ZCL_X', objectType: 'CLAS/OC' },
      { symbol: 'ZCL_X', line: undefined, character: undefined },
      { timeoutMs: 999 },
    );

    const syntax = await daemon.handleRequest({
      cmd: 'quality.syntax',
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
    });
    expect(syntax).toEqual({ ok: true, result: { result: [], notes: [expect.stringMatching(/stored source/)] } });

    await daemon.close();
  });
});


describe('daemon object lock around the active-version read', () => {
  it('a command on the same object waits until adt-ls serves the draft again', async () => {
    const log: string[] = [];
    let served = 1;
    let releaseToggle!: () => void;
    const toggleHeld = new Promise<void>((r) => (releaseToggle = r));
    const adt = {
      lifecycle: { resolveAffUri: vi.fn(async () => 'abap:/x/zcl_x.clas.abap') },
      repository: { abapStat: vi.fn(async () => (served === 0 ? 'active' : 'inactive')) },
      source: {
        // The SDK's active read: switch the object to active, read, switch back.
        read: vi.fn(async (args: { version?: string }) => {
          if (args.version !== 'active') return served === 0 ? 'ACTIVE' : 'DRAFT';
          served = 0;
          // Hold the object switched to active until the test lets go.
          await toggleHeld;
          served = 1;
          return 'ACTIVE';
        }),
      },
      navigation: {
        findReferences: vi.fn(async () => []),
        documentSymbols: vi.fn(async () => {
          log.push(`symbols saw ${served === 0 ? 'active' : 'draft'}`);
          return [];
        }),
      },
    };
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) }),
      destinations: { onprem },
      socketPath,
    });
    await waitListening(daemon);

    const ref = { name: 'ZCL_X', objectType: 'CLAS/OC' };
    const references = daemon.handleRequest({ cmd: 'navigate.whereUsed', system: 'onprem', ref, symbol: 'M' });
    await vi.waitFor(() => expect(served).toBe(0));
    const symbols = daemon.handleRequest({ cmd: 'navigate.outline', system: 'onprem', ref: { ...ref, objectType: 'CLAS' } });
    await new Promise((r) => setImmediate(r));
    expect(log).toEqual([]);

    releaseToggle();
    await Promise.all([references, symbols]);
    expect(log).toEqual(['symbols saw draft']);
    expect(served).toBe(1);

    await daemon.close();
  });
});

describe('daemon object.read', () => {
  function readAdtStub() {
    let served: 'active' | 'inactive' = 'inactive';
    let releaseToggle!: () => void;
    const toggleHeld = new Promise<void>((r) => (releaseToggle = r));
    const log: string[] = [];
    const adt = {
      lifecycle: { resolveAffUri: vi.fn(async () => 'abap:/repotree-v1/adtplus_onprem/X/ZCL_X/zcl_x.clas.abap') },
      repository: { abapStat: vi.fn(async () => served) },
      source: {
        read: vi.fn(async (args: { version?: string }) => {
          if (args.version !== 'active') return served === 'active' ? 'ACTIVE' : 'DRAFT';
          served = 'active';
          await toggleHeld;
          served = 'inactive';
          return 'ACTIVE';
        }),
      },
      navigation: {
        documentSymbols: vi.fn(async () => {
          log.push(`symbols saw ${served}`);
          return [];
        }),
      },
    };
    return { adt, log, releaseToggle, served: () => served };
  }

  it('reads the draft by default, re-rooted onto the VS Code mount, and says it is the draft', async () => {
    const { adt } = readAdtStub();
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) }),
      destinations: { onprem: { ...onprem, vfsMount: 'DEV-100' } },
      socketPath,
    });
    await waitListening(daemon);
    const res = await daemon.handleRequest({ cmd: 'object.read', system: 'onprem', ref: { name: 'ZCL_X', objectType: 'CLAS/OC' } });
    expect(res).toMatchObject({
      ok: true,
      result: { uri: 'abap:/repotree-v1/DEV-100/X/ZCL_X/zcl_x.clas.abap', served: 'inactive', source: 'DRAFT' },
    });
    await daemon.close();
  });

  it('an active read holds the object exclusively without deadlocking on its own hold', async () => {
    const { adt, log, releaseToggle, served } = readAdtStub();
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager({ get: vi.fn(async () => ({ adt, info: {} })) }),
      destinations: { onprem },
      socketPath,
    });
    await waitListening(daemon);
    const ref = { name: 'ZCL_X', objectType: 'CLAS/OC' };
    const read = daemon.handleRequest({ cmd: 'object.read', system: 'onprem', ref, version: 'active' });
    await vi.waitFor(() => expect(served()).toBe('active'));
    const symbols = daemon.handleRequest({ cmd: 'navigate.outline', system: 'onprem', ref });
    await new Promise((r) => setImmediate(r));
    expect(log).toEqual([]);

    releaseToggle();
    const [res] = await Promise.all([read, symbols]);
    expect(res).toMatchObject({ ok: true, result: { served: 'active', source: 'ACTIVE' } });
    expect(log).toEqual(['symbols saw inactive']);
    await daemon.close();
  });
});

describe('daemon rate limit (ADR-005)', () => {
  it('answers throttled with retryAfterMs, without opening the session, once the budget is spent', async () => {
    const adt = { navigation: { documentSymbols: vi.fn(async () => []) } };
    const get = vi.fn(async () => ({ adt, info: {} }));
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager({ get }),
      destinations: { onprem: { ...onprem, rateLimit: { perMinute: 1 } } },
      socketPath,
      now: () => 1_000_000,
    });
    await waitListening(daemon);
    const req = { cmd: 'navigate.outline' as const, system: 'onprem', ref: { name: 'ZCL_X', objectType: 'CLAS/OC' } };

    await expect(daemon.handleRequest(req)).resolves.toMatchObject({ ok: true });
    const refused = await daemon.handleRequest(req);
    expect(refused).toEqual({
      ok: false,
      throttled: true,
      retryAfterMs: 60_000,
      error: expect.stringMatching(/adt\+ system "onprem": throttled — 3 requests \(estimated\) in the last minute \(budget 1\)/),
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(adt.navigation.documentSymbols).toHaveBeenCalledTimes(1);
    // status and connect are never throttled.
    await expect(daemon.handleRequest({ cmd: 'system.status' })).resolves.toMatchObject({ ok: true });

    await daemon.close();
  });
});
