import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../../src/core/session.js';
import type { Destination } from '../../src/core/destinations.js';
import { sendCommand } from '../../src/daemon/client.js';
import { isReadOnlyEnv, READ_ONLY_CMDS, readOnlyRefusal } from '../../src/daemon/readonly.js';
import { createDaemonServer } from '../../src/daemon/server.js';

/** Every command that writes to SAP or runs code. A new daemon command must land here or in READ_ONLY_CMDS. */
const WRITE_CMDS = [
  'transport.create',
  'transport.assign',
  'transport.release',
  'object.create',
  'object.update',
  'object.activate',
  'object.delete',
  'object.deleteMessages',
  'object.publish',
  'object.unpublish',
  'object.generate',
  'object.applyQuickfixes',
  'run.application',
  'test.unit',
  'mirror.push',
  'mirror.activate',
];

let dir: string;
const savedEnv = process.env.ADTPLUS_READONLY;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adtplus-readonly-'));
  delete process.env.ADTPLUS_READONLY;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ADTPLUS_READONLY;
  else process.env.ADTPLUS_READONLY = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function fakeSessionManager(): SessionManager {
  return {
    statusAll: vi.fn(() => ({})),
    restStatusAll: vi.fn(() => ({})),
    nativeStatusAll: vi.fn(() => ({})),
    get: vi.fn(async () => {
      throw new Error('no session in this test');
    }),
    disposeAll: vi.fn(async () => {}),
    register: vi.fn((destination: Destination) => destination.id),
    status: vi.fn(() => null),
    restStatus: vi.fn(() => null),
    nativeStatus: vi.fn(() => null),
  } as unknown as SessionManager;
}

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: [],
};

describe('read-only mode — the command partition', () => {
  it('every daemon command is either a read or a listed write, never both', () => {
    const source = readFileSync(path.join(__dirname, '../../src/daemon/server.ts'), 'utf8');
    const cmds = [...source.matchAll(/case '([a-zA-Z.]+)':/g)].map((m) => m[1]!);
    expect(cmds.length).toBeGreaterThan(30);
    for (const cmd of cmds) {
      const read = READ_ONLY_CMDS.has(cmd as never);
      expect(read !== WRITE_CMDS.includes(cmd), cmd).toBe(true);
    }
    expect([...READ_ONLY_CMDS].filter((c) => !cmds.includes(c))).toEqual([]);
  });

  it('ADTPLUS_READONLY: set is on, unset/empty/0/false is off', () => {
    expect(isReadOnlyEnv(undefined)).toBe(false);
    expect(isReadOnlyEnv('')).toBe(false);
    expect(isReadOnlyEnv('0')).toBe(false);
    expect(isReadOnlyEnv('false')).toBe(false);
    expect(isReadOnlyEnv('1')).toBe(true);
    expect(isReadOnlyEnv('yes')).toBe(true);
  });

  it('refuses nothing when off', () => {
    for (const cmd of WRITE_CMDS) expect(readOnlyRefusal(cmd, false)).toBeUndefined();
    expect(readOnlyRefusal('some.futureCmd', true)).toContain('refused');
  });
});

describe('read-only mode — the daemon', () => {
  it('a read-only daemon refuses a write before it reaches a session, and says so in status', async () => {
    const sessionManager = fakeSessionManager();
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem }, socketPath: path.join(dir, 's.sock'), readOnly: true });
    const res = await daemon.handleRequest({
      cmd: 'object.update',
      system: 'onprem',
      ref: { name: 'ZX', objectType: 'CLAS/OC' },
      source: 'x',
    });
    expect(res).toEqual({ ok: false, error: 'adt+ is read-only (ADTPLUS_READONLY): "object.update" refused' });
    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(await daemon.handleRequest({ cmd: 'system.status' })).toMatchObject({ ok: true, readOnly: true });

    // A read still goes through to the session layer.
    const read = await daemon.handleRequest({ cmd: 'object.resolve', system: 'onprem', ref: { name: 'ZX', objectType: 'CLAS/OC' } });
    expect(read).toMatchObject({ ok: false, error: 'no session in this test' });
    await daemon.close();
  });

  it('reads ADTPLUS_READONLY from its environment at start', async () => {
    process.env.ADTPLUS_READONLY = '1';
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager(), destinations: { onprem }, socketPath: path.join(dir, 's.sock') });
    expect(await daemon.handleRequest({ cmd: 'system.status' })).toMatchObject({ readOnly: true });
    await daemon.close();
  });

  it('an unrestricted daemon still refuses a request stamped readOnly by its client', async () => {
    const sessionManager = fakeSessionManager();
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem }, socketPath: path.join(dir, 's.sock') });
    const res = await daemon.handleRequest({ cmd: 'object.delete', system: 'onprem', ref: { name: 'ZX', objectType: 'CLAS/OC' }, readOnly: true });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('refused') });
    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(await daemon.handleRequest({ cmd: 'system.status' })).toMatchObject({ readOnly: false });
    await daemon.close();
  });
});

describe('read-only mode — the client', () => {
  async function captureEnvelope(): Promise<Record<string, unknown>> {
    const socketPath = path.join(dir, 'c.sock');
    const identity = { build: 'b', config: 'c' };
    const received: string[] = [];
    const server: Server = createServer((socket) => {
      socket.on('data', (chunk) => {
        const line = chunk.toString('utf8').split('\n')[0]!;
        received.push(line);
        socket.end(`${JSON.stringify({ ok: true, pong: true, identity })}\n`);
      });
    });
    await new Promise<void>((done) => server.listen(socketPath, () => done()));
    await sendCommand({ cmd: 'ping' }, { socketPath, client: 'mcp', identity });
    await new Promise<void>((done) => server.close(() => done()));
    // The first line is ensureDaemon's handshake ping; the envelope follows it.
    return JSON.parse(received.at(-1)!) as Record<string, unknown>;
  }

  it('stamps readOnly when ADTPLUS_READONLY is set in the client process', async () => {
    process.env.ADTPLUS_READONLY = '1';
    expect(await captureEnvelope()).toEqual({ cmd: 'ping', client: 'mcp', readOnly: true });
  });

  it('leaves the envelope unchanged when it is not', async () => {
    expect(await captureEnvelope()).toEqual({ cmd: 'ping', client: 'mcp' });
  });
});
