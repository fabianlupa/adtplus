import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approve, sha256 } from '../../src/core/project-config.js';
import { SessionManager, type SessionProvider } from '../../src/core/session.js';
import type { DialogAnswer } from '../../src/core/trust-dialog.js';
import { createConfigResolver } from '../../src/daemon/config.js';
import type { ConnectResponse, StatusResponse } from '../../src/daemon/protocol.js';
import { createDaemonServer, type DaemonServer } from '../../src/daemon/server.js';

let home: string;
let daemon: DaemonServer;
let connect: ReturnType<typeof vi.fn>;
const trustStorePath = () => path.join(home, '.config', 'adtplus', 'trusted.json');

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-projects-')));
  mkdirSync(path.join(home, '.config', 'adtplus'), { recursive: true });
  writeFileSync(
    path.join(home, '.config', 'adtplus', 'systems.json'),
    JSON.stringify({ onprem: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://onprem.example', writeAllowlist: ['ZDEV'] } }),
  );
});

afterEach(async () => {
  await daemon?.close();
  rmSync(home, { recursive: true, force: true });
});

async function project(folder: string, content: unknown, approved = true): Promise<string> {
  const dir = path.join(home, folder, '.adtplus');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'systems.json');
  writeFileSync(file, JSON.stringify(content));
  if (approved) await approve(file, sha256(JSON.stringify(content)), trustStorePath());
  return file;
}

function start(ask: () => Promise<DialogAnswer> = async () => 'deny'): DaemonServer {
  connect = vi.fn(async (system: string) => ({
    health: () => ({ connected: true, backendLive: true, destination: `adtplus_${system}` }),
    dispose: vi.fn(async () => undefined),
  }) as unknown as AdtLsClient);
  const provider = { kind: 'basic', connect } as unknown as SessionProvider;
  daemon = createDaemonServer({
    sessionManager: new SessionManager({}, () => provider),
    config: createConfigResolver({
      home,
      systemsConfigPath: path.join(home, '.config', 'adtplus', 'systems.json'),
      adtlsDestinationsPath: path.join(home, 'missing.json'),
      trustStorePath: trustStorePath(),
      ask,
    }),
    socketPath: path.join(home, 'd.sock'),
    callLog: { path: path.join(home, 'calls.jsonl'), detail: 'metadata' },
    onIdleShutdown: () => {},
  });
  return daemon;
}

describe('daemon with project configs (ADR-006)', () => {
  it('shares the session when a project changes only policy, and opens another when it changes the connection', async () => {
    const policy = await project('cust', { onprem: { writeAllowlist: ['ZCUST'] } });
    const connection = await project('other', { onprem: { client: '200' } });
    const d = start();

    await d.handleRequest({ cmd: 'system.connect', system: 'onprem' });
    await d.handleRequest({ cmd: 'system.connect', system: 'onprem', projectConfigs: [policy] });
    expect(connect).toHaveBeenCalledTimes(1);

    const res = (await d.handleRequest({ cmd: 'system.connect', system: 'onprem', projectConfigs: [connection] })) as ConnectResponse;
    expect(connect).toHaveBeenCalledTimes(2);
    expect(res.session.system).toBe('onprem');
  });

  it('status shows the systems and files of the asking client only', async () => {
    const file = await project('cust', {
      onprem: { writeAllowlist: ['ZCUST'] },
      cust: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://c' },
    });
    const d = start();
    await d.handleRequest({ cmd: 'system.connect', system: 'onprem' });

    const plain = (await d.handleRequest({ cmd: 'system.status' })) as StatusResponse;
    const inProject = (await d.handleRequest({ cmd: 'system.status', projectConfigs: [file] })) as StatusResponse;

    expect(Object.keys(plain.sessions)).toEqual(['onprem']);
    expect(Object.keys(inProject.sessions)).toEqual(['onprem', 'cust']);
    expect(inProject.sessions.onprem?.system).toBe('onprem');
    expect(inProject.config?.projectFiles).toEqual({ onprem: [file], cust: [file] });
    expect(inProject.config?.files.map((f) => [f.kind, f.trusted])).toEqual([
      ['user', true],
      ['project', true],
    ]);
  });

  it('refuses a system an unapproved file sets, after the dialog, without opening a session', async () => {
    const file = await project('cust', { onprem: { allowRun: true } }, false);
    const ask = vi.fn(async (): Promise<DialogAnswer> => 'deny');
    const d = start(ask);

    const res = await d.handleRequest({ cmd: 'system.connect', system: 'onprem', projectConfigs: [file] });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/^adt\+ system "onprem" refused: ~\/cust\/\.adtplus\/systems\.json was denied/) });
    expect(connect).not.toHaveBeenCalled();
  });

  it('applies the merged gates: a project allowlist replaces the user one', async () => {
    const file = await project('cust', { onprem: { writeAllowlist: ['ZCUST'] } });
    const d = start();
    const create = {
      cmd: 'object.create' as const,
      system: 'onprem',
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
      package: 'ZDEV',
      description: 'x',
    };

    const res = await d.handleRequest({ ...create, projectConfigs: [file] });

    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe('adt+ system "onprem": package "ZDEV" is not in the write allowlist (ZCUST)');
  });

  it('logs the project configs a request used', async () => {
    const file = await project('cust', { onprem: { writeAllowlist: ['ZCUST'] } });
    const d = start();

    await d.handleRequest({ cmd: 'system.connect', system: 'onprem', projectConfigs: [file] });
    await d.handleRequest({ cmd: 'system.connect', system: 'onprem' });

    const lines = readFileSync(path.join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].config).toEqual([file]);
    expect(lines[1].config).toBeUndefined();
  });
});

