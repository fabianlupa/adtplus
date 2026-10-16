import { LanguageVersion, Registry } from '@abaplint/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abaplintVersion, affLanguageVersion, lint, objectStem } from '../../src/mirror/lint.js';

// A RAP behaviour pool as adt-ls serves it: ABSTRACT FINAL, a local handler named lhc_,
// SAP's superclass unknown to the mirror.
const POOL = {
  'src/p/zbp_r_travel.clas.abap': `CLASS zbp_r_travel DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF zr_travel.
ENDCLASS.

CLASS zbp_r_travel IMPLEMENTATION.
ENDCLASS.
`,
  'src/p/zbp_r_travel.clas.implementations.abap': `CLASS lhc_travel DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION
      IMPORTING REQUEST requested_authorizations FOR travel RESULT result.
ENDCLASS.

CLASS lhc_travel IMPLEMENTATION.
  METHOD get_global_authorizations.
    result = VALUE #( ).
  ENDMETHOD.
ENDCLASS.
`,
  'src/p/zbp_r_travel.clas.json': `{
  "formatVersion": "1",
  "header": {
    "description": "Behavior pool",
    "originalLanguage": "en"
  },
  "category": "behaviorClass"
}
`,
};

const TABL = {
  'src/p/zt_travel.tabl.ddic': `@EndUserText.label : 'Travel'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table zt_travel {
  key client : abap.clnt not null;
  key id     : abap.numc(8) not null;
}
`,
};

const INCLUDE = { 'src/p/zinc.prog.abap': 'DATA gv_x TYPE i.\n' };

const FUNC = {
  'src/p/zfg.fugr.z_fm.func.abap': `FUNCTION z_fm.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"----------------------------------------------------------------------
ENDFUNCTION.
`,
};

const files = (...sets: Array<Record<string, string>>) =>
  sets.flatMap((s) => Object.entries(s).map(([path, text]) => ({ path, text })));
const rules = (findings: Array<{ rule: string }>) => [...new Set(findings.map((f) => f.rule))].sort();

afterEach(() => vi.restoreAllMocks());

