import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination } from '../../src/core/destinations.js';
import { check } from '../../src/mirror/check.js';
import { msagChanges, parseMsag, renderMsag } from '../../src/mirror/msag.js';
import { newObject } from '../../src/mirror/new.js';
import { init, pull } from '../../src/mirror/pull.js';
import { push, type PushDeps } from '../../src/mirror/push.js';
import { status } from '../../src/mirror/status.js';
import { PACKAGE, fakeDeps, fakeSystem } from './fake.js';
import { fakeMessageClasses } from './fake-msag.js';

let ws: string;
let root: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-msag-')));
  root = path.join(ws, 'mirror');
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const destination: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: [{ package: 'ZADTPLUS_A', subpackages: true }],
};
const loc = () => ({ root, workspaceFolders: [ws], system: 'onprem' });
const file = (rel: string) => path.join(root, ...rel.split('/'));
const read = (rel: string) => readFileSync(file(rel), 'utf8');
const write = (rel: string, text: string) => writeFileSync(file(rel), text);
const manifest = () => JSON.parse(read('.adtplus/mirror.json'));

const MSAG = 'src/zadtplus_a/zadtplus_msg.msag.json';
const STUB = 'ZADTPLUS_A/Message Classes/ZADTPLUS_MSG/zadtplus_msg.msagn.jsonc';
const json = (o: { description?: string; language?: string; messages: Array<[string, string]> }) =>
  `${JSON.stringify(
    {
      formatVersion: '1',
      header: { description: o.description ?? 'Demo', originalLanguage: o.language ?? 'en' },
      messages: o.messages.map(([number, text]) => ({ number, text })),
    },
    null,
    2,
  )}\n`;

async function mirrored(o: { logon?: string; master?: string; translations?: Record<string, Record<string, string>> } = {}) {
  const sys = fakeSystem({ ...PACKAGE, [STUB]: '// stub\n{}' });
  const mc = fakeMessageClasses({ logon: o.logon });
  mc.add('ZADTPLUS_MSG', { description: 'Demo', master: o.master, messages: { '001': 'Order &1 saved', '002': 'Not found' }, translations: o.translations });
  const { deps: base, held } = fakeDeps(sys.adt);
  const mirrorDeps = { ...base, withRest: mc.withRest };
  await init(mirrorDeps, {}, { ...loc(), package: 'zadtplus_a' });
  const pulled = await pull(mirrorDeps, {}, loc());
  const log: string[] = [];
  const deps: PushDeps = {
    ...mirrorDeps,
    destination,
    logWrite: (cmd, params, error) => log.push(`${cmd} ${String(params.file ?? '')}${error ? ` ! ${error}` : ''}`),
  };
  return { sys, mc, deps, held, log, pulled };
}

const puts = (mc: ReturnType<typeof fakeMessageClasses>) => mc.state.calls.filter((c) => c.method === 'PUT');

