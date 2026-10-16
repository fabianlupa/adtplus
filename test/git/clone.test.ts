import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAdtlsDestinationsPath, type Destination } from '../../src/core/destinations.js';
import type { SessionManager } from '../../src/core/session.js';
import { currentIdentity, resolvePackageRoot } from '../../src/daemon/identity.js';
import { createDaemonServer } from '../../src/daemon/server.js';
import { PACKAGE, fakeSystem } from '../mirror/fake.js';
import { fakeRest } from './setup.js';

/**
 * Real git runs the helper (through tsx, from PATH) for `adtplus::` URLs; the
 * helper reaches an in-process daemon over a fake system on its socket.
 */

const ROOT = resolvePackageRoot();
let dir: string;
let env: NodeJS.ProcessEnv;
let close: () => Promise<void>;
let sys: ReturnType<typeof fakeSystem>;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-gitclone-')));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const helper = path.join(bin, 'git-remote-adtplus');
  writeFileSync(helper, `#!/bin/sh\nexec "${path.join(ROOT, 'node_modules', '.bin', 'tsx')}" "${path.join(ROOT, 'src', 'git', 'main.ts')}" "$@"\n`);
  chmodSync(helper, 0o755);
  const run = path.join(dir, 'run');
  const config = path.join(dir, 'systems.json');
  env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    XDG_RUNTIME_DIR: run,
    ADTPLUS_CONFIG: config,
    ADTPLUS_PROJECT: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
  };
  sys = fakeSystem(PACKAGE);
  const rest = fakeRest(sys);
  const sessionManager = {
    get: vi.fn(async () => ({ adt: sys.adt, info: { adtLsVersion: '1.1.2' } })),
    withRest: vi.fn(async (_key: string, fn: (r: unknown) => Promise<unknown>) => fn(rest)),
    register: vi.fn((d: Destination) => d.id),
    disposeAll: vi.fn(async () => {}),
  } as unknown as SessionManager;
  const daemon = createDaemonServer({
    sessionManager,
    destinations: {
      onprem: {
        id: 'onprem',
        kind: 'onprem',
        auth: 'basic',
        client: '100',
        systemUrl: 'https://onprem.example',
        extraCaCerts: [],
        writeAllowlist: [{ package: 'ZADTPLUS_A', subpackages: true }],
        mirror: { git: { enabled: true } },
      },
    },
    socketPath: path.join(run, 'adtplus.sock'),
    // What the helper's client computes, so it uses this daemon instead of replacing it.
    identity: currentIdentity({ configPaths: [config, defaultAdtlsDestinationsPath()] }),
    callLog: null,
    resolveAdtLsPath: () => {
      throw new Error('no adt-ls in this test');
    },
  });
  close = () => daemon.close();
});
afterEach(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

/** Run git without blocking the event loop the daemon answers on. */
function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args.join(' ')}: ${err.message}\n${stderr}`)) : resolve({ stdout, stderr }),
    );
  });
}

describe('git clone adtplus::…', () => {
  it('clones a package, then fetches the system\'s change', { timeout: 60_000 }, async () => {
    const cloned = await git(dir, 'clone', 'adtplus::onprem/package/ZADTPLUS_A', 'refac');
    expect(cloned.stderr).toMatch(/adtplus: onprem 2 package\(s\), 3 objects, 6 files/);
    const repo = path.join(dir, 'refac');
    expect(readFileSync(path.join(repo, 'src', 'zadtplus_a', 'zcl_a.clas.abap'), 'utf8')).toBe('CLASS zcl_a DEFINITION.\nENDCLASS.\n');
    expect((await git(repo, 'branch', '--show-current')).stdout).toBe('main\n');
    expect((await git(repo, 'log', '--format=%an|%s', 'origin/main')).stdout).toMatch(/^ONPREM\|ONPREM: ZADTPLUS_A at \S+Z\n$/);
    expect((await git(repo, 'status', '--porcelain')).stdout).toBe('');

    // Unchanged: the ref stays.
    const before = (await git(repo, 'rev-parse', 'origin/main')).stdout;
    expect((await git(repo, 'fetch')).stderr).toMatch(/unchanged since the last fetch/);
    expect((await git(repo, 'rev-parse', 'origin/main')).stdout).toBe(before);

    sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap'] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    await git(repo, 'fetch', '-q');
    expect((await git(repo, 'log', '-1', '--format=%B', 'origin/main')).stdout).toMatch(/\n\nChanged: CLAS ZCL_A\n/);
    expect((await git(repo, 'rev-parse', 'origin/main^')).stdout).toBe(before);
    await git(repo, 'merge', '-q', '--ff-only', 'origin/main');
    expect(readFileSync(path.join(repo, 'src', 'zadtplus_a', 'zcl_a.clas.abap'), 'utf8')).toBe('CLASS zcl_a DEFINITION FINAL.\nENDCLASS.\n');
  });

  it('pushes a commit through the gates; git itself refuses a non-fast-forward, the helper a force push', { timeout: 60_000 }, async () => {
    await git(dir, 'clone', '-q', 'adtplus::onprem/package/ZADTPLUS_A', 'refac');
    const repo = path.join(dir, 'refac');
    writeFileSync(path.join(repo, 'src', 'zadtplus_a', 'zcl_a.clas.abap'), 'CLASS zcl_a DEFINITION.\n  " pushed\nENDCLASS.\n');
    await git(repo, '-c', 'user.name=Me', '-c', 'user.email=me@x', 'commit', '-q', '-am', 'comment');
    const pushed = await git(repo, 'push', '-o', 'no-activate', 'origin', 'main');
    expect(pushed.stderr).toMatch(/adtplus: onprem: 1 object\(s\) written, 0 created, 1 file\(s\), not activated/);
    expect(sys.state.files['ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap']).toContain('" pushed');
    expect((await git(repo, 'rev-parse', 'origin/main')).stdout).toBe((await git(repo, 'rev-parse', 'HEAD')).stdout);

    // A commit beside the pushed one: git refuses it from `list for-push`, before the helper's push.
    await git(repo, 'reset', '-q', '--hard', 'HEAD^');
    writeFileSync(path.join(repo, 'README.md'), 'notes\n');
    await git(repo, 'add', 'README.md');
    await git(repo, '-c', 'user.name=Me', '-c', 'user.email=me@x', 'commit', '-q', '-m', 'notes');
    await expect(git(repo, 'push', 'origin', 'main')).rejects.toThrow(/\[rejected\][\s\S]*non-fast-forward|fetch first/);
    await expect(git(repo, 'push', '--force', 'origin', 'main')).rejects.toThrow(/\[remote rejected\] main -> main \(force push refused/);
  });

  it('a failed fetch ends the helper, so git fails instead of waiting', { timeout: 60_000 }, async () => {
    await expect(git(dir, 'clone', 'adtplus::onprem/package/ZADTPLUS_NOPE', 'nope')).rejects.toThrow(
      /adtplus: package ZADTPLUS_NOPE not found on onprem/,
    );
  });
});
