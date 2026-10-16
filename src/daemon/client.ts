import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect as netConnect, type Socket } from 'node:net';
import path from 'node:path';
import { compiledDaemonPath, currentIdentity, resolvePackageRoot, sameIdentity, type DaemonIdentity } from './identity.js';
import {
  resolveSocketPath,
  type ClientKind,
  type DaemonProgress,
  type DaemonRequest,
  type DaemonResponse,
  type PongResponse,
} from './protocol.js';
import { findProjectConfigs } from '../core/project-config.js';
import { parseDenyList } from './deny.js';
import { isReadOnlyEnv } from './readonly.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryConnect(socketPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = netConnect(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(null));
  });
}

/** The daemon closed a connection without answering: it died, or was replaced. */
export class DaemonClosedError extends Error {
  constructor() {
    super('the adt+ daemon closed the connection without answering (it stopped or was replaced); run the command again');
    this.name = 'DaemonClosedError';
  }
}

/** Connect errors that mean nothing listens at the socket path; anything else (EACCES, ENOTSOCK, …) is reported. */
const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED']);

/**
 * One request/response exchange on a fresh connection; null when nothing is listening. A
 * daemon that closes the connection without answering is a `DaemonClosedError`: waiting on would
 * never end. Progress lines before the answer go to `onProgress`.
 */
export function exchange(socketPath: string, message: object, onProgress?: (p: DaemonProgress) => void): Promise<DaemonResponse | null> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let buffer = '';
    let connected = false;
    let answered = false;
    socket.once('error', (err: NodeJS.ErrnoException) => (connected || !NOT_LISTENING.has(err.code ?? '') ? reject(err) : resolve(null)));
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineIndex: number;
      while (!answered && (newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          answered = true;
          socket.end();
          reject(err);
          return;
        }
        if (typeof parsed === 'object' && parsed !== null && 'progress' in parsed && !('ok' in parsed)) {
          onProgress?.((parsed as { progress: DaemonProgress }).progress);
          continue;
        }
        answered = true;
        socket.end();
        resolve(parsed as DaemonResponse);
      }
    });
    socket.once('close', () => {
      // After `error` or an answer the promise is settled already, and this changes nothing.
      if (connected && !answered) reject(new DaemonClosedError());
    });
  });
}