describe('msag files', () => {
  it('renders AFF msag-v1 and reads it back', () => {
    const text = renderMsag({ description: 'Demo', masterLanguage: 'DE', messages: [{ number: '002', text: 'b', selfExplanatory: true }, { number: '001', text: 'a', selfExplanatory: false }] });
    expect(text).toBe(json({ language: 'de', messages: [['001', 'a'], ['002', 'b']] }));
    expect(parseMsag(text)).toEqual({ description: 'Demo', originalLanguage: 'DE', messages: [{ number: '001', text: 'a' }, { number: '002', text: 'b' }] });
  });

  it('refuses what SAP would store differently or not at all', () => {
    expect(parseMsag(json({ messages: [['001', 'x'.repeat(74)]] }))).toMatch(/74 characters, SAP takes at most 73/);
    expect(parseMsag(json({ messages: [['001', 'ä'.repeat(73)]] }))).not.toBeTypeOf('string');
    expect(parseMsag(json({ messages: [['001', 'a'], ['001', 'b']] }))).toMatch(/001 is in the file twice/);
    expect(parseMsag(json({ messages: [['1', 'a']] }))).toMatch(/three digits/);
    expect(parseMsag(json({ messages: [['001', 'a\nb']] }))).toMatch(/line break/);
    expect(parseMsag(json({ description: 'd'.repeat(61), messages: [] }))).toMatch(/61 characters/);
    const flagged = JSON.parse(json({ messages: [['001', 'a']] }));
    flagged.messages[0].selfExplanatory = true;
    expect(parseMsag(JSON.stringify(flagged))).toMatch(/"selfExplanatory", which msag-v1 doesn't know/);
  });

  it('sends only what changed, and names what the file left out', () => {
    const current = { description: 'Demo', messages: [{ number: '001', text: 'a', selfExplanatory: false }, { number: '002', text: 'b', selfExplanatory: false }] };
    expect(msagChanges(current, { description: 'Demo', originalLanguage: 'EN', messages: [{ number: '001', text: 'a  ' }, { number: '003', text: 'c' }] })).toEqual({
      messages: [{ number: '003', text: 'c' }],
      removed: ['002'],
    });
  });
});

describe('mirror pull of message classes', () => {
  it("writes a writable .msag.json in the master language instead of adt-ls's stub", async () => {
    const { pulled } = await mirrored({ logon: 'EN', master: 'DE', translations: { EN: { '001': 'Order saved (EN)' } } });
    expect(read(MSAG)).toBe(json({ language: 'de', messages: [['001', 'Order &1 saved'], ['002', 'Not found']] }));
    expect(statSync(file(MSAG)).mode & 0o222).not.toBe(0);
    expect(existsSync(file('src/zadtplus_a/zadtplus_msg.msagn.jsonc'))).toBe(false);
    expect(manifest().objects['MSAG ZADTPLUS_MSG']).toMatchObject({ package: 'ZADTPLUS_A', files: { 'zadtplus_msg.msag.json': { hash: expect.any(String) } } });
    expect(manifest().objects['MSAGN ZADTPLUS_MSG']).toBeUndefined();
    expect(pulled.errors).toEqual([]);
  });

  it("drops an older pull's stub once the .msag.json replaces it", async () => {
    const sys = fakeSystem({ ...PACKAGE, [STUB]: '// stub\n{}' });
    const mc = fakeMessageClasses();
    mc.add('ZADTPLUS_MSG', { messages: { '001': 'a' } });
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'zadtplus_a' });
    await pull(deps, {}, loc());
    expect(existsSync(file('src/zadtplus_a/zadtplus_msg.msagn.jsonc'))).toBe(true);
    // A pull of named objects (the git helper's fetch) can't replace the stub: it asks for a full one.
    expect((await pull({ ...deps, withRest: mc.withRest }, {}, { ...loc(), objects: ['CLAS ZCL_A'] })).fallback).toMatch(/\.msag\.json now/);
    const result = await pull({ ...deps, withRest: mc.withRest }, {}, loc());
    expect(existsSync(file('src/zadtplus_a/zadtplus_msg.msagn.jsonc'))).toBe(false);
    expect(result.deleted.paths).toEqual(['src/zadtplus_a/zadtplus_msg.msagn.jsonc']);
    expect(result.notListed.count).toBe(0);
    expect(Object.keys(manifest().objects)).toContain('MSAG ZADTPLUS_MSG');
    expect(Object.keys(manifest().objects)).not.toContain('MSAGN ZADTPLUS_MSG');
  });

  it('asks for no full pull for a stub kept next to its .msag.json', async () => {
    const sys = fakeSystem({ ...PACKAGE, [STUB]: '// stub\n{}' });
    const mc = fakeMessageClasses();
    mc.add('ZADTPLUS_MSG', { messages: { '001': 'a' } });
    const { deps } = fakeDeps(sys.adt);
    await init(deps, {}, { ...loc(), package: 'zadtplus_a' });
    await pull(deps, {}, loc());
    const stub = file('src/zadtplus_a/zadtplus_msg.msagn.jsonc');
    chmodSync(stub, 0o644);
    writeFileSync(stub, '// edited\n');
    await pull({ ...deps, withRest: mc.withRest }, {}, loc());
    expect(Object.keys(manifest().objects)).toEqual(expect.arrayContaining(['MSAG ZADTPLUS_MSG', 'MSAGN ZADTPLUS_MSG']));
    expect((await pull({ ...deps, withRest: mc.withRest }, {}, { ...loc(), objects: ['CLAS ZCL_A'] })).fallback).toBeUndefined();
  });

  it('takes a system change and keeps a local one under the re-pull rule', async () => {
    const { deps, mc } = await mirrored();
    mc.state.classes.get('ZADTPLUS_MSG')!.messages.get('002')!.set('EN', 'Gone');
    expect((await pull(deps, {}, loc())).written.paths).toEqual([MSAG]);
    expect(read(MSAG)).toContain('"Gone"');
    write(MSAG, read(MSAG).replace('Gone', 'Mine'));
    mc.state.classes.get('ZADTPLUS_MSG')!.messages.get('001')!.set('EN', 'Theirs');
    const again = await pull(deps, {}, loc());
    expect(again.conflicts.paths).toEqual([MSAG]);
    expect(read(`${MSAG}.remote`)).toContain('"Theirs"');
  });

  it('re-reads a named message class over REST, and falls back when it moved or is gone', async () => {
    const { deps, mc, sys } = await mirrored();
    mc.state.classes.get('ZADTPLUS_MSG')!.messages.get('002')!.set('EN', 'Changed');
    const named = await pull(deps, {}, { ...loc(), objects: ['MSAG ZADTPLUS_MSG'] });
    expect(named).toMatchObject({ objects: 1, written: { paths: [MSAG] } });
    expect(named.fallback).toBeUndefined();
    expect(vi.mocked(sys.adt.lifecycle.resolveAffUri)).not.toHaveBeenCalledWith(expect.objectContaining({ objectType: 'MSAG' }));
    mc.state.classes.get('ZADTPLUS_MSG')!.package = 'ZADTPLUS_OTHER';
    expect((await pull(deps, {}, { ...loc(), objects: ['MSAG ZADTPLUS_MSG'] })).fallback).toMatch(/package ZADTPLUS_OTHER on the system, ZADTPLUS_A in the mirror/);
    mc.state.classes.delete('ZADTPLUS_MSG');
    expect((await pull(deps, {}, { ...loc(), objects: ['MSAG ZADTPLUS_MSG'] })).fallback).toMatch(/not found on the system/);
  });

  it('deletes a message class gone from the listing and from the system', async () => {
    const { deps, mc, sys } = await mirrored();
    delete sys.state.files[STUB];
    mc.state.classes.delete('ZADTPLUS_MSG');
    const result = await pull(deps, {}, loc());
    expect(result.deleted.paths).toEqual([MSAG]);
    expect(manifest().objects['MSAG ZADTPLUS_MSG']).toBeUndefined();
  });
});

