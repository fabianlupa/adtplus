import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '../../src/daemon/protocol.js';
import { parseAddress } from '../../src/git/address.js';
import { realGit } from '../../src/git/git.js';
import { privateRef } from '../../src/git/protocol.js';
import { pushRef, type PushSettings } from '../../src/git/push.js';
import { status } from '../../src/mirror/status.js';
import { PACKAGE, fakeSystem } from '../mirror/fake.js';
import { gitWorld } from './setup.js';

const REF = privateRef('origin');
const CLS = 'src/zadtplus_a/zcl_a.clas.abap';
const CLS_JSON = 'src/zadtplus_a/zcl_a.clas.json';
const CLS_REMOTE = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.abap';
const CLS_JSON_REMOTE = 'ZADTPLUS_A/Source Code Library/Classes/ZCL_A/zcl_a.clas.json';
/** The system's class `.json` holds a key a pushed file may drop: the system keeps it. */
const FILES = { ...PACKAGE, [CLS_JSON_REMOTE]: '{\n  "formatVersion": "1",\n  "header": {}\n}' };

let world: ReturnType<typeof gitWorld>;
let sys: ReturnType<typeof fakeSystem>;
let send: (req: DaemonRequest) => Promise<DaemonResponse>;
beforeEach(async () => {
  world = gitWorld();
  sys = fakeSystem(FILES);
  ({ send } = world.daemonWith(sys, { writeAllowlist: [{ package: 'ZADTPLUS_A', subpackages: true }] }));
  await world.fetchInto(send);
  world.git('checkout', '-q', '-B', 'main', REF);
});
afterEach(() => world.cleanup());

const shadow = () => path.join(world.repo, '.git', 'adtplus', 'origin');
const shadowStatus = () => status({ root: shadow(), workspaceFolders: [path.join(world.repo, '.git', 'adtplus')] });
const writes = () => vi.mocked(sys.adt.lifecycle.update).mock.calls.length + vi.mocked(sys.adt.repository.writeFile).mock.calls.length;

/** Write files in the work tree (null deletes) and commit them on main. */
function commit(files: Record<string, string | null>, message = 'change') {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(world.repo, rel);
    if (text === null) rmSync(abs);
    else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  }
  world.git('add', '-A');
  world.git('-c', 'user.name=Me', '-c', 'user.email=me@x', 'commit', '-q', '-m', message);
}

/** One `push` as git sends it; on `ok` the private ref moves, as git moves it. */
async function push(spec = 'refs/heads/main:refs/heads/main', settings: Partial<PushSettings> = {}, sender = send) {
  const said: string[] = [];
  const warned: string[] = [];
  const shown: string[] = [];
  const answer = await pushRef(
    {
      send: sender,
      git: realGit(world.repo),
      gitDir: path.join(world.repo, '.git'),
      remote: 'origin',
      address: parseAddress('onprem/package/ZADTPLUS_A'),
      say: (l) => said.push(l),
      warn: (l) => warned.push(l),
      progress: (l) => shown.push(l),
    },
    spec,
    { dryRun: false, pushOptions: [], ...settings },
  );
  if (answer.startsWith('ok ')) world.git('update-ref', REF, 'refs/heads/main');
  return { answer, said, warned, shown };
}

