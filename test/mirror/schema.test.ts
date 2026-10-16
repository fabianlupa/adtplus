import { describe, expect, it } from 'vitest';
import { lineOf, schemaTypes, validateAffJson } from '../../src/mirror/schema.js';

// As adt-ls serves them (M1 pulls), the final newline added by the pull.
const ONPREM_CLAS = `{
  "formatVersion": "1",
  "header": {
    "description": "Behavior Implementation for ZI_RAP_TRAVEL_ADTPLUS",
    "originalLanguage": "en"
  },
  "category": "behaviorClass",
  "fixPointArithmetic": true
}
`;

const CLOUD_ERP_SRVB = `{
  "formatVersion": "1",
  "header": {
    "description": "Service Binding for ZADTPLUS_UI_CUSTOMER2_O4",
    "originalLanguage": "en",
    "abapLanguageVersion": "cloudDevelopment"
  },
  "bindingType": "ODATA V4",
  "bindingTypeCategory": "ui",
  "services": [
    {
      "name": "ZADTPLUS_UI_CUSTOMER2_O4",
      "versions": [
        {
          "serviceVersion": "1.0.0",
          "serviceBuildVersion": "",
          "serviceDefinition": "ZADTPLUS_UI_CUSTOMER2_O4"
        }
      ]
    }
  ]
}
`;

describe('schemaTypes', () => {
  it('takes the most specific file-name part first, as json-validator.py does', () => {
    expect(schemaTypes('zcl_x.clas.json')).toEqual(['clas']);
    expect(schemaTypes('z_fg.fugr.z_fm.func.json')).toEqual(['func', 'z_fm', 'fugr', 'fugr.z_fm', 'fugr.z_fm.func']);
    expect(schemaTypes('(dmo)fg.fugr.(dmo)saplfg.reps.json')[0]).toBe('reps');
    expect(schemaTypes('zt.tabl.settings.json')).toEqual(['tabt', 'settings', 'tabl']);
    expect(schemaTypes('x.json')).toEqual([]);
  });
});

describe('validateAffJson', () => {
  it('accepts pulled files of both systems', () => {
    expect(validateAffJson('zbp_i_rap_travel_adtplus.clas.json', ONPREM_CLAS)).toEqual({ status: 'valid', schema: 'clas-v1' });
    expect(validateAffJson('zadtplus_ui_customer2_o4.srvb.json', CLOUD_ERP_SRVB)).toEqual({ status: 'valid', schema: 'srvb-v1' });
  });

  it("excuses only the binding's empty serviceBuildVersion (ADR-007)", () => {
    const built = CLOUD_ERP_SRVB.replace('"serviceBuildVersion": ""', '"serviceBuildVersion": "x1"');
    const result = validateAffJson('zadtplus_ui_customer2_o4.srvb.json', built);
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.findings).toEqual([
      { line: 16, message: '/services/0/versions/0/serviceBuildVersion must match pattern "^[0-9]+$" [srvb-v1]' },
    ]);
    // The same empty value elsewhere is no exception.
    const other = validateAffJson('z.srvb.json', CLOUD_ERP_SRVB.replace('"serviceVersion": "1.0.0"', '"serviceVersion": 1'));
    expect(other.status).toBe('invalid');
  });

  it('places schema errors on the line of the offending key', () => {
    const text = ONPREM_CLAS.replace('"originalLanguage": "en"', '"originalLanguage": "en",\n    "bogus": 1');
    const result = validateAffJson('zcl_x.clas.json', text);
    expect(result.status === 'invalid' && result.findings).toEqual([
      { line: 6, message: '/header/bogus must NOT have additional properties [clas-v1]' },
    ]);
    const missing = validateAffJson('zcl_x.clas.json', '{\n  "formatVersion": "1"\n}\n');
    expect(missing.status === 'invalid' && missing.findings).toEqual([
      { line: 1, message: "/ must have required property 'header' [clas-v1]" },
    ]);
  });

  it('reports broken JSON with its line', () => {
    const result = validateAffJson('zcl_x.clas.json', '{\n  "formatVersion": "1",\n}\n');
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.findings[0]!.line).toBe(3);
  });

  it('wants a formatVersion where a schema exists', () => {
    const result = validateAffJson('zcl_x.clas.json', '{\n  "header": {}\n}\n');
    expect(result.status === 'invalid' && result.findings[0]!.message).toMatch(/formatVersion missing/);
  });

  it('counts types and versions without a vendored schema as such', () => {
    expect(validateAffJson('zx.uiad.json', '{"formatVersion": "1"}')).toEqual({ status: 'noSchema', type: 'uiad' });
    expect(validateAffJson('zx.clas.json', '{"formatVersion": "9"}')).toEqual({ status: 'noSchema', type: 'clas' });
    expect(validateAffJson('zx.uiad.json', '{}')).toEqual({ status: 'noSchema', type: 'uiad' });
  });

  it('picks the function-module and table-settings schemas', () => {
    const func = validateAffJson('z_fg.fugr.z_fm.func.json', '{"formatVersion": "1", "header": {"description": "d", "originalLanguage": "en"}, "processingType": "nope"}');
    expect(func.status === 'invalid' && func.schema).toBe('func-v1');
    const tabt = validateAffJson('zt.tabl.settings.json', '{"formatVersion": "1"}');
    expect(tabt.status !== 'noSchema' && tabt.schema).toBe('tabt-v1');
  });
});

describe('lineOf', () => {
  const text = '{\n  "a": {\n    "b": [\n      1,\n      { "c/d": 2 }\n    ]\n  }\n}';
  it('finds keys, array items and escaped segments', () => {
    expect(lineOf(text, '')).toBe(1);
    expect(lineOf(text, '/a')).toBe(2);
    expect(lineOf(text, '/a/b/0')).toBe(4);
    expect(lineOf(text, '/a/b/1/c~1d')).toBe(5);
    expect(lineOf(text, '/nope')).toBe(1);
  });
});
