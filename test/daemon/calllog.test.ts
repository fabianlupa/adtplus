import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../../src/core/session.js';
import type { Destination } from '../../src/core/destinations.js';

// Spy on every fs call that could open or create a file, keeping real behaviour.
const fsSpies = vi.hoisted(() => ({ names: ['appendFileSync', 'openSync', 'writeFileSync', 'createWriteStream'] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped: Record<string, unknown> = {};
  for (const name of fsSpies.names) wrapped[name] = vi.fn((actual as unknown as Record<string, (...a: unknown[]) => unknown>)[name]);
  return { ...actual, ...wrapped };
});

import * as fs from 'node:fs';
import { createDaemonServer } from '../../src/daemon/server.js';
import { digestParams, resolveCallLog } from '../../src/daemon/calllog.js';

const spy = (name: string) => (fs as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]!;

let dir: string;
const savedEnv = process.env.ADTPLUS_LOG;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adtplus-calllog-'));
  for (const name of fsSpies.names) spy(name).mockClear();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ADTPLUS_LOG;
  else process.env.ADTPLUS_LOG = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function fakeSessionManager(): SessionManager {
  return {
    statusAll: vi.fn(() => ({ onprem: null })),
    restStatusAll: vi.fn(() => ({ onprem: null })),
    nativeStatusAll: vi.fn(() => ({ onprem: null })),
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

describe('call log — ADTPLUS_LOG=0 (ADR-005)', () => {
  it('opens and writes no file', async () => {
    process.env.ADTPLUS_LOG = '0';
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager(), destinations: { onprem }, socketPath: path.join(dir, 's.sock') });
    await daemon.handleRequest({ cmd: 'system.status' });
    await daemon.handleRequest({ cmd: 'object.resolve', system: 'onprem', ref: { name: 'ZX', objectType: 'CLAS/OC' } });
    await daemon.close();

    for (const name of fsSpies.names) {
      expect(spy(name)).not.toHaveBeenCalled();
    }
    expect(resolveCallLog('0')).toBeUndefined();
    expect(resolveCallLog(' 0 ')).toBeUndefined();
  });
});

describe('call log — on by default, metadata only (ADR-005)', () => {
  it('unset or empty resolves to metadata in the default file outside the repo, next to the daemon state', () => {
    for (const value of [undefined, '', '  ']) {
      const target = resolveCallLog(value);
      expect(target?.detail).toBe('metadata');
      expect(target?.path).toMatch(/\.cache[\\/]adtplus[\\/]calls\.jsonl$/);
    }
  });

  it('`1` keeps the default file with full lines; a path gets full lines', () => {
    expect(resolveCallLog('1')).toEqual({ path: resolveCallLog(undefined)!.path, detail: 'full' });
    expect(resolveCallLog(path.join(dir, 'x.jsonl'))).toEqual({ path: path.join(dir, 'x.jsonl'), detail: 'full' });
  });

  it('with ADTPLUS_LOG unset, writes time, client, cmd, system, duration and outcome — nothing else', async () => {
    delete process.env.ADTPLUS_LOG;
    const savedHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const daemon = createDaemonServer({ sessionManager: fakeSessionManager(), destinations: { onprem }, socketPath: path.join(dir, 's.sock') });
      await daemon.handleRequest({
        cmd: 'object.update',
        system: 'onprem',
        ref: { name: 'ZSECRET', objectType: 'PROG/P' },
        source: "WRITE / 'TOPSECRET-BODY-12345'.",
        client: 'mcp',
      });
      await daemon.close();
    } finally {
      process.env.HOME = savedHome;
    }

    const raw = readFileSync(path.join(dir, '.cache', 'adtplus', 'calls.jsonl'), 'utf8');
    expect(raw).not.toContain('TOPSECRET');
    expect(raw).not.toContain('ZSECRET');
    const line = JSON.parse(raw.trim());
    expect(Object.keys(line).sort()).toEqual(['client', 'cmd', 'ms', 'ok', 'system', 'ts']);
    expect(line).toMatchObject({ client: 'mcp', cmd: 'object.update', system: 'onprem', ok: false });
  });
});

