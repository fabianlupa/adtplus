import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDaemon, exchange, sendCommand } from '../../src/daemon/client.js';
import type { DaemonIdentity } from '../../src/daemon/identity.js';
import { createDaemonServer, type DaemonServer } from '../../src/daemon/server.js';
import type { SessionManager } from '../../src/core/session.js';

let dir: string;
let socketPath: string;
const running: DaemonServer[] = [];

const OLD: DaemonIdentity = { build: 'old-build', config: 'cfg' };
const NEW: DaemonIdentity = { build: 'new-build', config: 'cfg' };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adtplus-hs-'));
  socketPath = path.join(dir, 'adtplus.sock');
});

afterEach(async () => {
  for (const d of running.splice(0)) await d.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

function sessionManager(): SessionManager {
  return { disposeAll: vi.fn(async () => undefined) } as unknown as SessionManager;
}

async function startDaemon(identity: DaemonIdentity, onRetired = vi.fn()): Promise<DaemonServer> {
  const daemon = createDaemonServer({ sessionManager: sessionManager(), socketPath, identity, onRetired });
  running.push(daemon);
  await new Promise<void>((resolve) => daemon.server.once('listening', () => resolve()));
  return daemon;
}

describe('daemon restart handshake', () => {
  it('ping reports the identity the daemon was started with', async () => {
    const daemon = await startDaemon(OLD);
    expect(await daemon.handleRequest({ cmd: 'ping' })).toEqual({ ok: true, pong: true, identity: OLD, pid: process.pid });
  });

  it('shutdown leaves a daemon that already matches running', async () => {
    const onRetired = vi.fn();
    const daemon = await startDaemon(NEW, onRetired);
    expect(await daemon.handleRequest({ cmd: 'shutdown', unless: NEW })).toEqual({ ok: true, shuttingDown: false });
    expect(existsSync(socketPath)).toBe(true);
    expect(onRetired).not.toHaveBeenCalled();
  });

  it('a retiring daemon frees the socket path at once and never removes its successor', async () => {
    const onRetired = vi.fn();
    const old = await startDaemon(OLD, onRetired);
    expect(await old.handleRequest({ cmd: 'shutdown', unless: NEW })).toEqual({ ok: true, shuttingDown: true });
    expect(existsSync(socketPath)).toBe(false);

    await startDaemon(NEW);
    await vi.waitFor(() => expect(onRetired).toHaveBeenCalledTimes(1));
    expect(existsSync(socketPath)).toBe(true);
    const pong = await sendCommand({ cmd: 'ping' }, { socketPath, identity: NEW });
    expect(pong).toEqual(expect.objectContaining({ identity: NEW }));
  });

  it('shutdown is allowed in read-only mode', async () => {
    const daemon = createDaemonServer({ sessionManager: sessionManager(), socketPath, identity: OLD, readOnly: true, onRetired: vi.fn() });
    running.push(daemon);
    expect(await daemon.handleRequest({ cmd: 'shutdown', unless: NEW })).toEqual({ ok: true, shuttingDown: true });
  });

  it('ensureDaemon keeps a matching daemon and spawns nothing', async () => {
    await startDaemon(NEW);
    const spawn = vi.fn();
    await ensureDaemon({ socketPath, identity: NEW, spawn });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('ensureDaemon replaces a daemon from another build', async () => {
    const onRetired = vi.fn();
    await startDaemon(OLD, onRetired);
    const spawn = vi.fn(() => void startDaemon(NEW));

    await ensureDaemon({ socketPath, identity: NEW, spawn });

    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onRetired).toHaveBeenCalledTimes(1));
    expect(await sendCommand({ cmd: 'ping' }, { socketPath, identity: NEW })).toEqual(expect.objectContaining({ identity: NEW }));
  });

  it('ensureDaemon asks for a manual stop when a daemon predating the handshake refuses to go', async () => {
    const legacy = await startLegacyDaemon();
    const spawn = vi.fn();
    await expect(ensureDaemon({ socketPath, identity: NEW, spawn })).rejects.toThrow(/Stop it once by hand/);
    expect(spawn).not.toHaveBeenCalled();
    await new Promise((resolve) => legacy.close(resolve));
  });
});

/** A bare socket server answering like a daemon from before the handshake. */
async function startLegacyDaemon(): Promise<Server> {
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      const req = JSON.parse(chunk.toString('utf8').trim()) as { cmd: string };
      const res = req.cmd === 'ping' ? { ok: true, pong: true } : { ok: false, error: `Unknown command "${req.cmd}"` };
      socket.write(`${JSON.stringify(res)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return server;
}

describe('daemon spawn', () => {
  it('never starts a real daemon for a non-default socket path', async () => {
    await expect(ensureDaemon({ socketPath, identity: NEW })).rejects.toThrow(/only one on the default socket/);
  });
});

describe('a daemon that goes away mid-request', () => {
  /** A listener that reads one request line, then closes, answering `answer` first if given. */
  async function listener(answer?: string): Promise<Server> {
    const server = createServer((socket) => {
      socket.once('data', () => (answer === undefined ? socket.destroy() : socket.end(answer)));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return server;
  }

  it('fails the request instead of waiting forever', async () => {
    const server = await listener();
    try {
      await expect(exchange(socketPath, { cmd: 'mirror.pull' })).rejects.toThrow(/closed the connection without answering/);
    } finally {
      server.close();
    }
  });

  it('a whole answer before the close still counts; nothing listening is null', async () => {
    const server = await listener('{"ok":true}\n');
    try {
      await expect(exchange(socketPath, { cmd: 'ping' })).resolves.toEqual({ ok: true });
    } finally {
      server.close();
    }
    await expect(exchange(path.join(dir, 'none.sock'), { cmd: 'ping' })).resolves.toBeNull();
  });

  it('progress lines before the answer go to the callback, the answer resolves', async () => {
    const server = await listener('{"progress":{"stage":"stamps","done":1,"total":2}}\n{"progress":{"stage":"stamps","done":2,"total":2}}\n{"ok":true}\n');
    const seen: unknown[] = [];
    try {
      await expect(exchange(socketPath, { cmd: 'mirror.changes' }, (p) => seen.push(p))).resolves.toEqual({ ok: true });
    } finally {
      server.close();
    }
    expect(seen).toEqual([
      { stage: 'stamps', done: 1, total: 2 },
      { stage: 'stamps', done: 2, total: 2 },
    ]);
  });

  it('while a replaced daemon retires, a ping it closes unanswered means poll on', async () => {
    let pings = 0;
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const req = JSON.parse(chunk.toString().split('\n')[0]!) as { cmd: string };
        if (req.cmd === 'shutdown') return socket.end('{"ok":true,"shuttingDown":true}\n');
        pings += 1;
        // The old build, then one ping closed unanswered while it goes, then its successor.
        if (pings === 2) return socket.destroy();
        socket.end(`${JSON.stringify({ ok: true, pong: true, identity: pings === 1 ? OLD : NEW, pid: 1 })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const spawn = vi.fn();
      await ensureDaemon({ socketPath, identity: NEW, spawn });
      expect(spawn).not.toHaveBeenCalled();
      expect(pings).toBe(3);
    } finally {
      server.close();
    }
  });

  it.skipIf(process.platform !== 'darwin')('a socket path that is no socket is reported, not taken for no daemon', async () => {
    const file = path.join(dir, 'plain');
    writeFileSync(file, '');
    await expect(exchange(file, { cmd: 'ping' })).rejects.toThrow(/ENOTSOCK|EINVAL/);
  });
});
