import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creationInput, folderPackage, groupNew, knownPackage, type NewObject } from '../../src/mirror/create.js';
import { emptyManifest, saveManifest, type Manifest } from '../../src/mirror/manifest.js';
import { NEW_TYPES, newObject } from '../../src/mirror/new.js';

const MANIFEST: Manifest = {
  ...emptyManifest('onprem'),
  packages: [{ name: 'ZADTPLUS_A', subpackages: true }],
  objects: { 'CLAS ZCL_OLD': { package: 'ZADTPLUS_A_SUB', dir: 'src/zadtplus_a/zadtplus_a_sub', files: {} } },
};

const object = (type: string, name: string, files: Record<string, string>): NewObject => ({
  id: `${type} ${name}`,
  type,
  name,
  dir: 'src/zadtplus_a',
  files: new Map(Object.entries(files)),
});
const json = (fields: Record<string, unknown> = {}, description = 'Desc') => JSON.stringify({ formatVersion: '1', header: { description }, ...fields });

describe('groupNew', () => {
  it('groups files by folder and object, namespaced names included, in creation order', () => {
    const groups = groupNew([
      { rel: 'src/zadtplus_a/zadtplus_srvb.srvb.json', text: '{}' },
      { rel: 'src/zadtplus_a/zcl_x.clas.abap', text: 'a' },
      { rel: 'src/zadtplus_a/zcl_x.clas.testclasses.abap', text: 'b' },
      { rel: 'src/zadtplus_a/zcl_x.clas.json', text: '{}' },
      { rel: 'src/zadtplus_a/sub/(dmo)tab.tabl.ddic', text: 'c' },
      { rel: 'src/zadtplus_a/README', text: '' },
    ]);
    expect(groups.map((g) => [g.id, g.dir, [...g.files.keys()]])).toEqual([
      ['TABL /DMO/TAB', 'src/zadtplus_a/sub', ['(dmo)tab.tabl.ddic']],
      ['CLAS ZCL_X', 'src/zadtplus_a', ['zcl_x.clas.abap', 'zcl_x.clas.testclasses.abap', 'zcl_x.clas.json']],
      ['SRVB ZADTPLUS_SRVB', 'src/zadtplus_a', ['zadtplus_srvb.srvb.json']],
    ]);
  });
});