describe('call log — enabled', () => {
  it('writes one JSONL line per request with client, cmd, system, ok and error', async () => {
    const logPath = path.join(dir, 'calls.jsonl');
    process.env.ADTPLUS_LOG = logPath;
    const daemon = createDaemonServer({ sessionManager: fakeSessionManager(), destinations: { onprem }, socketPath: path.join(dir, 's.sock') });
    await daemon.handleRequest({ cmd: 'system.status', client: 'cli' });
    await daemon.handleRequest({
      cmd: 'object.resolve',
      system: 'onprem',
      ref: { name: 'ZX', objectType: 'CLAS/OC' },
      client: 'mcp',
    });
    await daemon.handleRequest({ cmd: 'ping' });
    await daemon.close();

    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ client: 'cli', cmd: 'system.status', ok: true });
    expect(lines[1]).toMatchObject({ client: 'mcp', cmd: 'object.resolve', system: 'onprem', ok: false });
    expect(lines[1].error).toContain('no session');
    expect(lines[1].params).toEqual({ ref: { name: 'ZX', objectType: 'CLAS/OC' } });
    expect(lines[2].client).toBeNull(); // old callers without the envelope field still work
  });

  it('records scanSource in the digest so a call without it is visible as such', async () => {
    const logPath = path.join(dir, 'calls.jsonl');
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager(),
      destinations: { onprem }, socketPath: path.join(dir, 's.sock'),
      callLog: { path: logPath, detail: 'full' },
    });
    await daemon.handleRequest({
      cmd: 'navigate.whereUsed',
      system: 'onprem',
      ref: { name: 'ZCL_A', objectType: 'CLAS/OC' },
      symbol: 'M',
      scanSource: true,
    });
    await daemon.close();
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(line.params).toMatchObject({ symbol: 'M', scanSource: true });
  });

  it('never logs source content passed to an update command', async () => {
    const logPath = path.join(dir, 'calls.jsonl');
    const secretSource = 'REPORT zsecret.\nWRITE / \'TOPSECRET-BODY-12345\'.';
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager(),
      destinations: { onprem }, socketPath: path.join(dir, 's.sock'),
      callLog: { path: logPath, detail: 'full' },
    });
    await daemon.handleRequest({
      cmd: 'object.update',
      system: 'onprem',
      ref: { name: 'ZSECRET', objectType: 'PROG/P' },
      source: secretSource,
    });
    await daemon.handleRequest({
      cmd: 'object.create',
      system: 'onprem',
      ref: { name: 'ZNEW', objectType: 'PROG/P' },
      package: '$TMP',
      description: 'd',
      additionalFields: { body: 'TOPSECRET-BODY-12345' },
    });
    await daemon.close();
    const raw = readFileSync(logPath, 'utf8');
    expect(raw).not.toContain('TOPSECRET');
    expect(raw).not.toContain('WRITE /');
    expect(JSON.parse(raw.split('\n')[0]!).params.source).toEqual({ len: secretSource.length });
  });

  it('caps the digest and blanks secret-looking keys', () => {
    const big = digestParams({
      cmd: 'object.activate',
      system: 's',
      refs: Array.from({ length: 200 }, (_, i) => ({ name: `ZOBJ_${i}`, objectType: 'CLAS/OC' })),
    });
    expect(JSON.stringify(big).length).toBeLessThan(700);
    const redacted = digestParams({ cmd: 'system.connect', system: 's', password: 'hunter2' } as never);
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });

  it('does not throw when the log cannot be written', async () => {
    const daemon = createDaemonServer({
      sessionManager: fakeSessionManager(),
      destinations: { onprem }, socketPath: path.join(dir, 's.sock'),
      callLog: { path: path.join(dir, 'file-as-dir', 'x', 'calls.jsonl'), detail: 'full' },
    });
    fs.writeFileSync(path.join(dir, 'file-as-dir'), '');
    await expect(daemon.handleRequest({ cmd: 'ping' })).resolves.toMatchObject({ ok: true });
    await daemon.close();
    expect(existsSync(path.join(dir, 'file-as-dir', 'x'))).toBe(false);
  });
});