function spawnDaemon(): void {
  const root = resolvePackageRoot();
  const compiled = compiledDaemonPath(root);
  if (existsSync(compiled)) {
    spawn(process.execPath, [compiled], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // Dev mode: no build yet, run the TypeScript source directly via the
  // local tsx binary.
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
  const source = path.join(root, 'src', 'daemon', 'server.ts');
  spawn(tsx, [source], { detached: true, stdio: 'ignore' }).unref();
}

export interface EnsureDaemonOptions {
  socketPath?: string;
  spawnTimeoutMs?: number;
  /** Testing seam: the identity a daemon spawned now would have. Defaults to currentIdentity(). */
  identity?: DaemonIdentity;
  /** Testing seam: replaces starting a real daemon process. */
  spawn?: () => void;
}

let starting: Promise<void> | null = null;

/**
 * Connect to the daemon, starting it if it isn't already running and replacing
 * it if it was started from another build or config. Concurrent callers share
 * one spawn.
 */
export function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<void> {
  starting ??= startDaemon(opts).finally(() => {
    starting = null;
  });
  return starting;
}

async function startDaemon(opts: EnsureDaemonOptions): Promise<void> {
  const socketPath = opts.socketPath ?? resolveSocketPath();
  const expected = opts.identity ?? currentIdentity();

  const pong = (await exchange(socketPath, { cmd: 'ping' })) as PongResponse | null;
  if (pong) {
    if (sameIdentity(pong.identity, expected)) return;
    if (await retireDaemon(socketPath, expected, pong)) return;
  }

  if (!opts.spawn && socketPath !== resolveSocketPath()) {
    // A spawned daemon listens on the default path, never this one.
    throw new Error(`No adt+ daemon at ${socketPath}, and only one on the default socket can be started`);
  }
  (opts.spawn ?? spawnDaemon)();

  const timeoutMs = opts.spawnTimeoutMs ?? 20000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await tryConnect(socketPath);
    if (socket) {
      socket.end();
      return;
    }
    await delay(150);
  }
  throw new Error(`adt+ daemon did not start within ${timeoutMs}ms (socket: ${socketPath})`);
}

/**
 * Ask a mismatched daemon to make way, and wait until its socket is gone.
 * true: a matching daemon is already listening (another client replaced it first).
 */
async function retireDaemon(socketPath: string, expected: DaemonIdentity, pong: PongResponse): Promise<boolean> {
  // A retiring daemon may close a connection unanswered: still going, so poll on.
  const going = (err: unknown) => {
    if (err instanceof DaemonClosedError) return 'going' as const;
    throw err;
  };
  // null: it went away between ping and now.
  const res = await exchange(socketPath, { cmd: 'shutdown', unless: expected }).catch(going);
  if (res && res !== 'going' && !res.ok) {
    const pid = pong.pid ?? '<pid>';
    throw new Error(
      `The running adt+ daemon was started from another build or config and can't be replaced (${res.error}). ` +
        `Stop it once by hand (kill ${pid}; find it with \`pgrep -fl daemon/server\`), and adt+ starts a fresh one.`,
    );
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await exchange(socketPath, { cmd: 'ping' }).catch(going);
    if (!current) return false;
    if (current !== 'going' && sameIdentity((current as PongResponse).identity, expected)) return true;
    await delay(50);
  }
  throw new Error(`adt+ daemon at ${socketPath} did not release its socket after shutdown`);
}

export interface SendCommandOptions extends EnsureDaemonOptions {
  /** Stamped onto the request envelope so the daemon's call log can tell the surfaces apart. */
  client?: ClientKind;
  /** The project configs to send. Defaults to those found from ADTPLUS_PROJECT, else the working folder. */
  projectConfigs?: string[];
  /** One project config list per workspace folder (the MCP server's roots); takes precedence over `projectConfigs`. */
  projectConfigSets?: string[][];
  /** Asks a long command for progress and receives it before the answer. */
  onProgress?: (p: DaemonProgress) => void;
}

/** The project configs found from ADTPLUS_PROJECT, else the working folder, nearest first. */
export function defaultProjectConfigs(): string[] {
  return findProjectConfigs(process.env.ADTPLUS_PROJECT?.trim() || process.cwd());
}

/** Send one request to the daemon (starting it if needed) and return its response. */
export async function sendCommand<T extends DaemonResponse = DaemonResponse>(
  req: DaemonRequest,
  opts: SendCommandOptions = {},
): Promise<T> {
  await ensureDaemon(opts);
  const socketPath = opts.socketPath ?? resolveSocketPath();
  const deny = parseDenyList(process.env.ADTPLUS_DENY);
  const sets = opts.projectConfigSets ?? [opts.projectConfigs ?? defaultProjectConfigs()];
  const projectConfigs = sets.length === 1 ? sets[0]! : [];

  const envelope = {
    ...req,
    ...(opts.client ? { client: opts.client } : {}),
    ...(isReadOnlyEnv(process.env.ADTPLUS_READONLY) ? { readOnly: true } : {}),
    ...(deny.length > 0 ? { deny } : {}),
    ...(projectConfigs.length > 0 ? { projectConfigs } : {}),
    ...(sets.length > 1 ? { projectConfigSets: sets } : {}),
    ...(opts.onProgress ? { progress: true } : {}),
  };
  const res = await exchange(socketPath, envelope, opts.onProgress);
  if (!res) throw new Error(`No adt+ daemon at ${socketPath}`);
  return res as T;
}
