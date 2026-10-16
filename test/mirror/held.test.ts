import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mirrorReadNote, mirrorRefusal } from '../../src/mirror/held.js';
import { MANIFEST_PATH, saveManifest } from '../../src/mirror/manifest.js';

const HASH = 'a'.repeat(64);

let ws: string;
let root: string;
beforeEach(async () => {
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-held-')));
  root = path.join(ws, 'm');
  await saveManifest(root, {
    version: 1,
    system: 'onprem',
    packages: [{ name: 'ZADTPLUS_A', subpackages: true }],
    objects: {
      'FUGR ZFG': {
        package: 'ZADTPLUS_A',
        dir: 'src/zadtplus_a',
        files: {
          'zfg.fugr.json': { hash: HASH },
          'zfg.fugr.z_my_fm.func.abap': { hash: HASH },
          'zfg.fugr.z_my_fm.func.json': { hash: HASH },
          'zfg.fugr.lzfgtop.reps.abap': { hash: HASH },
          'zfg.fugr.texts.en.properties': { hash: HASH, readOnly: true },
        },
      },
    },
  });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const refusal = (ref: { name: string; objectType: string }) =>
  mirrorRefusal({ system: 'onprem', ref, mirrorRoots: [root], workspaceFolders: [ws] });

describe('mirrorRefusal on function groups (ADR-009)', () => {
  it('finds a function module in its group, naming only its files', async () => {
    const res = await refusal({ name: 'Z_MY_FM', objectType: 'FUGR/FF' });
    expect(res).toContain('FUGR ZFG is mirrored at');
    expect(res).toContain('src/zadtplus_a/zfg.fugr.z_my_fm.func.abap, src/zadtplus_a/zfg.fugr.z_my_fm.func.json');
    expect(res).not.toContain('lzfgtop');
  });

  it('finds a function group include in its group', async () => {
    expect(await refusal({ name: 'LZFGTOP', objectType: 'FUGR/I' })).toContain('src/zadtplus_a/zfg.fugr.lzfgtop.reps.abap');
  });

  it('finds the group itself by its name', async () => {
    expect(await refusal({ name: 'ZFG', objectType: 'FUGR/F' })).toContain('FUGR ZFG is mirrored at');
  });

  it('lets a function module of another group through', async () => {
    expect(await refusal({ name: 'Z_OTHER_FM', objectType: 'FUGR/FF' })).toBeUndefined();
  });
});

describe('mirrorReadNote', () => {
  it('names the mirror and the files that may be newer, and nothing for an object it does not hold', async () => {
    const note = await mirrorReadNote({ system: 'onprem', ref: { name: 'Z_MY_FM', objectType: 'FUGR/FF' }, mirrorRoots: [root], workspaceFolders: [ws] });
    expect(note).toMatch(/^FUGR ZFG is mirrored at .*src\/zadtplus_a\/zfg\.fugr\.z_my_fm\.func\.abap.* may hold newer, unpushed changes$/);
    expect(await mirrorReadNote({ system: 'onprem', ref: { name: 'ZCL_X', objectType: 'CLAS/OC' }, mirrorRoots: [root], workspaceFolders: [ws] })).toBeUndefined();
    expect(await mirrorReadNote({ system: 'cloud-erp', ref: { name: 'ZFG', objectType: 'FUGR/F' }, mirrorRoots: [root], workspaceFolders: [ws] })).toBeUndefined();
  });

  it('passes over a mirror whose manifest does not parse and finds the next one', async () => {
    const broken = path.join(ws, 'broken');
    mkdirSync(path.dirname(path.join(broken, MANIFEST_PATH)), { recursive: true });
    writeFileSync(path.join(broken, MANIFEST_PATH), '{ not json');
    const ref = { name: 'ZFG', objectType: 'FUGR/F' };
    expect(await mirrorReadNote({ system: 'onprem', ref, mirrorRoots: [broken, root], workspaceFolders: [ws] })).toMatch(/^FUGR ZFG is mirrored at/);
    // The write refusal still stops at it.
    expect(await mirrorRefusal({ system: 'onprem', ref, mirrorRoots: [broken, root], workspaceFolders: [ws] })).toMatch(/doesn't parse/);
  });
});
