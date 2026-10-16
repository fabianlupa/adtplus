import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adtLsInfo, adtLsWarnings, sameRelease, VERIFIED_ADT_LS, versionFromPath } from '../../src/core/adtls-version.js';
import type { SessionManager } from '../../src/core/session.js';
import type { Destination } from '../../src/core/destinations.js';
import { createDaemonServer, type DaemonServer } from '../../src/daemon/server.js';
import type { ConnectResponse, StatusResponse } from '../../src/daemon/protocol.js';

const EXT_1_1_2 = '/Users/x/.vscode/extensions/sapse.adt-vscode-1.1.2-darwin-arm64/adt-ls/darwin/arm64/adt-ls';
const EXT_1_2_0 = '/Users/x/.vscode/extensions/sapse.adt-vscode-1.2.0-darwin-arm64/adt-ls/darwin/arm64/adt-ls';

describe('adt-ls version check', () => {
  it('reads the version off the extension folder, not off vendor or explicit paths', () => {
    expect(versionFromPath(EXT_1_1_2)).toBe('1.1.2');
    expect(versionFromPath('/repo/vendor/adt-ls/darwin/arm64/adt-ls')).toBeNull();
  });

  it('compares major.minor.patch only, ignoring the build stamp', () => {
    expect(sameRelease('1.1.2.202608131517', '1.1.2')).toBe(true);
    expect(sameRelease('1.2.0', '1.1.2')).toBe(false);
    expect(sameRelease('garbage', '1.1.2')).toBe(false);
  });

  it('matches the verified release without a warning', () => {
    const info = adtLsInfo({ resolvePath: () => EXT_1_1_2 });
    expect(info).toMatchObject({ version: '1.1.2', source: 'path', verified: VERIFIED_ADT_LS, match: true });
    expect(adtLsWarnings(info)).toEqual([]);
  });

  it('warns on a newer extension', () => {
    const info = adtLsInfo({ resolvePath: () => EXT_1_2_0 });
    expect(info.match).toBe(false);
    expect(adtLsWarnings(info)[0]).toContain('npm run smoke');
  });

  it('prefers the live session version over the folder name', () => {
    const info = adtLsInfo({ resolvePath: () => EXT_1_1_2, sessionVersion: '1.2.0.202611010000' });
    expect(info).toMatchObject({ version: '1.2.0.202611010000', source: 'session', match: false });
  });

  it('leaves match open when the version is unknown, and warns when no binary is found', () => {
    expect(adtLsInfo({ resolvePath: () => '/repo/vendor/adt-ls/adt-ls' })).toMatchObject({ source: 'unknown', match: null });
    const missing = adtLsInfo({
      resolvePath: () => {
        throw new Error('adt-ls binary not found. Set ADT_LS_PATH\n  - tried …');
      },
    });
    expect(missing).toMatchObject({ path: null, error: 'adt-ls binary not found. Set ADT_LS_PATH' });
    expect(adtLsWarnings(missing)[0]).toContain('not found');
  });
});

describe('adt-ls version in daemon status and connect', () => {
  let dir: string;
  let daemon: DaemonServer;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'adtplus-adtls-'));
  });
  afterEach(async () => {
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(sessions: Record<string, unknown>, binPath: string): DaemonServer {
    const sessionManager = {
      register: vi.fn((destination: { id: string }) => destination.id),
      status: vi.fn((key: string) => sessions[key]),
      restStatus: vi.fn(() => null),
      nativeStatus: vi.fn(() => null),
      get: vi.fn(async (system: string) => ({ info: sessions[system] })),
      disposeAll: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const destinations = Object.fromEntries(
      Object.keys(sessions).map((id) => [id, { id, kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://x', extraCaCerts: [], writeAllowlist: [] }]),
    ) as Record<string, Destination>;
    daemon = createDaemonServer({
      sessionManager,
      destinations,
      socketPath: path.join(dir, 'd.sock'),
      resolveAdtLsPath: () => binPath,
      onIdleShutdown: () => {},
    });
    return daemon;
  }

  it('status reports the resolved adt-ls and no warnings on the verified release', async () => {
    const res = (await start({ onprem: null }, EXT_1_1_2).handleRequest({ cmd: 'system.status' })) as StatusResponse;
    expect(res.adtLs).toMatchObject({ version: '1.1.2', match: true });
    expect(res.warnings).toBeUndefined();
  });

  it('status and connect warn once a session reports an unverified adt-ls', async () => {
    const info = { system: 'onprem', adtLsVersion: '1.2.0.202611010000' };
    const d = start({ onprem: info }, EXT_1_1_2);
    const status = (await d.handleRequest({ cmd: 'system.status' })) as StatusResponse;
    expect(status.adtLs).toMatchObject({ source: 'session', match: false });
    expect(status.warnings).toHaveLength(1);
    const connect = (await d.handleRequest({ cmd: 'system.connect', system: 'onprem' })) as ConnectResponse;
    expect(connect.warnings?.[0]).toContain('1.2.0');
  });
});
