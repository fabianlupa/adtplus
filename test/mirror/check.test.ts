import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { check } from '../../src/mirror/check.js';
import { filesBelow } from '../../src/mirror/files.js';
import { emptyManifest, saveManifest } from '../../src/mirror/manifest.js';
import { contentHash } from '../../src/mirror/normalize.js';

vi.mock('../../src/mirror/files.js', async (actual) => {
  const files = await actual<typeof import('../../src/mirror/files.js')>();
  return { ...files, filesBelow: vi.fn(files.filesBelow) };
});

let ws: string;
let root: string;
beforeEach(async () => {
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-check-')));
  root = path.join(ws, 'mirror');
  mkdirSync(root);
  await saveManifest(root, { ...emptyManifest('onprem'), adtLs: '1.1.2' });
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  vi.mocked(filesBelow).mockReset();
});

const put = (rel: string, text: string) => {
  const abs = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const run = (extra: Partial<Parameters<typeof check>[0]> = {}) =>
  check({ root, workspaceFolders: [ws], system: 'onprem', languageVersion: 'standard', ...extra });

const SECRET = 'source_marker_never_in_results';
const CLASS = `CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CONSTANTS c TYPE string VALUE '${SECRET}'.
ENDCLASS.

CLASS zcl_x IMPLEMENTATION.
ENDCLASS.
`;
const CLASS_JSON = `{
  "formatVersion": "1",
  "header": {
    "description": "X",
    "originalLanguage": "en"
  }
}
`;

describe('mirror check', () => {
  it('passes a clean mirror and counts what it checked', async () => {
    put('src/zadtplus_a/zcl_x.clas.abap', CLASS);
    put('src/zadtplus_a/zcl_x.clas.json', CLASS_JSON);
    put('src/zadtplus_a/zcl_x.clas.texts.en.properties', '');
    put('src/zadtplus_a/zostat.dtelde.jsonc', '// stub\n');
    put('src/zadtplus_a/zcl_x.clas.abap.remote', 'broken.\n');
    put('src/zadtplus_a/.DS_Store', 'x');
    const result = await run();
    expect(result).toMatchObject({
      system: 'onprem',
      languageVersions: { standard: 1 },
      files: 4,
      objects: 1,
      ok: true,
      errors: 0,
      notLinted: { readOnlyFiles: 2, unknownTypes: {}, symlinks: 0 },
      noSchema: {},
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reports schema, JSON and parser errors first, warnings after, with file:line', async () => {
    put('src/zadtplus_a/zcl_x.clas.abap', CLASS.replace('ENDCLASS.\n\nCLASS', 'ENDCLASS  \n\nCLASS'));
    put('src/zadtplus_a/zcl_x.clas.json', CLASS_JSON.replace('"originalLanguage": "en"', '"originalLanguage": "en",\n    "bogus": true'));
    put('src/zadtplus_a/zcl_y.clas.json', '{\n  "formatVersion": "1",\n}\n');
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.findings.slice(0, result.errors).map((f) => [f.path, f.line, f.rule])).toEqual([
      ['src/zadtplus_a/zcl_x.clas.abap', 1, 'structure'],
      ['src/zadtplus_a/zcl_x.clas.abap', 4, 'parser_error'],
      ['src/zadtplus_a/zcl_x.clas.json', 6, 'aff_schema'],
      ['src/zadtplus_a/zcl_y.clas.json', 3, 'json_syntax'],
    ]);
    expect(result.findings.slice(result.errors).every((f) => f.severity === 'warning')).toBe(true);
    expect(result.byRule).toMatchObject({ structure: 1, parser_error: 1, aff_schema: 1, json_syntax: 1, editorconfig_trim_trailing_whitespace: 1 });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("flags abapGit's class include names with AFF's", async () => {
    put('src/zadtplus_a/zcl_x.clas.abap', CLASS);
    put('src/zadtplus_a/zcl_x.clas.json', CLASS_JSON);
    put('src/zadtplus_a/zcl_x.clas.locals_imp.abap', '" handler\n');
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.findings.filter((f) => f.rule === 'aff_file_name')).toEqual([
      expect.objectContaining({ path: 'src/zadtplus_a/zcl_x.clas.locals_imp.abap', line: 1, severity: 'error', message: expect.stringContaining('zcl_x.clas.implementations.abap') }),
    ]);
  });

  it('reports RAP rule violations as errors, with the fix in the message and no source', async () => {
    put('src/zadtplus_a/zadtplus_trip.tabl.ddic', `define table zadtplus_trip {\n  key id : abap.numc(8) not null;\n  price : abap.curr(15,2); // ${SECRET}\n}\n`);
    put('src/zadtplus_a/zr_x.bdef.abdl', 'managed implementation in class zbp_r_x unique;\nstrict ( 2 );\n\ndefine behavior for ZR_X\npersistent table zx\nlock master\n{\n  create;\n}\n');
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.path, f.line, f.rule, f.severity])).toEqual([
      ['src/zadtplus_a/zadtplus_trip.tabl.ddic', 3, 'tabl_semantics_reference', 'error'],
      ['src/zadtplus_a/zr_x.bdef.abdl', 4, 'bdef_strict_authorization', 'error'],
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('lists at most 50 findings and counts them all', async () => {
    for (let i = 0; i < 60; i++) put(`src/zadtplus_a/zi_v${i}.ddls.acds`, `define view entity ZI_V${i} as select from zt { key id as Id }  \n`);
    const result = await run();
    expect(result.findings).toHaveLength(50);
    expect(result.byRule.editorconfig_trim_trailing_whitespace).toBe(60);
    expect(result.warnings).toBe(60);
  });

  it('excuses the empty serviceBuildVersion and counts types without a schema', async () => {
    put('src/zadtplus_a/zui_x.srvb.json', `{
  "formatVersion": "1",
  "header": {
    "description": "B",
    "originalLanguage": "en"
  },
  "bindingType": "ODATA V4",
  "bindingTypeCategory": "ui",
  "services": [
    {
      "name": "ZUI_X",
      "versions": [
        {
          "serviceVersion": "1.0.0",
          "serviceBuildVersion": "",
          "serviceDefinition": "ZUI_X"
        }
      ]
    }
  ]
}
`);
    put('src/zadtplus_a/zx.uiad.json', '{\n  "formatVersion": "1"\n}\n');
    const result = await run();
    expect(result.errors).toBe(0);
    expect(result.noSchema).toEqual({ uiad: 1 });
  });

  it("doesn't follow symlinks", async () => {
    put('outside.clas.abap', 'garbage');
    mkdirSync(path.join(root, 'src', 'zadtplus_a'), { recursive: true });
    symlinkSync(path.join(root, 'outside.clas.abap'), path.join(root, 'src', 'zadtplus_a', 'zcl_z.clas.abap'));
    const result = await run();
    expect(result).toMatchObject({ files: 0, notLinted: { symlinks: 1 }, ok: true });
  });

  it('lints with the cloud version, notes the gaps, and warns about another adt-ls', async () => {
    put('src/zadtplus_a/zt.tabl.ddic', 'define table zt {\n  key id : abap.numc(8) not null;\n}\n');
    put('src/zadtplus_a/zfg.fugr.z_fm.func.abap', 'FUNCTION z_fm.\nENDFUNCTION.\n');
    const result = await run({ languageVersion: 'cloudDevelopment', adtLsVersion: '1.2.0' });
    expect(result.languageVersions).toEqual({ cloudDevelopment: 2 });
    expect(result.notes).toHaveLength(2);
    expect(result.adtLsChanged).toEqual({ pulled: '1.1.2', running: '1.2.0' });
  });

  describe('files deleted locally', () => {
    // A class and a view as pulled: every file in the manifest with its base.
    beforeEach(async () => {
      const files: Record<string, string> = {
        'src/zadtplus_a/zcl_x.clas.abap': CLASS,
        'src/zadtplus_a/zcl_x.clas.json': CLASS_JSON,
        'src/zadtplus_a/zadtplus_b/zi_v.ddls.acds': 'define view entity ZI_V as select from zt { key id as Id }\n',
      };
      for (const [rel, text] of Object.entries(files)) put(rel, text);
      const entry = (rel: string) => ({ hash: contentHash(files[rel]!) });
      await saveManifest(root, {
        ...emptyManifest('onprem'),
        adtLs: '1.1.2',
        objects: {
          'CLAS/OC ZCL_X': { package: 'ZADTPLUS_A', dir: 'src/zadtplus_a', files: { 'zcl_x.clas.abap': entry('src/zadtplus_a/zcl_x.clas.abap'), 'zcl_x.clas.json': entry('src/zadtplus_a/zcl_x.clas.json') } },
          'DDLS/DF ZI_V': { package: 'ZADTPLUS_B', dir: 'src/zadtplus_a/zadtplus_b', files: { 'zi_v.ddls.acds': entry('src/zadtplus_a/zadtplus_b/zi_v.ddls.acds') } },
        },
      });
    });

    it('lists a whole object deleted as deletions and checks the rest', async () => {
      rmSync(path.join(root, 'src/zadtplus_a/zcl_x.clas.abap'));
      rmSync(path.join(root, 'src/zadtplus_a/zcl_x.clas.json'));
      const result = await run();
      expect(result).toMatchObject({ ok: true, files: 1, deleted: { count: 2, paths: ['src/zadtplus_a/zcl_x.clas.abap', 'src/zadtplus_a/zcl_x.clas.json'] } });
    });

    it('lists a deleted object folder the same way', async () => {
      rmSync(path.join(root, 'src/zadtplus_a/zadtplus_b'), { recursive: true });
      const result = await run();
      expect(result).toMatchObject({ ok: true, files: 2, objects: 1, deleted: { count: 1, paths: ['src/zadtplus_a/zadtplus_b/zi_v.ddls.acds'] } });
    });

    it("lists one deleted file of an object and lints the object's other files", async () => {
      rmSync(path.join(root, 'src/zadtplus_a/zcl_x.clas.json'));
      const result = await run();
      expect(result).toMatchObject({ ok: true, files: 2, objects: 2, deleted: { count: 1, paths: ['src/zadtplus_a/zcl_x.clas.json'] } });
    });

    it("doesn't list a manifest file replaced by a symlink as deleted", async () => {
      rmSync(path.join(root, 'src/zadtplus_a/zcl_x.clas.json'));
      put('outside.json', CLASS_JSON);
      symlinkSync(path.join(root, 'outside.json'), path.join(root, 'src/zadtplus_a/zcl_x.clas.json'));
      const result = await run();
      expect(result).toMatchObject({ notLinted: { symlinks: 1 }, deleted: { count: 0, paths: [] } });
    });

    it('skips a file deleted between the listing and its read', async () => {
      // An `rm` running beside the check: the listing still has the file, the read finds it gone.
      const { filesBelow: list } = await vi.importActual<typeof import('../../src/mirror/files.js')>('../../src/mirror/files.js');
      vi.mocked(filesBelow).mockImplementationOnce(async (r, dir) => {
        const listedFiles = await list(r, dir);
        rmSync(path.join(root, 'src/zadtplus_a/zcl_x.clas.abap'));
        return listedFiles;
      });
      const result = await run();
      expect(result).toMatchObject({ ok: true, files: 2, deleted: { count: 1, paths: ['src/zadtplus_a/zcl_x.clas.abap'] } });
    });
  });

  it('refuses another system and a folder without a mirror', async () => {
    await expect(run({ system: 'cloud-erp' })).rejects.toThrow(/mirrors system "onprem", not "cloud-erp"/);
    rmSync(path.join(root, '.adtplus'), { recursive: true });
    await expect(run()).rejects.toThrow(/no mirror at/);
  });
});
