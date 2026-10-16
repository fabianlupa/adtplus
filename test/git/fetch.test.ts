import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchStream, objectOfPath } from '../../src/git/fetch.js';
import { stderrLines } from '../../src/git/output.js';
import { parseAddress } from '../../src/git/address.js';
import { realGit } from '../../src/git/git.js';
import { exchange } from '../../src/daemon/client.js';
import type { DaemonProgress } from '../../src/daemon/protocol.js';
import { ThrottledError } from '../../src/daemon/ratelimit.js';
import { privateRef } from '../../src/git/protocol.js';
import { PACKAGE, fakeSystem } from '../mirror/fake.js';
import { gitWorld } from './setup.js';

const REF = privateRef('origin');
const CLASS = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap';
const VIEW = 'ZADTPLUS_A/ZADTPLUS_A_SUB/Core Data Services/Data Definitions/ZI_B/';
const MANIFEST = (repo: string) => path.join(repo, '.git', 'adtplus', 'origin', '.adtplus', 'mirror.json');

let world: ReturnType<typeof gitWorld>;
let repo: string;
let git: ReturnType<typeof gitWorld>['git'];
let daemonWith: ReturnType<typeof gitWorld>['daemonWith'];
let fetchInto: ReturnType<typeof gitWorld>['fetchInto'];
beforeEach(() => {
  world = gitWorld();
  ({ repo, git, daemonWith, fetchInto } = world);
});
afterEach(() => world.cleanup());

