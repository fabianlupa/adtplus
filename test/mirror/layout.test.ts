import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  abapName,
  affClassFileFor,
  affName,
  affType,
  isMirrorablePackage,
  isReadOnlyFile,
  isSafeRelativePath,
  packageFolder,
  resolveRoot,
  safeTarget,
} from '../../src/mirror/layout.js';

describe('names', () => {
  it('maps namespaces both ways as adt-ls does', () => {
    expect(affName('/DMO/AGENCY')).toBe('(DMO)AGENCY');
    expect(affName('ZCL_X')).toBe('ZCL_X');
    expect(abapName('(DMO)AGENCY')).toBe('/DMO/AGENCY');
    expect(abapName('ZCL_X')).toBe('ZCL_X');
    expect(abapName('ZUI_RAP_TRAVEL_O2_VAN           0001')).toBe('ZUI_RAP_TRAVEL_O2_VAN           0001');
  });

  it('names package folders in lower case, namespaces as (ns)name', () => {
    expect(packageFolder('ZADTPLUS_OPENSAP_RAP')).toBe('zadtplus_opensap_rap');
    expect(packageFolder('/DMO/BRF_RFC_TEST')).toBe('(dmo)brf_rfc_test');
    expect(packageFolder('$TMP')).toBe('$tmp');
  });

  it('takes the type from the segment after the object name', () => {
    expect(affType('ZCL_X', ['zcl_x.clas.json', 'zcl_x.clas.abap', 'zcl_x.clas.testclasses.abap'])).toBe('CLAS');
    expect(affType('ZOSTATFL', ['zostatfl.dtelde.jsonc'])).toBe('DTELDE');
    expect(affType('(DMO)AGENCY', ['(dmo)agency.tabl.ddic', '(dmo)agency.tabl.json'])).toBe('TABL');
    expect(affType('ZADTPLUS_MATH_UTILS', ['zadtplus_math_utils.fugr.saplzadtplus_math_utils.reps.abap', 'zadtplus_math_utils.fugr.json'])).toBe('FUGR');
    expect(affType('ZUI_X_VAN        0001', ['zui_x_van        0001.iwvb.jsonc'])).toBe('IWVB');
    expect(affType('ZOTHER', ['zx.bdef.abdl'])).toBe('BDEF');
    expect(affType('ZOTHER', [])).toBeUndefined();
  });

  it('marks stubs and texts read-only', () => {
    expect(isReadOnlyFile('zostatfl.dtelde.jsonc')).toBe(true);
    expect(isReadOnlyFile('zcl_x.clas.texts.en.properties')).toBe(true);
    expect(isReadOnlyFile('zcl_x.clas.json')).toBe(false);
    expect(isReadOnlyFile('zcl_x.clas.abap')).toBe(false);
  });

  it("names AFF's file for abapGit's class include names", () => {
    expect(affClassFileFor('zbp_x.clas.locals_imp.abap')).toBe('zbp_x.clas.implementations.abap');
    expect(affClassFileFor('zcl_x.clas.locals_def.abap')).toBe('zcl_x.clas.definitions.abap');
    expect(affClassFileFor('zcl_x.clas.testclasses.abap')).toBeUndefined();
    expect(affClassFileFor('zcl_x.clas.implementations.abap')).toBeUndefined();
  });
});

describe('isMirrorablePackage', () => {
  it('takes Z, Y, $ and listed namespaces only', () => {
    expect(isMirrorablePackage('ZADTPLUS_X')).toBe(true);
    expect(isMirrorablePackage('yfl_x')).toBe(true);
    expect(isMirrorablePackage('$TMP')).toBe(true);
    expect(isMirrorablePackage('SAPBC_DEMO')).toBe(false);
    expect(isMirrorablePackage('/DMO/FLIGHT')).toBe(false);
    expect(isMirrorablePackage('/DMO/FLIGHT', ['/DMO/'])).toBe(true);
    expect(isMirrorablePackage('/DMOX/FLIGHT', ['/DMO/'])).toBe(false);
    expect(isMirrorablePackage('/DMO/FLIGHT', ['/DMO'])).toBe(false);
  });
});

