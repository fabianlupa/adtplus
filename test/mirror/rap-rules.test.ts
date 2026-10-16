import { describe, expect, it } from 'vitest';
import { rapFindings } from '../../src/mirror/rap-rules.js';

const f = (path: string, text: string) => ({ path: `src/zadtplus_a/${path}`, text });
const rules = (files: Array<{ path: string; text: string }>) => rapFindings(files).map((x) => [x.path.split('/').pop(), x.line, x.rule]);

const TABLE = (fields: string) => `@EndUserText.label : 'Trip'
@AbapCatalog.tableCategory : #TRANSPARENT
define table zadtplus_trip {

  key client : abap.clnt not null;
${fields}
}
`;

describe('TABL: amount and quantity references', () => {
  it('flags an amount and a quantity field without their reference, naming the fix', () => {
    const out = rapFindings([f('zadtplus_trip.tabl.ddic', TABLE('  price : abap.curr(15,2);\n  currency : abap.cuky;\n  seats : abap.quan(13,3);\n  unit : abap.unit(3);'))]);
    expect(out.map((x) => [x.line, x.rule])).toEqual([
      [6, 'tabl_semantics_reference'],
      [8, 'tabl_semantics_reference'],
    ]);
    expect(out[0]!.message).toContain("@Semantics.amount.currencyCode : 'zadtplus_trip.currency'");
    expect(out[1]!.message).toContain("@Semantics.quantity.unitOfMeasure : 'zadtplus_trip.unit'");
  });

  it('accepts annotated fields, also across comments and other annotations', () => {
    const text = TABLE(`  // price
  @Semantics.amount.currencyCode : 'zadtplus_trip.currency'
  @AbapCatalog.foo : true
  price : abap.curr(15,2);
  currency : abap.cuky;
  @Semantics.quantity.unitOfMeasure : 'zadtplus_trip.unit'
  seats : abap.quan(13,3);
  unit : abap.unit(3);`);
    expect(rapFindings([f('zadtplus_trip.tabl.ddic', text)])).toEqual([]);
  });

  it("flags a reference to a field the table doesn't have, unless an include may bring it", () => {
    const body = "  @Semantics.amount.currencyCode : 'zadtplus_trip.waers'\n  price : abap.curr(15,2);";
    expect(rules([f('zadtplus_trip.tabl.ddic', TABLE(body))])).toEqual([['zadtplus_trip.tabl.ddic', 7, 'tabl_semantics_reference']]);
    expect(rapFindings([f('zadtplus_trip.tabl.ddic', TABLE(`${body}\n  include zadtplus_s;`))])).toEqual([]);
  });
});

const BDEF = (header: string, preamble = 'managed implementation in class zbp_r_x unique;\nstrict ( 2 );') => `${preamble}

define behavior for ZR_X
persistent table zx
lock master
${header}
{
  create;
}
`;

describe('BDEF', () => {
  it('flags a strict BDEF without authorization', () => {
    expect(rules([f('zr_x.bdef.abdl', BDEF(''))])).toEqual([['zr_x.bdef.abdl', 4, 'bdef_strict_authorization']]);
    expect(rapFindings([f('zr_x.bdef.abdl', BDEF('authorization master ( instance )'))])).toEqual([]);
    expect(rapFindings([f('zr_x.bdef.abdl', BDEF('authorization dependent by _Parent'))])).toEqual([]);
    expect(rapFindings([f('zr_x.bdef.abdl', BDEF('', 'managed implementation in class zbp_r_x unique;'))])).toEqual([]);
  });

  it('flags authorization master values other than global and instance', () => {
    const out = rapFindings([f('zr_x.bdef.abdl', BDEF('authorization master ( none )'))]);
    expect(out.map((x) => [x.line, x.rule])).toEqual([[7, 'bdef_authorization_master']]);
    expect(out[0]!.message).toContain('( instance )');
    expect(rapFindings([f('zr_x.bdef.abdl', BDEF('authorization master ( global )'))])).toEqual([]);
  });

  it('flags a projection stricter than its base, through the local views', () => {
    const files = [
      f('zr_x.bdef.abdl', BDEF('authorization master ( instance )', 'managed implementation in class zbp_r_x unique;\nstrict;')),
      f('zc_x.bdef.abdl', 'projection;\nstrict ( 2 );\n\ndefine behavior for ZC_X alias X\n{\n  use create;\n}\n'),
      f('zc_x.ddls.acds', 'define root view entity ZC_X\n  provider contract transactional_query\n  as projection on ZR_X\n{\n  key Id\n}\n'),
      f('zr_x.ddls.acds', 'define root view entity ZR_X as select from zx { key id as Id }\n'),
    ];
    expect(rules(files)).toEqual([['zc_x.bdef.abdl', 2, 'bdef_projection_strictness']]);
    expect(rapFindings(files.slice(1))).toEqual([]);
  });

  it("flags `strict` before the implementation type, which push can't read", () => {
    expect(rules([f('zc_x.bdef.abdl', 'strict ( 2 );\nprojection;\n\ndefine behavior for ZC_X\n{\n}\n')])).toEqual([['zc_x.bdef.abdl', 1, 'bdef_implementation_type_first']]);
  });

  it('ignores comments', () => {
    expect(rapFindings([f('zr_x.bdef.abdl', BDEF('// authorization master ( none )\nauthorization master ( instance )'))])).toEqual([]);
  });
});

const VIEW = 'define root view entity ZR_X as select from zx association [1..1] to ZR_T as _Trip on $projection.TripId = _Trip.Id\n{\n  key id as Id,\n  trip_id as TripId,\n  _Trip\n}\n';
const ROLE = (where: string) => `@EndUserText.label: 'R'\n@MappingRole: true\ndefine role ZR_X {\n  grant select on ZR_X\n    where ${where};\n}\n`;

describe('DCLS', () => {
  it("flags an element the local view doesn't have", () => {
    const out = rapFindings([f('zr_x.ddls.acds', VIEW), f('zr_x.dcls.acds', ROLE("( Travel ) = aspect pfcg_auth( Z_OBJ, ACTVT, ACTVT = '03' )"))]);
    expect(out.map((x) => [x.line, x.rule])).toEqual([[5, 'dcls_unknown_element']]);
    expect(out[0]!.message).toContain('Travel is not an element of ZR_X');
  });

  it('accepts elements, associations and paths, and skips what it cannot read', () => {
    const ok = [f('zr_x.ddls.acds', VIEW)];
    for (const where of ["( Id, TripId ) = aspect pfcg_auth( Z_OBJ, F1, F2, ACTVT = '03' )", "_Trip.Id = 'X'", 'TripId = aspect user']) {
      expect(rapFindings([...ok, f('zr_x.dcls.acds', ROLE(where))])).toEqual([]);
    }
    expect(rapFindings([f('zr_x.dcls.acds', ROLE('Nope = aspect user'))])).toEqual([]);
    const star = 'define root view entity ZC_X as projection on ZR_X\n{\n  *\n}\n';
    expect(rapFindings([f('zc_x.ddls.acds', star), f('zc_x.dcls.acds', ROLE('Nope = aspect user').replaceAll('ZR_X', 'ZC_X'))])).toEqual([]);
  });
});