describe('git fetch (import)', () => {
  it('a first fetch: one sync commit with the AFF files under src/, nothing of the shadow\'s own', async () => {
    const { send } = daemonWith(fakeSystem(PACKAGE));
    const { said } = await fetchInto(send);
    expect(git('ls-tree', '-r', '--name-only', REF).split('\n').filter(Boolean)).toEqual([
      'src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds',
      'src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json',
      'src/zadtplus_a/zcl_a.clas.abap',
      'src/zadtplus_a/zcl_a.clas.json',
      'src/zadtplus_a/zcl_a.clas.texts.en.properties',
      'src/zadtplus_a/zde_a.dtelde.jsonc',
    ]);
    // Line endings as the mirror writes them (ADR-007).
    expect(git('show', `${REF}:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION.\nENDCLASS.\n');
    expect(git('log', '-1', '--format=%an <%ae>%n%cn%n%at%n%B', REF)).toBe(
      'ONPREM <adtplus@onprem.invalid>\nONPREM\n1791360000\nONPREM: ZADTPLUS_A at 2026-10-07T08:00:00Z\n\n3 objects, 6 files.\n\n',
    );
    expect(said.join('\n')).toMatch(/onprem 2 package\(s\), 3 objects, 6 files: 6 read new, 0 gone/);
    // The shadow mirror lives in $GIT_DIR.
    expect(existsSync(path.join(repo, '.git', 'adtplus', 'origin', '.adtplus', 'mirror.json'))).toBe(true);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('an unchanged system: no commit, the ref stays', async () => {
    const { send } = daemonWith(fakeSystem(PACKAGE));
    await fetchInto(send);
    const tip = git('rev-parse', REF);
    const again = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(again.stream).toBe('feature done\ndone\n');
    expect(again.said).toContain('adtplus: onprem unchanged since the last fetch');
    expect(git('rev-parse', REF)).toBe(tip);
  });

  it('changes on the system: a commit on top naming them; files outside src/ stay', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    await fetchInto(send);
    // The user's own file on top of the fetched commit, as a push would leave it.
    const readme = 'Local notes\n';
    execFileSync('git', ['fast-import', '--quiet'], {
      cwd: repo,
      input: `commit ${REF}\ncommitter Me <me@x> 1 +0000\ndata 7\nreadme\nfrom ${REF}^0\nM 100644 inline README.md\ndata ${readme.length}\n${readme}\ndone\n`,
    });
    const base = git('rev-parse', REF).trim();

    sys.state.files[CLASS] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    for (const p of Object.keys(sys.state.files)) if (p.startsWith(VIEW)) delete sys.state.files[p];
    sys.state.files['ZADTPLUS_A/Source Code Library/Programs/ZADTPLUS_P/zadtplus_p.prog.abap'] = 'REPORT zadtplus_p.\r\n';
    await fetchInto(send, undefined, '2026-10-07T09:00:00Z');

    expect(git('rev-parse', `${REF}^`).trim()).toBe(base);
    expect(git('log', '-1', '--format=%B', REF)).toBe(
      'ONPREM: ZADTPLUS_A at 2026-10-07T09:00:00Z\n\nNew: PROG ZADTPLUS_P\nChanged: CLAS ZCL_A\nGone: DDLS ZI_B\n\n',
    );
    expect(git('diff', '--name-status', `${REF}^`, REF)).toBe(
      'D\tsrc/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds\nD\tsrc/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json\nA\tsrc/zadtplus_a/zadtplus_p.prog.abap\nM\tsrc/zadtplus_a/zcl_a.clas.abap\n',
    );
    expect(git('show', `${REF}:README.md`)).toBe(readme);
  });

  it('a fetch re-reads only the objects whose change stamp moved, without the walk', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    await fetchInto(send);
    const reads = () => vi.mocked(sys.adt.repository.readFile).mock.calls.length;
    const lists = () => vi.mocked(sys.adt.repository.readDirectory).mock.calls.length;

    // Nothing changed: no object is read at all.
    let [r, l] = [reads(), lists()];
    const quiet = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(quiet.said).toContain('adtplus: 0 object(s) changed since the last fetch (5 objects checked, 5 units)');
    expect([reads() - r, lists() - l]).toEqual([0, 0]);

    // One class changed: its folder is listed and read, nothing else.
    sys.state.files[CLASS] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    [r, l] = [reads(), lists()];
    const one = await fetchInto(send, undefined, '2026-10-07T10:00:00Z');
    expect(one.said).toContain('adtplus: 1 object(s) changed since the last fetch (5 objects checked, 5 units)');
    expect(lists() - l).toBe(1);
    expect(reads() - r).toBe(3);
    expect(git('log', '-1', '--format=%B', REF)).toMatch(/\n\nChanged: CLAS ZCL_A\n/);
  });

  it('an edited function-group include moves its group\'s stamp, though the group\'s own date doesn\'t', async () => {
    const FG = 'ZADTPLUS_A/Source Code Library/Function Groups/ZFG/';
    const sys = fakeSystem({
      ...PACKAGE,
      [`${FG}zfg.fugr.json`]: '{\n  "header": {}\n}',
      [`${FG}zfg.fugr.saplzfg.reps.abap`]: 'FUNCTION-POOL zfg.\r\nINCLUDE lzfgtop.\r\n',
      [`${FG}zfg.fugr.lzfgtop.reps.abap`]: 'DATA gv_a TYPE i.\r\n',
    });
    const { send } = daemonWith(sys);
    await fetchInto(send);
    // The clone's stamps, taken before its first pull, already hold the includes and texts.
    const quiet = await fetchInto(send, undefined, '2026-10-07T08:30:00Z');
    expect(quiet.said).toContain('adtplus: 0 object(s) changed since the last fetch (6 objects checked, 9 units)');
    sys.state.files[`${FG}zfg.fugr.lzfgtop.reps.abap`] = 'DATA gv_a TYPE string.\r\n';
    const edited = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(edited.said).toContain('adtplus: 1 object(s) changed since the last fetch (6 objects checked, 9 units)');
    expect(git('show', `${REF}:src/zadtplus_a/zfg.fugr.lzfgtop.reps.abap`)).toBe('DATA gv_a TYPE string.\n');
  });

  it('a text-only edit moves the stamp through the text elements\' etag, though no date moves', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    await fetchInto(send);
    const TEXTS = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.texts.en.properties';
    sys.state.files[TEXTS] = '@MaxLength:20\r\n001=probe\r\n';
    const edited = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(edited.said).toContain('adtplus: 1 object(s) changed since the last fetch (5 objects checked, 5 units)');
    expect(git('show', `${REF}:src/zadtplus_a/zcl_a.clas.texts.en.properties`)).toBe('@MaxLength:20\n001=probe\n');
  });

  it('a full pull when the stamps can\'t vouch: a new object, a moved one, adtplus.fullFetch', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    await fetchInto(send);
    sys.state.files['ZADTPLUS_A/Source Code Library/Programs/ZADTPLUS_P/zadtplus_p.prog.abap'] = 'REPORT zadtplus_p.\r\n';
    expect((await fetchInto(send, undefined, '2026-10-07T09:00:00Z')).said).toContain('adtplus: reading all of ZADTPLUS_A (new on the system: PROG/P ZADTPLUS_P)…');

    // The view moves to the root package: same content, another package, so its stamp's package moves.
    for (const p of Object.keys(sys.state.files).filter((k) => k.startsWith(VIEW))) {
      sys.state.files[p.replace('ZADTPLUS_A/ZADTPLUS_A_SUB/', 'ZADTPLUS_A/')] = sys.state.files[p]!;
      delete sys.state.files[p];
    }
    const moved = await fetchInto(send, undefined, '2026-10-07T10:00:00Z');
    expect(moved.said).toContain('adtplus: reading all of ZADTPLUS_A (moved to another package: DDLS/DF ZI_B)…');
    expect(git('ls-tree', '-r', '--name-only', REF)).toContain('src/zadtplus_a/zi_b.ddls.acds');

    git('config', 'adtplus.fullFetch', 'true');
    expect((await fetchInto(send, undefined, '2026-10-07T11:00:00Z')).said).toContain('adtplus: reading all of ZADTPLUS_A (adtplus.fullFetch is set)…');
  });

  it('a file that didn\'t read keeps its object off the stamps: the next fetch reads it again', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    await fetchInto(send);
    sys.state.files[CLASS] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    let failed = false;
    sys.state.failRead = (p) => (p === CLASS && !failed ? ((failed = true), new Error('read broke')) : undefined);
    const broken = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(broken.said.join('\n')).toMatch(/not read: src\/zadtplus_a\/zcl_a\.clas\.abap: read broke/);
    const healed = await fetchInto(send, undefined, '2026-10-07T10:00:00Z');
    expect(healed.said).toContain('adtplus: 1 object(s) changed since the last fetch (5 objects checked, 5 units)');
    expect(git('show', `${REF}:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION FINAL.\nENDCLASS.\n');
  });

  it('a stamp check that fails falls back to reading everything, as before G5', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send, rest } = daemonWith(sys);
    await fetchInto(send);
    rest.request.mockImplementationOnce(async () => ({ status: 403, headers: new Headers(), body: '' }));
    const fetched = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(fetched.said.join('\n')).toMatch(/no change stamps \(.*403.*\); reading everything/);
    expect(fetched.said).toContain('adtplus: reading all of ZADTPLUS_A (no change stamps)…');
  });

  it('an object without a stamp that adt-ls can\'t find by name is skipped, not a reason for a full pull', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send, rest } = daemonWith(sys);
    rest.failMeta.add('DDLS/DF ZI_B');
    await fetchInto(send);
    vi.mocked(sys.adt.lifecycle.resolveAffUri).mockImplementation(async () => {
      throw new Error('Object ZI_B (DDLS) not found via search.');
    });
    const again = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(again.said.join('\n')).toMatch(/1 object\(s\) without a stamp couldn't be re-read here \(DDLS ZI_B: DDLS ZI_B not found by name/);
    expect(again.said.join('\n')).not.toMatch(/reading all of/);

    // Not tried again until a full fetch.
    const tries = vi.mocked(sys.adt.lifecycle.resolveAffUri).mock.calls.length;
    const third = await fetchInto(send, undefined, '2026-10-07T10:00:00Z');
    expect(third.said).toContain('adtplus: 0 object(s) changed since the last fetch (5 objects checked, 5 units); 1 left until a full fetch');
    expect(vi.mocked(sys.adt.lifecycle.resolveAffUri).mock.calls.length).toBe(tries);
  });

  it('a mirrored object without a change stamp is re-read on every fetch, with a warning', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send, rest } = daemonWith(sys);
    rest.failMeta.add('DDLS/DF ZI_B');
    await fetchInto(send);
    const again = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(again.said.join('\n')).toMatch(/adtplus: no change stamp for DDLS\/DF ZI_B: .*500/);
    expect(again.said).toContain('adtplus: 0 object(s) changed since the last fetch (5 objects checked, 5 units); 1 without a stamp re-read too');
  });

  it('a clone stopped by a cooldown makes no commit; the next fetch resumes and commits', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    let throttle = true;
    sys.state.failRead = (p) => (throttle && p.startsWith(VIEW) ? new ThrottledError('throttled', 30_000) : undefined);
    await expect(fetchInto(send)).rejects.toThrow(/throttled/);
    expect(() => git('rev-parse', '--verify', '-q', REF)).toThrow();
    throttle = false;
    const reads = vi.mocked(sys.adt.repository.readFile).mock.calls.length;
    await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(git('ls-tree', '-r', '--name-only', REF).split('\n').filter(Boolean)).toHaveLength(6);
    // Only what the stopped pull hadn't read is read now (plus the gone check's name search).
    expect(vi.mocked(sys.adt.repository.readFile).mock.calls.length - reads).toBeLessThan(6);
  });

  it('a resumed clone reads again what changed since it stopped, though the stopped pull read it', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    let throttle = true;
    sys.state.failRead = (p) => (throttle && p.startsWith(VIEW) ? new ThrottledError('throttled', 30_000) : undefined);
    await expect(fetchInto(send)).rejects.toThrow(/throttled/);
    const shadow = JSON.parse(readFileSync(MANIFEST(repo), 'utf8'));
    expect(shadow.pull).toBeDefined();
    expect(shadow.objects['CLAS ZCL_A']).toBeDefined();

    throttle = false;
    sys.state.files[CLASS] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    const resumed = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(resumed.said).toContain('adtplus: reading all of ZADTPLUS_A (a pull stopped before it finished)…');
    expect(git('show', `${REF}:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION FINAL.\nENDCLASS.\n');
    // The stamps kept now match what the shadow holds.
    const quiet = await fetchInto(send, undefined, '2026-10-07T10:00:00Z');
    expect(quiet.said).toContain('adtplus: onprem unchanged since the last fetch');
  });

  it('a stopped pull without pending stamps (a push\'s re-read) resumes against the last fetch\'s stamps', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    await fetchInto(send);
    const shadow = path.join(repo, '.git', 'adtplus', 'origin');
    // A full pull as a push starts it, stopped at the view.
    let throttle = true;
    sys.state.failRead = (p) => (throttle && p.startsWith(VIEW) ? new ThrottledError('throttled', 30_000) : undefined);
    const stopped = await send({ cmd: 'mirror.pull', system: 'onprem', root: shadow, workspaceFolders: [path.dirname(shadow)], client: 'git' });
    expect(stopped).toMatchObject({ ok: false, throttled: true });
    throttle = false;
    sys.state.files[CLASS] = 'CLASS zcl_a DEFINITION FINAL.\r\nENDCLASS.\r\n';
    const reads = vi.mocked(sys.adt.repository.readFile).mock.calls.length;
    const resumed = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(resumed.said).toContain('adtplus: reading all of ZADTPLUS_A (a pull stopped before it finished)…');
    expect(git('show', `${REF}:src/zadtplus_a/zcl_a.clas.abap`)).toBe('CLASS zcl_a DEFINITION FINAL.\nENDCLASS.\n');
    // The class and the unread view again, not everything: the data element stays resumed.
    expect(vi.mocked(sys.adt.repository.readFile).mock.calls.length - reads).toBeLessThan(6);
  });

  it('an adt-ls upgrade reads everything again, even with nothing changed', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    await fetchInto(send);
    const shadow = JSON.parse(readFileSync(MANIFEST(repo), 'utf8'));
    writeFileSync(MANIFEST(repo), JSON.stringify({ ...shadow, adtLs: '1.1.1' }));
    const again = await fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    expect(again.said).toContain('adtplus: reading all of ZADTPLUS_A (adt-ls changed since the last pull (1.1.1 → 1.1.2))…');
  });

  it('shows progress while a full pull runs: objects, percent, units', async () => {
    const sys = fakeSystem(PACKAGE);
    const { send } = daemonWith(sys);
    const original = vi.mocked(sys.adt.repository.readFile).getMockImplementation()!;
    vi.mocked(sys.adt.repository.readFile).mockImplementation(async (uri) => {
      await new Promise((r) => setTimeout(r, 15));
      return original(uri);
    });
    const shown: string[] = [];
    const stream = await fetchStream({
      send,
      git: realGit(repo),
      gitDir: path.join(repo, '.git'),
      remote: 'origin',
      address: parseAddress('onprem/package/ZADTPLUS_A'),
      say: () => {},
      progress: (line) => shown.push(line),
      progressMs: 5,
    });
    expect(Buffer.concat(stream).toString()).toContain('commit refs/adtplus/origin/heads/main');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.at(-1)).toMatch(/^adtplus: reading objects: \d+% \(\d\/3\), \d+ units/);
  });

  it('shows progress while the change stamps are read', async () => {
    const { send } = daemonWith(fakeSystem(PACKAGE));
    const shown: string[] = [];
    await fetchStream({
      send,
      git: realGit(repo),
      gitDir: path.join(repo, '.git'),
      remote: 'origin',
      address: parseAddress('onprem/package/ZADTPLUS_A'),
      say: () => {},
      progress: (line) => shown.push(line),
    });
    const stamps = shown.filter((l) => l.startsWith('adtplus: checking stamps: '));
    expect(stamps[0]).toMatch(/: 0% \(0\/(\d+)\), \d+ units$/);
    expect(stamps.at(-1)).toMatch(/: 100% \((\d+)\/\1\), \d+ units$/);
  });

  it('over the socket: progress lines first, the last step of each stage among them, then the answer', async () => {
    const { send, socketPath } = daemonWith(fakeSystem(PACKAGE));
    await fetchInto(send);
    const seen: DaemonProgress[] = [];
    const location = { system: 'onprem', root: path.join(repo, '.git', 'adtplus', 'origin'), workspaceFolders: [path.join(repo, '.git', 'adtplus')] };
    const res = await exchange(socketPath, { cmd: 'mirror.changes', ...location, client: 'git', progress: true }, (p) => seen.push(p));
    expect(res).toMatchObject({ ok: true });
    expect(seen.at(-1)).toMatchObject({ stage: 'stamps', done: seen.at(-1)!.total });
    // Throttled: the first step and the last, not one line per object read in between.
    expect(seen.length).toBeLessThan(seen.at(-1)!.total + 1);
  });

  it('a system without the opt-in: refused before any SAP call', async () => {
    const { send, sessionManager } = daemonWith(fakeSystem(PACKAGE), { mirror: {} });
    await expect(fetchInto(send)).rejects.toThrow(/git remote not enabled for onprem/);
    expect(sessionManager.get).not.toHaveBeenCalled();
  });

  it('a package the system doesn\'t know', async () => {
    const { send } = daemonWith(fakeSystem(PACKAGE));
    await expect(fetchInto(send, 'onprem/package/ZADTPLUS_NOPE')).rejects.toThrow('package ZADTPLUS_NOPE not found on onprem');
  });

  it('a remote whose address changed is refused, naming the shadow to remove', async () => {
    const { send } = daemonWith(fakeSystem(PACKAGE));
    await fetchInto(send);
    await expect(fetchInto(send, 'onprem/package/ZADTPLUS_A?no-subpackages')).rejects.toThrow(/mirrors onprem\/package\/ZADTPLUS_A, not the remote's address; remove that folder/);
  });

  it('adtplus.maxObjects from git config is the ceiling', async () => {
    const { send } = daemonWith(fakeSystem(PACKAGE));
    git('config', 'adtplus.maxObjects', '2');
    await expect(fetchInto(send)).rejects.toThrow(/more than 2 objects/);
    git('config', 'adtplus.maxObjects', 'lots');
    await expect(fetchInto(send)).rejects.toThrow(/adtplus.maxObjects must be a positive whole number/);
    git('config', 'adtplus.maxObjects', '3');
    await fetchInto(send);
    expect(git('rev-parse', '--verify', REF)).toMatch(/^[0-9a-f]{40}/);
  });

  it('objectOfPath names objects as the mirror does', () => {
    expect(objectOfPath('src/zadtplus_a/zcl_a.clas.locals_imp.abap')).toBe('CLAS ZCL_A');
    expect(objectOfPath('src/zadtplus_a/(dmo)agency.tabl.json')).toBe('TABL /DMO/AGENCY');
  });

  it('a shorter progress line covers the rest of the longer one before it', () => {
    let out = '';
    const stderr = stderrLines((text) => void (out += text));
    stderr.progress('adtplus: writing objects: 50% (2/4), 9 units, ~12 s left');
    stderr.progress('adtplus: activating 4 object(s)…');
    expect(out.split('\r')[1]).toBe('adtplus: activating 4 object(s)…'.padEnd('adtplus: writing objects: 50% (2/4), 9 units, ~12 s left'.length));
  });

  it('a client gone mid-command doesn\'t end the daemon', async () => {
    const { send, socketPath, rest } = daemonWith(fakeSystem(PACKAGE));
    await fetchInto(send);
    // Slow reads: progress lines still go out after the client is gone.
    const original = rest.request.getMockImplementation()!;
    rest.request.mockImplementation(async (...args) => {
      await new Promise((r) => setTimeout(r, 300));
      return original(...args);
    });
    const location = { system: 'onprem', root: path.join(repo, '.git', 'adtplus', 'origin'), workspaceFolders: [path.join(repo, '.git', 'adtplus')] };
    await new Promise<void>((resolve) => {
      const conn = net.connect(socketPath, () => conn.write(`${JSON.stringify({ cmd: 'mirror.changes', ...location, client: 'git', progress: true })}\n`));
      // Gone at the first progress line: the rest of them and the answer go to a closed socket.
      conn.once('data', () => {
        conn.destroy();
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 1500));
    await expect(exchange(socketPath, { cmd: 'ping' })).resolves.toMatchObject({ ok: true });
  });

  it('a line after a progress line starts on its own line, never on top of it', () => {
    let out = '';
    const stderr = stderrLines((text) => void (out += text));
    stderr.progress('adtplus: reading objects: 99% (1470/1477)');
    stderr.progress('adtplus: reading objects: 100% (1477/1477)');
    stderr.line('adtplus: onprem 3 package(s)');
    stderr.line('adtplus: done');
    stderr.end();
    expect(out).toBe('adtplus: reading objects: 99% (1470/1477)\radtplus: reading objects: 100% (1477/1477)\r\nadtplus: onprem 3 package(s)\nadtplus: done\n');
  });
});

describe('git fetch of a software component (swc/, G4)', () => {
  const OTHER = {
    'ZADTPLUS_B/zadtplus_b.devck.jsonc': '{}',
    'ZADTPLUS_B/Source Code Library/Interfaces/ZIF_B/zif_b.intf.abap': 'INTERFACE zif_b PUBLIC.\r\nENDINTERFACE.\r\n',
    'ZADTPLUS_C/zadtplus_c.devck.jsonc': '{}',
    'ZADTPLUS_C/Source Code Library/Interfaces/ZIF_C/zif_c.intf.abap': 'INTERFACE zif_c PUBLIC.\r\nENDINTERFACE.\r\n',
  };
  const inComponent = (rest: { components: Record<string, string> }) =>
    Object.assign(rest.components, { ZADTPLUS_A: 'ZT1_DEV', ZADTPLUS_A_SUB: 'ZT1_DEV', ZADTPLUS_B: 'ZT1_DEV', ZADTPLUS_C: 'HOME' });

  it('clones the component\'s root packages with their subpackages, nothing of another component', async () => {
    const { send, rest } = daemonWith(fakeSystem({ ...PACKAGE, ...OTHER }));
    inComponent(rest);
    await fetchInto(send, 'onprem/swc/zt1_dev');
    const files = git('ls-tree', '-r', '--name-only', REF);
    expect(files).toContain('src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.acds');
    expect(files).toContain('src/zadtplus_b/zif_b.intf.abap');
    expect(files).not.toContain('zadtplus_c');
    expect(git('log', '-1', '--format=%s', REF)).toBe('ONPREM: ZT1_DEV at 2026-10-07T08:00:00Z\n');
    const manifest = JSON.parse(readFileSync(MANIFEST(repo), 'utf8')) as { packages: unknown };
    expect(manifest.packages).toEqual([
      { name: 'ZADTPLUS_A', subpackages: true },
      { name: 'ZADTPLUS_B', subpackages: true },
    ]);
  });

  it('a package new in the component joins on the next fetch; one that left is still fetched, with a warning', async () => {
    const sys = fakeSystem({ ...PACKAGE, ...OTHER });
    const { send, rest } = daemonWith(sys);
    inComponent(rest);
    await fetchInto(send, 'onprem/swc/ZT1_DEV');
    rest.components.ZADTPLUS_C = 'ZT1_DEV';
    rest.components.ZADTPLUS_B = 'HOME';
    const again = await fetchInto(send, 'onprem/swc/ZT1_DEV', '2026-10-07T09:00:00Z');
    expect(again.said).toContain('adtplus: new in swc ZT1_DEV: package ZADTPLUS_C');
    expect(again.said).toContain('adtplus: no longer in swc ZT1_DEV, still fetched: ZADTPLUS_B; clone again to drop them');
    expect(git('ls-tree', '-r', '--name-only', REF)).toContain('src/zadtplus_c/zif_c.intf.abap');
    expect(git('log', '-1', '--format=%B', REF)).toMatch(/\n\nNew: INTF ZIF_C\n/);
  });

  it('a root that a new package of the component now holds stops being a root', async () => {
    const sys = fakeSystem({ ...PACKAGE, ...OTHER });
    const { send, rest } = daemonWith(sys);
    inComponent(rest);
    await fetchInto(send, 'onprem/swc/ZT1_DEV');
    // ZADTPLUS_TOP, new, takes ZADTPLUS_A and ZADTPLUS_B under it.
    for (const p of Object.keys(sys.state.files).filter((p) => /^ZADTPLUS_[AB]\//.test(p))) {
      sys.state.files[`ZADTPLUS_TOP/${p}`] = sys.state.files[p]!;
      delete sys.state.files[p];
    }
    sys.state.files['ZADTPLUS_TOP/zadtplus_top.devck.jsonc'] = '{}';
    rest.components.ZADTPLUS_TOP = 'ZT1_DEV';
    const again = await fetchInto(send, 'onprem/swc/ZT1_DEV', '2026-10-07T09:00:00Z');
    expect(again.said).toContain('adtplus: new in swc ZT1_DEV: package ZADTPLUS_TOP');
    expect(again.said).toContain('adtplus: no longer roots of swc ZT1_DEV, now inside one: ZADTPLUS_A, ZADTPLUS_B');
    const manifest = JSON.parse(readFileSync(MANIFEST(repo), 'utf8')) as { packages: unknown };
    expect(manifest.packages).toEqual([{ name: 'ZADTPLUS_TOP', subpackages: true }]);
    const files = git('ls-tree', '-r', '--name-only', REF);
    expect(files).toContain('src/zadtplus_top/zadtplus_a/zcl_a.clas.abap');
    expect(files).not.toMatch(/^src\/zadtplus_a\//m);
  });

  it('an existing clone keeps its roots when they can\'t be resolved; a first clone fails', async () => {
    const { send, rest } = daemonWith(fakeSystem({ ...PACKAGE, ...OTHER }));
    inComponent(rest);
    await fetchInto(send, 'onprem/swc/ZT1_DEV');
    rest.request.mockImplementationOnce(async () => ({ status: 404, headers: new Headers(), body: '' }));
    rest.request.mockImplementationOnce(async () => ({ status: 503, headers: new Headers(), body: 'busy' }));
    const again = await fetchInto(send, 'onprem/swc/ZT1_DEV', '2026-10-07T09:00:00Z');
    expect(again.said.join('\n')).toMatch(/swc ZT1_DEV's packages not resolved \(.*\); fetching the ones the clone has/);
    expect(again.said).toContain('adtplus: onprem unchanged since the last fetch');
  });

  it('a first fetch that failed binds no address: the corrected remote fetches', async () => {
    const { send } = daemonWith(fakeSystem({ ...PACKAGE, ...OTHER }));
    await expect(fetchInto(send, 'onprem/package/ZADTPLUS_TYPO')).rejects.toThrow('package ZADTPLUS_TYPO not found on onprem');
    await fetchInto(send, 'onprem/package/ZADTPLUS_A');
    expect(git('ls-tree', '-r', '--name-only', REF)).toContain('src/zadtplus_a/zcl_a.clas.abap');
  });

  it('a component without packages on the system is an error', async () => {
    const { send, rest } = daemonWith(fakeSystem({ ...PACKAGE, ...OTHER }));
    inComponent(rest);
    await expect(fetchInto(send, 'onprem/swc/ZT2_DEV')).rejects.toThrow('software component ZT2_DEV has no package to clone on onprem');
  });

  it('above the ceiling: refused before any package is read, naming how to raise it', async () => {
    const { send, rest } = daemonWith(fakeSystem({ ...PACKAGE, ...OTHER }));
    inComponent(rest);
    git('config', 'adtplus.maxObjects', '1');
    // A ceiling of 1 lets the search find 104; the fake has fewer. No package named ZT1_DEV, then the search.
    rest.request.mockImplementationOnce(async () => ({ status: 404, headers: new Headers(), body: '' }));
    rest.request.mockImplementationOnce(async () => ({
      status: 200,
      headers: new Headers(),
      body: Array.from({ length: 104 }, (_, i) => `<adtcore:objectReference adtcore:uri="/x/${i}" adtcore:type="PROG/P" adtcore:name="Z${i}" adtcore:packageName="ZADTPLUS_A"/>`).join(''),
    }));
    const before = rest.request.mock.calls.length;
    await expect(fetchInto(send, 'onprem/swc/ZT1_DEV')).rejects.toThrow(
      /software component ZT1_DEV has 104 or more objects on onprem, more than the ceiling allows; raise it \(git -c adtplus.maxObjects=<n> clone …\)/,
    );
    expect(rest.request.mock.calls.length - before).toBe(2);
  });

  it('a remote switched between a component and a package is refused', async () => {
    const { send, rest } = daemonWith(fakeSystem({ ...PACKAGE, ...OTHER }));
    inComponent(rest);
    await fetchInto(send, 'onprem/swc/ZT1_DEV');
    await expect(fetchInto(send, 'onprem/package/ZADTPLUS_A')).rejects.toThrow(/mirrors onprem\/swc\/ZT1_DEV, not the remote's address/);
  });
});