describe('abaplint stage 1', () => {
  it('raises none of the known false positives on a behaviour pool', async () => {
    const result = await lint(files(POOL), 'standard');
    expect(rules(result.findings)).toEqual([]);
    expect(result.objects).toBe(1);
  });

  it('drops the AFF gaps per type: tables, program includes, function modules', async () => {
    const result = await lint(files(TABL, INCLUDE, FUNC), 'standard');
    expect(rules(result.findings).filter((r) => ['check_ddic', 'tabl_enhancement_category', 'main_file_contents', 'parser_error', 'structure'].includes(r))).toEqual([]);
  });

  it('keeps a parser error elsewhere, as an error', async () => {
    const broken = { 'src/p/zcl_x.clas.abap': 'CLASS zcl_x DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    DATA x TYPE.\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\nENDCLASS.\n' };
    const result = await lint(files(broken), 'standard');
    const error = result.findings.find((f) => f.severity === 'error');
    expect(error).toMatchObject({ file: 'src/p/zcl_x.clas.abap', line: 3, rule: 'parser_error' });
  });

  it('keeps no_comments_between_methods, but not for a comment on an ENDMETHOD line (ONPREM stores that in the method)', async () => {
    const source = [
      'CLASS zcl_c DEFINITION PUBLIC.',
      '  PUBLIC SECTION.',
      '    METHODS a.',
      'ENDCLASS.',
      'CLASS zcl_c IMPLEMENTATION.',
      '  METHOD a.',
      '  ENDMETHOD. " kept',
      '  " between methods',
      'ENDCLASS.',
      '',
    ].join('\n');
    const result = await lint([{ path: 'src/p/zcl_c.clas.abap', text: source }], 'cloudDevelopment');
    expect(result.findings.filter((f) => f.rule === 'no_comments_between_methods')).toEqual([
      expect.objectContaining({ line: 8, severity: 'error' }),
    ]);
  });

  it("warns of a class frame comment the rule doesn't see; push decides against the system's version", async () => {
    const source = 'CLASS zcl_c DEFINITION PUBLIC.\nENDCLASS.\n" between\nCLASS zcl_c IMPLEMENTATION.\nENDCLASS.\n* after\n';
    const result = await lint([{ path: 'src/p/zcl_c.clas.abap', text: source }], 'cloudDevelopment');
    expect(result.findings.filter((f) => f.rule === 'class_frame_comment')).toEqual([
      expect.objectContaining({ line: 3, severity: 'warning', message: expect.stringContaining('between the definition and the implementation') }),
      expect.objectContaining({ line: 6, severity: 'warning', message: expect.stringContaining('after the last ENDCLASS') }),
    ]);
  });

  it('reports a CDS parser error as an error', async () => {
    const view = { 'src/p/zi_x.ddls.acds': 'define view entity ZI_X as select from zt { key id as Id,, }\n' };
    const result = await lint(files(view), 'standard');
    expect(result.findings).toEqual([expect.objectContaining({ rule: 'cds_parser_error', severity: 'error', line: 1 })]);
  });

  it('leaves style off by default; a switch turns a rule on, as a warning', async () => {
    const style = { 'src/p/zcl_y.clas.abap': 'CLASS zcl_y DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS m.\nENDCLASS.\nCLASS zcl_y IMPLEMENTATION.\n  METHOD m.\n  ENDMETHOD.\nENDCLASS.\n' };
    expect((await lint(files(style), 'standard')).findings).toEqual([]);
    const switched = await lint(files(style), 'standard', { abapdoc: true });
    expect(switched.findings).toEqual([expect.objectContaining({ rule: 'abapdoc', severity: 'warning' })]);
  });

  it('reports likely bugs as warnings', async () => {
    const buggy = { 'src/p/zcl_z.clas.abap': 'CLASS zcl_z DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS m.\nENDCLASS.\nCLASS zcl_z IMPLEMENTATION.\n  METHOD m.\n    DATA lv_unused TYPE i.\n  ENDMETHOD.\nENDCLASS.\n' };
    const result = await lint(files(buggy), 'standard');
    expect(result.findings).toEqual([expect.objectContaining({ rule: 'unused_variables', severity: 'warning', line: 7 })]);
  });

  it('refuses a rule switch abaplint does not have', async () => {
    await expect(lint(files(POOL), 'standard', { no_such_rule: true })).rejects.toThrow(/unknown abaplint rule: no_such_rule/);
  });

  it("leaves out types abaplint doesn't know, counted per object", async () => {
    const nont = { 'src/p/zadtplus_nt.nont.json': '{"formatVersion": "1"}\n', 'src/p/zadtplus_rt.ront.json': '{}\n' };
    const result = await lint(files(nont, POOL), 'cloudDevelopment');
    expect(result.unknownTypes).toEqual({ NONT: 1, RONT: 1 });
    expect(rules(result.findings).filter((r) => r === 'parser_error' || r === 'cloud_types')).toEqual([]);
  });

  it('lints the other objects when a rule throws on one', async () => {
    vi.spyOn(Registry.prototype, 'findIssues').mockImplementation(() => {
      throw new Error('getRawRows');
    });
    const original = Registry.prototype.findIssuesObject;
    vi.spyOn(Registry.prototype, 'findIssuesObject').mockImplementation(function (this: Registry, obj) {
      if (obj.getType() === 'TABL') throw new Error("Cannot read properties of undefined (reading 'getRawRows')");
      return original.call(this, obj);
    });
    const broken = { 'src/p/zcl_x.clas.abap': 'CLASS zcl_x DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    DATA x TYPE.\nENDCLASS.\n' };
    const result = await lint(files(TABL, broken), 'standard');
    expect(result.findings).toContainEqual(expect.objectContaining({ rule: 'abaplint_crash', severity: 'warning', file: 'src/p/zt_travel.tabl.ddic' }));
    expect(result.findings).toContainEqual(expect.objectContaining({ rule: 'parser_error', file: 'src/p/zcl_x.clas.abap' }));
  });

  it('maps the AFF language versions to abaplint\'s', () => {
    expect(abaplintVersion('cloudDevelopment')).toBe(LanguageVersion.Cloud);
    expect(abaplintVersion('keyUser')).toBe(LanguageVersion.KeyUser);
    expect(abaplintVersion('standard')).toBe(LanguageVersion.Normal);
  });

  it("reads an object's language version from its AFF .json, standard without one", () => {
    expect(affLanguageVersion('{"header": {"abapLanguageVersion": "cloudDevelopment"}}')).toBe('cloudDevelopment');
    expect(affLanguageVersion('{"header": {"abapLanguageVersion": "keyUser"}}')).toBe('keyUser');
    expect(affLanguageVersion('{"header": {"description": "x"}}')).toBeUndefined();
    expect(affLanguageVersion('{"header": {"abapLanguageVersion": "other"}}')).toBeUndefined();
    expect(affLanguageVersion('{"formatVersion": "1"}')).toBeUndefined();
    expect(affLanguageVersion('not json')).toBeUndefined();
    expect(objectStem('src/p/ZCL_X.clas.locals_imp.abap')).toBe('zcl_x.clas');
  });

  it('lints each object at the version its .json names, the fallback for one without', async () => {
    const cls = (name: string) =>
      `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS m.\nENDCLASS.\nCLASS ${name} IMPLEMENTATION.\n  METHOD m.\n    WRITE 'x'.\n  ENDMETHOD.\nENDCLASS.\n`;
    const json = (version: string) => `{"formatVersion": "1", "header": {"description": "x", "originalLanguage": "en", "abapLanguageVersion": "${version}"}}\n`;
    const mixed = {
      'src/p/zcl_cloud.clas.abap': cls('zcl_cloud'),
      'src/p/zcl_cloud.clas.json': json('cloudDevelopment'),
      'src/p/zcl_std.clas.abap': cls('zcl_std'),
      'src/p/zcl_std.clas.json': json('standard'),
      'src/p/zcl_none.clas.abap': cls('zcl_none'),
    };
    const result = await lint(files(mixed), 'standard');
    expect(result.languageVersions).toEqual({ cloudDevelopment: 1, standard: 2 });
    expect(result.objects).toBe(3);
    const errored = new Set(result.findings.filter((f) => f.severity === 'error').map((f) => f.file));
    expect([...errored]).toEqual(['src/p/zcl_cloud.clas.abap']);
  });
});