describe('client stamp (ADR-006)', () => {
  const saved = { HOME: process.env.HOME, ADTPLUS_PROJECT: process.env.ADTPLUS_PROJECT };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('sends the project configs found from ADTPLUS_PROJECT, nearest first', async () => {
    const outer = await project('cust', {});
    const inner = await project('cust/repo', {});
    process.env.HOME = home;
    process.env.ADTPLUS_PROJECT = path.join(home, 'cust', 'repo');
    const resolve = vi.fn(async () => ({ destinations: {}, sources: {}, layers: [], refused: {} }));
    const socketPath = path.join(home, 'c.sock');
    daemon = createDaemonServer({ sessionManager: new SessionManager(), config: { resolve }, socketPath, callLog: null });
    await new Promise<void>((r) => daemon.server.once('listening', () => r()));

    const { sendCommand } = await import('../../src/daemon/client.js');
    await sendCommand({ cmd: 'system.status' }, { socketPath });

    expect(resolve).toHaveBeenCalledWith([inner, outer], undefined);
  });
});

describe('several workspace folders (ADR-006)', () => {
  it('uses a system that resolves the same everywhere, and refuses one that differs', async () => {
    const same = { cust: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://c' } };
    const a = await project('a', { ...same, onprem: { writeAllowlist: ['ZA'] } });
    const b = await project('b', same);
    const d = start();

    const status = (await d.handleRequest({ cmd: 'system.status', projectConfigSets: [[a], [b]] })) as StatusResponse;

    expect(Object.keys(status.sessions)).toEqual(['cust']);
    expect(status.config?.refused.onprem).toBe(`it differs between the workspace folders (${a} vs. the user config alone)`);
    const res = await d.handleRequest({ cmd: 'system.connect', system: 'onprem', projectConfigSets: [[a], [b]] });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/^adt\+ system "onprem" refused: it differs between the workspace folders/) });
    expect(connect).not.toHaveBeenCalled();
    expect((await d.handleRequest({ cmd: 'system.connect', system: 'cust', projectConfigSets: [[a], [b]] })).ok).toBe(true);
  });

  it('keeps a system that only one folder defines', async () => {
    const a = await project('a', { cust: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://c' } });
    const d = start();

    const status = (await d.handleRequest({ cmd: 'system.status', projectConfigSets: [[a], []] })) as StatusResponse;

    expect(Object.keys(status.sessions).sort()).toEqual(['cust', 'onprem']);
    expect(status.config?.refused).toEqual({});
  });
});