describe('mirror push of message classes', () => {
  it('writes changed and new messages over REST, without activation', async () => {
    const { deps, mc, log, sys } = await mirrored();
    write(MSAG, json({ messages: [['001', 'Order &1 saved'], ['002', 'Not found: &1'], ['003', 'New one']] }));
    expect((await status(loc())).modified.paths).toEqual([MSAG]);
    const result = await push(deps, {}, loc());
    expect(result).toMatchObject({ complete: true, pushed: { paths: ['MSAG ZADTPLUS_MSG'] }, written: { paths: [MSAG] }, unactivated: { count: 0 } });
    expect(result.activation).toBeUndefined();
    expect(vi.mocked(sys.adt.lifecycle.update)).not.toHaveBeenCalled();
    expect(mc.texts('ZADTPLUS_MSG')).toEqual({ '001': 'Order &1 saved', '002': 'Not found: &1', '003': 'New one' });
    // Only the changed and the new message are sent: the PUT is an upsert.
    expect(puts(mc)).toHaveLength(1);
    expect(log).toEqual(['object.update zadtplus_msg.msag.json']);
    expect((await status(loc())).modified.count).toBe(0);
    expect(manifest().objects['MSAG ZADTPLUS_MSG'].unactivated).toBeUndefined();
  });

  it('writes in the master language and keeps translations out', async () => {
    const { deps, mc } = await mirrored({ logon: 'EN', master: 'DE', translations: { EN: { '001': 'Order saved (EN)' } } });
    write(MSAG, read(MSAG).replace('Not found', 'Nicht gefunden'));
    expect((await push(deps, {}, loc())).complete).toBe(true);
    expect(mc.texts('ZADTPLUS_MSG')['002']).toBe('Nicht gefunden');
    expect(mc.state.classes.get('ZADTPLUS_MSG')!.messages.get('001')!.get('EN')).toBe('Order saved (EN)');
  });

  it('is a conflict when the system changed since the pull, and writes nothing', async () => {
    const { deps, mc } = await mirrored();
    mc.state.classes.get('ZADTPLUS_MSG')!.messages.get('001')!.set('EN', 'Theirs');
    write(MSAG, read(MSAG).replace('Not found', 'Mine'));
    const result = await push(deps, {}, loc());
    expect(result.conflicts).toEqual([{ object: 'MSAG ZADTPLUS_MSG', message: `${MSAG} changed on the system since the last pull or push` }]);
    expect(puts(mc)).toHaveLength(0);
    expect(result.complete).toBe(false);
  });

  it('reports a removed message without deleting it, and keeps the local file', async () => {
    const { deps, mc } = await mirrored();
    write(MSAG, json({ messages: [['001', 'Order &1 saved again']] }));
    const result = await push(deps, {}, loc());
    expect(result.leftOut).toEqual([{ object: 'MSAG ZADTPLUS_MSG', message: expect.stringMatching(/message 002 not in the file, not deleted/) }]);
    expect(result.complete).toBe(false);
    expect(result.pushed.count).toBe(0);
    expect(mc.texts('ZADTPLUS_MSG')).toEqual({ '001': 'Order &1 saved again', '002': 'Not found' });
    expect(read(MSAG)).not.toContain('002');
    // The git helper's shadow takes the system's state instead.
    write(MSAG, json({ messages: [['001', 'Order &1 saved again, twice']] }));
    const shadow = await push(deps, {}, { ...loc(), takeSystemVersion: true });
    expect(shadow.rewritten.paths).toEqual([MSAG]);
    expect(read(MSAG)).toContain('"002"');
  });

  it("leaves a changed description out: SAP records it wrong", async () => {
    const { deps, mc } = await mirrored();
    write(MSAG, json({ description: 'Demo messages', messages: [['001', 'Order &1 saved'], ['002', 'Not found: &1']] }));
    const result = await push(deps, {}, loc());
    expect(result.leftOut).toEqual([{ object: 'MSAG ZADTPLUS_MSG', message: expect.stringMatching(/the description isn't sent: changing the description is refused/) }]);
    expect(result.complete).toBe(false);
    expect(mc.state.classes.get('ZADTPLUS_MSG')!.description).toBe('Demo');
    expect(mc.texts('ZADTPLUS_MSG')['002']).toBe('Not found: &1');
    expect(read(MSAG)).toContain('Demo messages');
  });

  it('drops the base when a failed write may have gone through, so the next push asks for a pull', async () => {
    const { deps, mc } = await mirrored();
    mc.state.failAfterPut = 'internal server error';
    write(MSAG, read(MSAG).replace('Not found', 'Mine'));
    const result = await push(deps, {}, loc());
    expect(result.failed).toEqual([{ object: 'MSAG ZADTPLUS_MSG', message: expect.stringMatching(/internal server error/) }]);
    expect(manifest().objects['MSAG ZADTPLUS_MSG'].files['zadtplus_msg.msag.json']).toMatchObject({ error: expect.stringMatching(/may have changed/) });
    expect(manifest().objects['MSAG ZADTPLUS_MSG'].files['zadtplus_msg.msag.json'].hash).toBeUndefined();
    mc.state.failAfterPut = undefined;
    const again = await push(deps, {}, loc());
    expect(again.conflicts).toEqual([]);
    expect(again.failed[0]!.message).toMatch(/no base to compare with/);
  });

  it('refuses a file push could not send as written, before any SAP write', async () => {
    const { deps, mc } = await mirrored();
    write(MSAG, json({ messages: [['001', 'x'.repeat(74)], ['002', 'Not found']] }));
    const result = await push(deps, {}, loc());
    expect(result.failed).toEqual([{ object: 'MSAG ZADTPLUS_MSG', message: expect.stringMatching(/74 characters.*nothing sent/) }]);
    write(MSAG, json({ language: 'de', messages: [['001', 'Order &1 saved'], ['002', 'x']] }));
    expect((await push(deps, {}, loc())).failed[0]!.message).toMatch(/originalLanguage is de, the class's is en/);
    expect(puts(mc)).toHaveLength(0);
  });

  it('is refused outside the allowlist, on the package the system names', async () => {
    const { deps, mc } = await mirrored();
    mc.state.classes.get('ZADTPLUS_MSG')!.package = 'ZADTPLUS_A';
    write(MSAG, read(MSAG).replace('Not found', 'Mine'));
    const result = await push({ ...deps, destination: { ...destination, writeAllowlist: ['ZOTHER'] } }, {}, loc());
    expect(result.refused).toEqual([{ object: 'MSAG ZADTPLUS_MSG', message: expect.stringMatching(/ZADTPLUS_A/) }]);
    expect(puts(mc)).toHaveLength(0);
  });

  it('needs a request where the package records changes and the lock names none', async () => {
    const { deps, mc } = await mirrored();
    mc.state.recording.add('ZADTPLUS_A');
    mc.state.request = '';
    write(MSAG, read(MSAG).replace('Not found', 'Mine'));
    const result = await push(deps, {}, loc());
    expect(result.blocked).toEqual([{ object: 'MSAG ZADTPLUS_MSG', message: expect.stringMatching(/records changes.*transport/) }]);
    expect(puts(mc)).toHaveLength(0);
    expect((await push(deps, {}, { ...loc(), transport: 'DEVK900002' })).complete).toBe(true);
    expect(mc.state.calls.find((c) => c.method === 'PUT')!.query).toMatchObject({ corrNr: 'DEVK900002' });
  });

  it("is refused before any write when ADTPLUS_DENY names object.update", async () => {
    const { deps, mc } = await mirrored();
    write(MSAG, read(MSAG).replace('Not found', 'Mine'));
    const refusal = (cmd: string) => (cmd === 'object.update' ? 'denied' : undefined);
    await expect(push({ ...deps, refusal }, {}, loc())).rejects.toThrow(/refused before any write: denied/);
    expect(puts(mc)).toHaveLength(0);
    // A push without a message class isn't asked.
    write(MSAG, read(MSAG).replace('Mine', 'Not found'));
    await expect(push({ ...deps, refusal }, {}, loc())).resolves.toMatchObject({ complete: true });
  });

  it('creates a new message class with its messages', async () => {
    const { deps, mc, log } = await mirrored();
    write('src/zadtplus_a/zadtplus_new.msag.json', json({ description: 'New', messages: [['001', 'First']] }));
    const dry = await push(deps, {}, { ...loc(), dryRun: true });
    expect(dry.toCreate.paths).toEqual(['MSAG ZADTPLUS_NEW']);
    const result = await push(deps, {}, { ...loc(), transport: 'DEVK900002' });
    expect(result).toMatchObject({ complete: true, created: { paths: ['MSAG ZADTPLUS_NEW'] }, pushed: { paths: ['MSAG ZADTPLUS_NEW'] } });
    expect(mc.state.classes.get('ZADTPLUS_NEW')).toMatchObject({ description: 'New', package: 'ZADTPLUS_A', master: 'EN' });
    expect(mc.texts('ZADTPLUS_NEW')).toEqual({ '001': 'First' });
    expect(log).toEqual(['object.create ', 'object.update zadtplus_new.msag.json']);
    expect(manifest().objects['MSAG ZADTPLUS_NEW']).toMatchObject({ package: 'ZADTPLUS_A', dir: 'src/zadtplus_a' });
    expect((await status(loc())).added.count).toBe(0);
  });

  it("can't create one in another language than the logon language", async () => {
    const { deps } = await mirrored();
    write('src/zadtplus_a/zadtplus_new.msag.json', json({ language: 'de', messages: [] }));
    const result = await push(deps, {}, { ...loc(), dryRun: true });
    expect(result.cannotCreate).toEqual([{ object: 'MSAG ZADTPLUS_NEW (src/zadtplus_a)', message: expect.stringMatching(/created in the logon language, en/) }]);
  });
});

describe('mirror check and new for message classes', () => {
  it('flags what the schema allows and push refuses', async () => {
    await mirrored();
    write(MSAG, json({ messages: [['001', 'a'], ['001', 'b']] }));
    const result = await check({ ...loc(), languageVersion: 'standard' });
    expect(result.findings).toContainEqual(expect.objectContaining({ path: MSAG, rule: 'msag_file', severity: 'error' }));
    expect(result.noSchema).toEqual({});
  });

  it('writes a skeleton in the logon language that push creates', async () => {
    await mirrored();
    const made = await newObject({}, { ...loc(), type: 'MSAG', name: 'zadtplus_new', description: 'New', language: 'DE', languageVersion: 'cloudDevelopment' });
    expect(made.files).toEqual(['src/zadtplus_a/zadtplus_new.msag.json']);
    expect(JSON.parse(read('src/zadtplus_a/zadtplus_new.msag.json'))).toEqual({ formatVersion: '1', header: { description: 'New', originalLanguage: 'de' }, messages: [] });
    const checked = await check({ ...loc(), languageVersion: 'cloudDevelopment' });
    expect(checked.findings.filter((f) => f.path === 'src/zadtplus_a/zadtplus_new.msag.json')).toEqual([]);
  });
});