describe('isSafeRelativePath', () => {
  it('refuses absolute paths, .. and separators inside a segment', () => {
    expect(isSafeRelativePath('src/zadtplus/zcl_x.clas.abap')).toBe(true);
    expect(isSafeRelativePath('src/zadtplus/zui_x_van        0001.iwvb.jsonc')).toBe(true);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('src/../../x')).toBe(false);
    expect(isSafeRelativePath('src//x')).toBe(false);
    expect(isSafeRelativePath('src/a\\b')).toBe(false);
    expect(isSafeRelativePath('C:\\x')).toBe(false);
    expect(isSafeRelativePath('')).toBe(false);
  });
});

describe('path safety', () => {
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-layout-')));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('takes a root inside a workspace folder and refuses one outside', async () => {
    const ws = path.join(base, 'ws');
    mkdirSync(path.join(ws, 'm'), { recursive: true });
    expect(await resolveRoot(path.join(ws, 'm'), [ws])).toBe(path.join(ws, 'm'));
    expect(await resolveRoot(ws, [ws])).toBe(ws);
    await expect(resolveRoot(base, [ws])).rejects.toThrow(/outside the workspace folders/);
    await expect(resolveRoot(path.join(ws, '..', 'other'), [ws])).rejects.toThrow(/outside/);
    await expect(resolveRoot('m', [ws])).rejects.toThrow(/not an absolute path/);
  });

  it('creates a missing root only when asked', async () => {
    const ws = path.join(base, 'ws');
    mkdirSync(ws);
    await expect(resolveRoot(path.join(ws, 'new'), [ws])).rejects.toThrow(/does not exist/);
    expect(await resolveRoot(path.join(ws, 'new', 'deep'), [ws], { create: true })).toBe(path.join(ws, 'new', 'deep'));
  });

  it('refuses a root that a symlink takes out of the workspace', async () => {
    const ws = path.join(base, 'ws');
    mkdirSync(ws);
    mkdirSync(path.join(base, 'outside'));
    symlinkSync(path.join(base, 'outside'), path.join(ws, 'link'));
    await expect(resolveRoot(path.join(ws, 'link'), [ws])).rejects.toThrow(/outside/);
    await expect(resolveRoot(path.join(ws, 'link', 'sub'), [ws], { create: true })).rejects.toThrow(/outside/);
  });

  it('refuses targets through a symlinked folder, symlinked files and unsafe paths', async () => {
    mkdirSync(path.join(base, 'src', 'pkg'), { recursive: true });
    const outside = mkdtempSync(path.join(tmpdir(), 'adtplus-outside-'));
    try {
      symlinkSync(outside, path.join(base, 'src', 'evil'));
      writeFileSync(path.join(outside, 'f'), 'x');
      symlinkSync(path.join(outside, 'f'), path.join(base, 'src', 'pkg', 'link.clas.abap'));
      expect(await safeTarget(base, 'src/pkg/zcl_x.clas.abap')).toBe(path.join(base, 'src', 'pkg', 'zcl_x.clas.abap'));
      await expect(safeTarget(base, 'src/evil/zcl_x.clas.abap')).rejects.toThrow(/leaves the mirror root/);
      await expect(safeTarget(base, 'src/evil/new/zcl_x.clas.abap', { mkdir: false })).rejects.toThrow(/leaves/);
      await expect(safeTarget(base, 'src/pkg/link.clas.abap')).rejects.toThrow(/symlink/);
      await expect(safeTarget(base, 'src/../x')).rejects.toThrow(/unsafe/);
      expect(await safeTarget(base, 'src/new/sub/f.abap', { mkdir: true })).toBe(path.join(base, 'src', 'new', 'sub', 'f.abap'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