describe('git push', () => {
  it('shows progress: objects written of all, then the activation', async () => {
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  PUBLIC SECTION.\nENDCLASS.\n' });
    const pushed = await push();
    expect(pushed.answer).toBe('ok refs/heads/main');
    expect(pushed.shown[0]).toMatch(/^adtplus: writing objects: 0% \(0\/1\), 0 units$/);
    expect(pushed.shown).toContainEqual(expect.stringMatching(/^adtplus: writing objects: 100% \(1\/1\), \d+ units$/));
    expect(pushed.shown.at(-1)).toBe('adtplus: activating 1 object(s)…');
  });

  it('writes the changed files and activates; the shadow takes what the system kept, and the next fetch shows it', async () => {
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  PUBLIC SECTION.\nENDCLASS.\n', [CLS_JSON]: '{\n  "header": {"description": "A"}\n}\n' });
    const pushed = await push();
    expect(pushed.answer).toBe('ok refs/heads/main');
    expect(pushed.said.at(-1)).toMatch(/onprem: 1 object\(s\) written, 0 created, 2 file\(s\), 1 activated/);
    expect(sys.state.files[CLS_REMOTE]).toBe('CLASS zcl_a DEFINITION.\r\n  PUBLIC SECTION.\r\nENDCLASS.\r\n');
    // The shadow equals its base: the system's .json, with the key the push dropped.
    expect((await shadowStatus()).modified.count).toBe(0);
    expect(readFileSync(path.join(shadow(), CLS_JSON), 'utf8')).toContain('formatVersion');

    const pushedTip = world.git('rev-parse', REF).trim();
    const fetched = await world.fetchInto(send, undefined, '2026-10-07T10:00:00Z');
    expect(fetched.stream).toContain(`from ${pushedTip}`);
    expect(world.git('log', '-1', '--format=%B', REF)).toMatch(/\n\nChanged: CLAS ZCL_A\n/);
    expect(world.git('diff', '--name-only', pushedTip, REF)).toBe(`${CLS_JSON}\n`);
  });

  it('commits that touch nothing under src/ push without a SAP call', async () => {
    commit({ 'README.md': 'notes\n' });
    const before = vi.mocked(sys.adt.repository.readFile).mock.calls.length;
    expect((await push()).answer).toBe('ok refs/heads/main');
    expect(vi.mocked(sys.adt.repository.readFile).mock.calls.length).toBe(before);
  });

  it('refuses before any SAP call: deletes, moves, read-only files, force, another branch, unknown options', async () => {
    const reads = vi.mocked(sys.adt.repository.readFile).mock.calls.length;
    commit({ 'src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json': null });
    expect((await push()).answer).toBe("error refs/heads/main deletes aren't pushed (ADR-007; a move is a delete): src/zadtplus_a/zadtplus_a_sub/zi_b.ddls.json");
    world.git('reset', '-q', '--hard', REF);

    commit({ 'src/zadtplus_a/zde_a.dtelde.jsonc': '// mine\n' });
    expect((await push()).answer).toMatch(/^error refs\/heads\/main \.jsonc and \.properties files are never sent/);
    world.git('reset', '-q', '--hard', REF);

    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n' });
    expect((await push('+refs/heads/main:refs/heads/main')).answer).toMatch(/^error refs\/heads\/main force push refused/);
    expect((await push('refs/heads/main:refs/heads/dev')).answer).toBe('error refs/heads/dev the system has one branch, main; push to refs/heads/main');
    expect((await push(':refs/heads/main')).answer).toBe("error refs/heads/main main can't be deleted on the system");
    expect((await push(undefined, { pushOptions: ['history'] })).answer).toMatch(/unknown push option "history"/);
    expect(vi.mocked(sys.adt.repository.readFile).mock.calls.length).toBe(reads);
    expect(writes()).toBe(0);
  });

  it('refuses a commit that doesn\'t contain the fetched tip', async () => {
    world.git('checkout', '-q', '--orphan', 'other');
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\nENDCLASS.\n' });
    expect((await push('refs/heads/other:refs/heads/main')).answer).toBe('error refs/heads/main fetch first');
  });

  it('a conflict is an error with the counts; nothing of it written, the shadow back at its base', async () => {
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n' });
    sys.state.files[CLS_REMOTE] = 'CLASS zcl_a DEFINITION.\r\n  " theirs\r\nENDCLASS.\r\n';
    const tip = world.git('rev-parse', REF);
    const pushed = await push();
    expect(pushed.answer).toBe('error refs/heads/main 1 conflict');
    expect(pushed.warned).toEqual([expect.stringMatching(/^adtplus: conflict: CLAS ZCL_A: src\/zadtplus_a\/zcl_a\.clas\.abap changed on the system/)]);
    expect(sys.state.files[CLS_REMOTE]).toContain('theirs');
    expect(world.git('rev-parse', REF)).toBe(tip);
    expect(readFileSync(path.join(shadow(), CLS), 'utf8')).toBe('CLASS zcl_a DEFINITION.\nENDCLASS.\n');
    expect((await shadowStatus()).modified.count).toBe(0);
  });

  it('a written file whose read-back failed has no base: an error, and the shadow re-reads it', async () => {
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n' });
    let failed = false;
    sys.state.failRead = (p) => {
      if (p !== CLS_REMOTE || writes() === 0 || failed) return undefined;
      failed = true;
      return new Error('read-back broke');
    };
    const pushed = await push();
    expect(pushed.answer).toMatch(/^error refs\/heads\/main 1 failed; anything written comes back with the next fetch$/);
    expect(pushed.warned).toContain('adtplus: re-reading 1 file(s) the push left without a base');
    // The shadow holds what the system has now, with its base.
    expect(readFileSync(path.join(shadow(), CLS), 'utf8')).toBe('CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n');
    expect((await shadowStatus())).toMatchObject({ modified: { count: 0 }, readErrors: [] });
    // The re-read took the system as it is now, past the tip: the next push needs a fetch first.
    const again = await push();
    expect(again.answer).toBe('error refs/heads/main fetch first');
    expect(again.warned[0]).toMatch(/newer than refs\/adtplus\/origin\/heads\/main; fetch, rebase and push again/);
  });

  it("a fetch whose commit never reached git: the shadow is ahead of the tip, a push is refused until a fetch lands", async () => {
    // A colleague's change, read into the shadow by a fetch that git never took.
    sys.state.files[CLS_REMOTE] = 'CLASS zcl_a DEFINITION.\r\n  " theirs\r\nENDCLASS.\r\n';
    await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z', false);
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " mine\nENDCLASS.\n' });
    expect((await push()).answer).toBe('error refs/heads/main fetch first');
    expect(sys.state.files[CLS_REMOTE]).toContain('theirs');
    expect(writes()).toBe(0);

    await world.fetchInto(send, undefined, '2026-10-07T09:01:00Z');
    world.git('-c', 'user.name=Me', '-c', 'user.email=me@x', 'rebase', '-q', '-X', 'theirs', REF);
    expect((await push()).answer).toBe('ok refs/heads/main');
    expect(sys.state.files[CLS_REMOTE]).toContain('mine');
  });

  it('after an activation error a retry activates what the push wrote, also when nothing is left to write', async () => {
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n' });
    sys.state.activationErrors.set(CLS_REMOTE, { line: 1, message: 'ZIF_MISSING is unknown' });
    const failed = await push();
    expect(failed.answer).toBe('error refs/heads/main 1 not activated; anything written comes back with the next fetch');
    expect(failed.warned).toContain('adtplus: src/zadtplus_a/zcl_a.clas.abap:2: ZIF_MISSING is unknown');

    // The same commit again: nothing to write, the waiting object is activated.
    sys.state.activationErrors.clear();
    const retried = await push();
    expect(retried.answer).toBe('ok refs/heads/main');
    expect(retried.said.at(-1)).toMatch(/0 object\(s\) written, 0 created, 0 file\(s\), 1 activated/);
  });

  it('a fetch after an activation error, then a push with nothing under src/ changed, activates', async () => {
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n' });
    sys.state.activationErrors.set(CLS_REMOTE, { line: 1, message: 'ZIF_MISSING is unknown' });
    expect((await push()).answer).toMatch(/1 not activated/);
    sys.state.activationErrors.clear();
    await world.fetchInto(send, undefined, '2026-10-07T09:00:00Z');
    world.git('reset', '-q', '--hard', REF);
    const pushed = await push();
    expect(pushed.answer).toBe('ok refs/heads/main');
    expect(pushed.said.at(-1)).toMatch(/1 object\(s\) activated a push left inactive/);
  });

  it('a dry run plans without writing and leaves the shadow as it was', async () => {
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n', 'src/zadtplus_a/zcl_adtplus_new.clas.abap': 'CLASS zcl_adtplus_new DEFINITION.\nENDCLASS.\n' });
    const pushed = await push(undefined, { dryRun: true });
    // A new class without its .json can't be created: the dry run says so.
    expect(pushed.answer).toMatch(/^error refs\/heads\/main 1 cannot create$/);
    expect(writes()).toBe(0);
    expect((await shadowStatus())).toMatchObject({ modified: { count: 0 }, added: { count: 0 } });
  });

  it('creates a new object (with its .json) and takes what the system made of it', async () => {
    commit({
      'src/zadtplus_a/zcl_adtplus_new.clas.abap': 'CLASS zcl_adtplus_new DEFINITION PUBLIC.\nENDCLASS.\n\nCLASS zcl_adtplus_new IMPLEMENTATION.\nENDCLASS.\n',
      'src/zadtplus_a/zcl_adtplus_new.clas.json': '{\n  "formatVersion": "1",\n  "header": {"description": "New", "originalLanguage": "en"}\n}\n',
    });
    // The fake can't tell whether ZADTPLUS_A records changes, so a create needs a request.
    expect((await push()).answer).toMatch(/^error refs\/heads\/main 1 blocked/);
    const pushed = await push(undefined, { pushOptions: ['transport=DEVK900001'] });
    expect(pushed.answer).toBe('ok refs/heads/main');
    expect(pushed.said.at(-1)).toMatch(/1 created/);
    expect((await shadowStatus())).toMatchObject({ modified: { count: 0 }, added: { count: 0 } });
  });

  it('a new file of an existing object isn\'t sent: an error, and the shadow drops it', async () => {
    commit({ 'src/zadtplus_a/zcl_a.clas.testclasses.abap': '" tests\n' });
    const pushed = await push();
    expect(pushed.answer).toMatch(/^error refs\/heads\/main 1 not sent \(new file of an existing object/);
    expect((await shadowStatus()).added.count).toBe(0);
  });

  it('-o no-activate and -o transport reach the push', async () => {
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n' });
    const requests: DaemonRequest[] = [];
    const pushed = await push(undefined, { pushOptions: ['no-activate', 'transport=devk900001'] }, (req) => {
      requests.push(req);
      return send(req);
    });
    expect(pushed.answer).toBe('ok refs/heads/main');
    expect(requests).toEqual([expect.objectContaining({ cmd: 'mirror.push', activate: false, transport: 'DEVK900001', takeSystemVersion: true })]);
    expect(pushed.said.at(-1)).toMatch(/not activated \(-o no-activate\)/);
  });

  it('adtplus.transport from git config, upper-cased like -o transport=', async () => {
    world.git('config', 'adtplus.transport', 'devk914330');
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n' });
    const requests: DaemonRequest[] = [];
    await push(undefined, {}, (req) => {
      requests.push(req);
      return send(req);
    });
    expect(requests[0]).toMatchObject({ cmd: 'mirror.push', transport: 'DEVK914330' });
  });

  it('a throttled push says to push again, not to fetch', async () => {
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n' });
    const pushed = await push(undefined, {}, async () => ({ ok: false, error: 'rate limit', throttled: true, retryAfterMs: 30_000 }));
    expect(pushed.answer).toBe('error refs/heads/main rate limit (push again in 30 s)');
    expect((await shadowStatus()).modified.count).toBe(0);
  });

  it('a system without the opt-in: an error, the shadow back as it was', async () => {
    const { send: closed } = world.daemonWith(sys, { mirror: {} });
    commit({ [CLS]: 'CLASS zcl_a DEFINITION.\n  " x\nENDCLASS.\n' });
    const pushed = await push(undefined, {}, closed);
    expect(pushed.answer).toMatch(/^error refs\/heads\/main git remote not enabled for onprem/);
    expect((await shadowStatus()).modified.count).toBe(0);
  });
});