describe('creationInput', () => {
  it('takes the description and the fields only the files say', () => {
    expect(creationInput(object('CLAS', 'ZCL_X', { 'zcl_x.clas.abap': '', 'zcl_x.clas.json': json() }))).toEqual({ objectType: 'CLAS/OC', description: 'Desc' });
    expect(creationInput(object('SRVD', 'ZUI_X', { 'zui_x.srvd.acds': '', 'zui_x.srvd.json': json() }))).toMatchObject({ additionalFields: { sourceType: 'S' } });
    const bdef = '// the root\nmanaged implementation in class zbp_r_x unique;\nstrict ( 2 );\ndefine behavior for ZR_X alias X\n{ }';
    expect(creationInput(object('BDEF', 'ZR_X', { 'zr_x.bdef.abdl': bdef, 'zr_x.bdef.json': json() }))).toEqual({
      objectType: 'BDEF/BDO',
      description: 'Desc',
      additionalFields: { behaviorDefinitionType: 'definition', rootEntity: 'ZR_X', implementationType: 'Managed' },
    });
    const projection = 'projection;\nstrict ( 2 );\ndefine behavior for ZC_X\n{ use create; }';
    expect(creationInput(object('BDEF', 'ZC_X', { 'zc_x.bdef.abdl': projection, 'zc_x.bdef.json': json() }))).toMatchObject({
      additionalFields: { implementationType: 'Projection', rootEntity: 'ZC_X' },
    });
    const srvb = json({ bindingType: 'ODATA V4', bindingTypeCategory: 'webApi', services: [{ name: 'ZAPI_X', versions: [{ serviceDefinition: 'zui_x' }] }] });
    expect(creationInput(object('SRVB', 'ZAPI_X', { 'zapi_x.srvb.json': srvb }))).toMatchObject({
      additionalFields: { bindingType: 'OData V4 - Web API', serviceDefinition: 'ZUI_X' },
    });
  });

  it('says why an object cannot be created', () => {
    const why = (o: NewObject) => creationInput(o) as string;
    expect(why(object('DTEL', 'ZDE_X', { 'zde_x.dtel.json': json() }))).toMatch(/can't create a DTEL/);
    expect(why(object('CLAS', 'ZCL_X', { 'zcl_x.clas.abap': '' }))).toMatch(/no clas\.json/);
    expect(why(object('CLAS', 'ZCL_X', { 'zcl_x.clas.json': '{' }))).toMatch(/not valid JSON/);
    expect(why(object('CLAS', 'ZCL_X', { 'zcl_x.clas.json': json({}, '') }))).toMatch(/no header\.description/);
    expect(why(object('BDEF', 'ZR_Y', { 'zr_y.bdef.abdl': 'managed;\ndefine behavior for ZR_X\n{ }', 'zr_y.bdef.json': json() }))).toMatch(
      /named after its root entity: ZR_X, not ZR_Y/,
    );
    expect(why(object('BDEF', 'ZR_X', { 'zr_x.bdef.abdl': 'define behavior for ZR_X {}', 'zr_x.bdef.json': json() }))).toMatch(/starts with "define"/);
    expect(why(object('SRVB', 'ZUI_B', { 'zui_b.srvb.json': json({ bindingType: 'ODATA V4', bindingTypeCategory: 'ui', services: [] }) }))).toMatch(
      /serviceDefinition is empty/,
    );
    expect(why(object('SRVB', 'ZUI_B', { 'zui_b.srvb.json': json({ bindingType: 'INA', bindingTypeCategory: 'ui' }) }))).toMatch(/no OData/);
  });
});

describe('creation from mirror new skeletons', () => {
  let ws: string;
  let root: string;
  beforeEach(async () => {
    ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-create-')));
    root = path.join(ws, 'mirror');
    mkdirSync(root);
    await saveManifest(root, MANIFEST);
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it('every skeleton but the binding (whose service is a placeholder) gives a creation input', async () => {
    for (const type of NEW_TYPES) {
      await newObject({}, { root, workspaceFolders: [ws], system: 'onprem', type, name: type === 'TABL' ? 'ZADTPLUS_NEW' : type === 'BDEF' ? 'ZR_NEW' : `ZADTPLUS_${type}_NEW` });
    }
    const dir = path.join(root, 'src', 'zadtplus_a');
    const files = readdirSync(dir).map((f) => ({ rel: `src/zadtplus_a/${f}`, text: readFileSync(path.join(dir, f), 'utf8') }));
    const results = Object.fromEntries(groupNew(files).map((o) => [o.type, creationInput(o)]));
    expect(Object.keys(results).sort()).toEqual([...NEW_TYPES].sort());
    for (const [type, result] of Object.entries(results)) {
      if (type === 'SRVB') expect(result).toMatch(/serviceDefinition is empty/);
      else expect(result, type).toMatchObject({ objectType: expect.stringMatching(new RegExp(`^${type}/`)) });
    }
  });
});

describe('the package of a folder', () => {
  it('knows root package folders and the folders of known objects', () => {
    expect(knownPackage(MANIFEST, 'src/zadtplus_a')).toBe('ZADTPLUS_A');
    expect(knownPackage(MANIFEST, 'src/zadtplus_a/zadtplus_a_sub')).toBe('ZADTPLUS_A_SUB');
    expect(knownPackage(MANIFEST, 'src/zadtplus_a/zadtplus_a_new')).toBeUndefined();
  });

  it("checks a folder the manifest doesn't know against the package's chain on the system", () => {
    expect(folderPackage(MANIFEST, 'src/zadtplus_a/zadtplus_a_new', ['ZDEV', 'ZADTPLUS_A', 'ZADTPLUS_A_NEW'])).toEqual({ package: 'ZADTPLUS_A_NEW' });
    expect(folderPackage(MANIFEST, 'src/zadtplus_a/zadtplus_a_sub/zadtplus_a_new', ['ZADTPLUS_A', 'ZADTPLUS_A_NEW'])).toMatchObject({ problem: expect.stringContaining("doesn't match") });
    expect(folderPackage(MANIFEST, 'src/zadtplus_a/zadtplus_a_new', undefined)).toMatchObject({ problem: expect.stringContaining('not found on the system') });
    expect(folderPackage(MANIFEST, 'src/zadtplus_b', ['ZADTPLUS_B'])).toMatchObject({ problem: expect.stringContaining('not a root package') });
    const flat = { ...MANIFEST, packages: [{ name: 'ZADTPLUS_A', subpackages: false }] };
    expect(folderPackage(flat, 'src/zadtplus_a/zadtplus_a_new', ['ZADTPLUS_A', 'ZADTPLUS_A_NEW'])).toMatchObject({ problem: expect.stringContaining('subpackages') });
  });
});
