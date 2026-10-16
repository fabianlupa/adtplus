import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check } from '../../src/mirror/check.js';
import { emptyManifest, saveManifest, type Manifest } from '../../src/mirror/manifest.js';
import { NEW_TYPES, newObject, poolName } from '../../src/mirror/new.js';
import { status } from '../../src/mirror/status.js';

let ws: string;
let root: string;
const MANIFEST: Manifest = {
  ...emptyManifest('onprem'),
  packages: [{ name: 'ZADTPLUS_A', subpackages: true }],
  objects: {
    'CLAS ZCL_OLD': { package: 'ZADTPLUS_A_SUB', dir: 'src/zadtplus_a/zadtplus_a_sub', files: { 'zcl_old.clas.abap': { hash: 'a'.repeat(64) } } },
  },
};
beforeEach(async () => {
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-new-')));
  root = path.join(ws, 'mirror');
  mkdirSync(root);
  await saveManifest(root, MANIFEST);
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const loc = () => ({ root, workspaceFolders: [ws], system: 'onprem' });
const read = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const NAMES: Record<string, string> = { TABL: 'ZADTPLUS_NEW', BDEF: 'ZR_TRAVEL' };
const nameFor = (type: string) => NAMES[type] ?? `ZADTPLUS_${type}_NEW`;

describe('mirror new', () => {
  for (const languageVersion of ['standard', 'cloudDevelopment'] as const) {
    it(`writes skeletons that pass check without errors (${languageVersion})`, async () => {
      for (const type of NEW_TYPES) {
        if (type === 'PROG' && languageVersion === 'cloudDevelopment') continue;
        await newObject({}, { ...loc(), type, name: nameFor(type), description: `It's ${type}`, languageVersion: languageVersion === 'cloudDevelopment' ? languageVersion : undefined });
      }
      const result = await check({ ...loc(), languageVersion });
      expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
      expect(result.noSchema).toEqual({});
    });
  }

  it('writes LF with a final newline, the header as adt-ls serves it, and nothing into the manifest', async () => {
    const before = read('.adtplus/mirror.json');
    const result = await newObject({}, { ...loc(), type: 'clas', name: 'zcl_adtplus_new', languageVersion: 'cloudDevelopment' });
    expect(result).toEqual({
      root,
      object: 'CLAS ZCL_ADTPLUS_NEW',
      package: 'ZADTPLUS_A',
      files: ['src/zadtplus_a/zcl_adtplus_new.clas.abap', 'src/zadtplus_a/zcl_adtplus_new.clas.json'],
      notes: [expect.stringContaining('behaviorClass')],
    });
    expect(read('src/zadtplus_a/zcl_adtplus_new.clas.json')).toBe(`{
  "formatVersion": "1",
  "header": {
    "description": "ZCL_ADTPLUS_NEW",
    "originalLanguage": "en",
    "abapLanguageVersion": "cloudDevelopment"
  },
  "fixPointArithmetic": true
}
`);
    const source = read('src/zadtplus_a/zcl_adtplus_new.clas.abap');
    expect(source).toMatch(/^CLASS zcl_adtplus_new DEFINITION\n/);
    expect(source).not.toContain('\r');
    expect(source.endsWith('ENDCLASS.\n')).toBe(true);
    expect(statSync(path.join(root, 'src/zadtplus_a/zcl_adtplus_new.clas.abap')).mode & 0o222).not.toBe(0);
    expect(read('.adtplus/mirror.json')).toBe(before);
    const s = await status(loc());
    expect(s.added.paths).toEqual(['src/zadtplus_a/zcl_adtplus_new.clas.abap', 'src/zadtplus_a/zcl_adtplus_new.clas.json']);
  });

  it('leaves the language version out on an on-premise system (the package default applies)', async () => {
    await newObject({}, { ...loc(), type: 'INTF', name: 'ZIF_ADTPLUS_NEW' });
    expect(JSON.parse(read('src/zadtplus_a/zif_adtplus_new.intf.json')).header).toEqual({ description: 'ZIF_ADTPLUS_NEW', originalLanguage: 'en' });
  });

  it('names a BDEF after its root entity and points at the usual pool', async () => {
    const result = await newObject({}, { ...loc(), type: 'BDEF', name: 'ZR_TRAVEL' });
    expect(result.files).toEqual(['src/zadtplus_a/zr_travel.bdef.abdl', 'src/zadtplus_a/zr_travel.bdef.json']);
    expect(read('src/zadtplus_a/zr_travel.bdef.abdl')).toMatch(/^managed implementation in class zbp_r_travel unique;\n[\s\S]*define behavior for ZR_TRAVEL\n/);
    expect(result.notes.join(' ')).toMatch(/root entity/);
    expect(poolName('ZR_TRAVEL')).toBe('ZBP_R_TRAVEL');
    expect(poolName('ZI_X')).toBe('ZBP_I_X');
    expect(poolName('/DMO/R_TRAVEL')).toBe('/DMO/BP_R_TRAVEL');
  });

  it('writes a binding as .json only, and namespaced names as (ns)name', async () => {
    const srvb = await newObject({ namespaces: ['/NSPC/'] }, { ...loc(), type: 'SRVB', name: '/NSPC/UI_X_O4' });
    expect(srvb.files).toEqual(['src/zadtplus_a/(nspc)ui_x_o4.srvb.json']);
    expect(JSON.parse(read('src/zadtplus_a/(nspc)ui_x_o4.srvb.json'))).toMatchObject({ bindingType: 'ODATA V4', bindingTypeCategory: 'ui' });
  });

  it("puts the object into a subpackage's folder taken from the manifest", async () => {
    const result = await newObject({}, { ...loc(), type: 'DDLS', name: 'ZI_ADTPLUS_NEW', package: 'zadtplus_a_sub' });
    expect(result).toMatchObject({ package: 'ZADTPLUS_A_SUB', files: ['src/zadtplus_a/zadtplus_a_sub/zi_adtplus_new.ddls.acds', 'src/zadtplus_a/zadtplus_a_sub/zi_adtplus_new.ddls.json'] });
  });

  it('refuses what it should not write', async () => {
    const refused = (extra: Partial<Parameters<typeof newObject>[1]>, policy = {}) =>
      newObject(policy, { ...loc(), type: 'CLAS', name: 'ZCL_ADTPLUS_X', ...extra });
    await expect(refused({ type: 'DTEL' })).rejects.toThrow(/can't make a DTEL; it makes CLAS, INTF/);
    await expect(refused({ name: 'CL_X' })).rejects.toThrow(/not a customer name/);
    await expect(refused({ name: '/NSPC/CL_X' })).rejects.toThrow(/not a customer name/);
    await expect(refused({ name: 'ZCL X' })).rejects.toThrow(/not an ABAP object name/);
    await expect(refused({ name: '../ZCL' })).rejects.toThrow(/not an ABAP object name/);
    await expect(refused({ name: 'Z'.repeat(31) })).rejects.toThrow(/at most 30 characters/);
    await expect(refused({ type: 'TABL', name: 'ZADTPLUS_TOO_LONG_NAME' })).rejects.toThrow(/at most 16/);
    await expect(refused({ description: 'd'.repeat(61) })).rejects.toThrow(/at most 60/);
    await expect(refused({ type: 'PROG', name: 'ZADTPLUS_P', languageVersion: 'cloudDevelopment' })).rejects.toThrow(/no programs/);
    await expect(refused({ package: 'ZADTPLUS_OTHER' })).rejects.toThrow(/package ZADTPLUS_OTHER isn't in this mirror/);
    await expect(refused({ name: 'ZCL_OLD' })).rejects.toThrow(/CLAS ZCL_OLD is already in the mirror/);
    await expect(refused({ system: 'cloud-erp' })).rejects.toThrow(/mirrors system "onprem"/);
    mkdirSync(path.join(root, 'src', 'zadtplus_a', 'elsewhere'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'zadtplus_a', 'elsewhere', 'zcl_adtplus_x.clas.abap'), 'x');
    await expect(refused({})).rejects.toThrow(/already has files in the mirror: src\/zadtplus_a\/elsewhere\/zcl_adtplus_x.clas.abap/);
  });

  it('wants --package when the mirror has several root packages', async () => {
    await saveManifest(root, { ...MANIFEST, packages: [...MANIFEST.packages, { name: 'ZADTPLUS_B', subpackages: true }] });
    await expect(newObject({}, { ...loc(), type: 'CLAS', name: 'ZCL_ADTPLUS_X' })).rejects.toThrow(/pass --package/);
    const result = await newObject({}, { ...loc(), type: 'CLAS', name: 'ZCL_ADTPLUS_X', package: 'ZADTPLUS_B' });
    expect(result.files[0]).toBe('src/zadtplus_b/zcl_adtplus_x.clas.abap');
  });
});
