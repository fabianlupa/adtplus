import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../../src/core/session.js';
import type { Destination } from '../../src/core/destinations.js';
import { denyRefusal, parseDenyList, unknownDenyPatterns } from '../../src/daemon/deny.js';
import { ALL_CMDS } from '../../src/daemon/protocol.js';
import { createDaemonServer } from '../../src/daemon/server.js';

let dir: string;
const savedEnv = process.env.ADTPLUS_DENY;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adtplus-deny-'));
  delete process.env.ADTPLUS_DENY;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ADTPLUS_DENY;
  else process.env.ADTPLUS_DENY = savedEnv;
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

describe('ADTPLUS_DENY — patterns', () => {
  it('ALL_CMDS is exactly the set of commands the daemon dispatches', () => {
    const source = readFileSync(path.join(__dirname, '../../src/daemon/server.ts'), 'utf8');
    const cmds = [...source.matchAll(/case '([a-zA-Z.]+)':/g)].map((m) => m[1]!);
    expect([...cmds].sort()).toEqual([...ALL_CMDS].sort());
  });

  it('parses a comma list, exact names and trailing-* globs', () => {
    const patterns = parseDenyList(' object.delete, transport.* ,, run.application');
    expect(patterns).toEqual(['object.delete', 'transport.*', 'run.application']);
    expect(denyRefusal('object.delete', patterns)).toBe('adt+ refuses "object.delete" (ADTPLUS_DENY)');
    expect(denyRefusal('transport.release', patterns)).toContain('ADTPLUS_DENY');
    expect(denyRefusal('object.deleteSomething', ['object.delete'])).toBeUndefined();
    expect(denyRefusal('object.search', patterns)).toBeUndefined();
    expect(parseDenyList(undefined)).toEqual([]);
  });

  it('a pattern that matches no command refuses everything instead of doing nothing', () => {
    expect(unknownDenyPatterns(['object.delet', 'transport.*'])).toEqual(['object.delet']);
    expect(denyRefusal('object.search', ['object.delet'])).toMatch(/names no known command \(object\.delet\)/);
  });
});

describe('ADTPLUS_DENY — the daemon', () => {
  const del = { cmd: 'object.delete' as const, system: 'onprem', ref: { name: 'ZX', objectType: 'CLAS/OC' }, confirm: true };

  it('refuses a denied command before it reaches a session, and reports the list in status', async () => {
    process.env.ADTPLUS_DENY = 'object.delete';
    const sessionManager = fakeSessionManager();
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem }, socketPath: path.join(dir, 's.sock') });
    expect(await daemon.handleRequest(del)).toEqual({ ok: false, error: 'adt+ refuses "object.delete" (ADTPLUS_DENY)' });
    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(await daemon.handleRequest({ cmd: 'system.status' })).toMatchObject({ ok: true, deny: ['object.delete'] });
    await daemon.close();
  });

  it('an unrestricted daemon honours the list its client stamped', async () => {
    const sessionManager = fakeSessionManager();
    const daemon = createDaemonServer({ sessionManager, destinations: { onprem }, socketPath: path.join(dir, 's.sock') });
    expect(await daemon.handleRequest({ ...del, deny: ['object.*'] })).toMatchObject({ ok: false, error: expect.stringContaining('ADTPLUS_DENY') });
    expect(sessionManager.get).not.toHaveBeenCalled();
    // Without the stamp the request goes on to the session layer.
    expect(await daemon.handleRequest(del)).toMatchObject({ ok: false, error: 'no session in this test' });
    await daemon.close();
  });
});
