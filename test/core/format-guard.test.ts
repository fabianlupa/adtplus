import { describe, expect, it } from 'vitest';
import { checkFormat } from '../../src/core/format-guard.js';

const guard = (language: 'abap' | 'ddl', before: string, after: string) => checkFormat(language, before, after).guard;

const ABAP = [
  'class zcl_x definition public final create public.',
  '  public section.',
  '    methods total importing it_nets type string_table returning value(rv) type i.',
  'endclass.',
  'class zcl_x implementation.',
  '  method total.',
  '"comment here',
  'loop at it_nets into data(lv_net).',
  "rv = rv + strlen( lv_net ) + strlen( 'Mixed Case' ).",
  'endloop.',
  '  endmethod.',
  'endclass.',
].join('\n');

const FORMATTED = [
  'CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    METHODS total IMPORTING it_nets   TYPE string_table',
  '                  RETURNING VALUE(rv) TYPE i.',
  'ENDCLASS.',
  '',
  '',
  'CLASS zcl_x IMPLEMENTATION.',
  '  METHOD total.',
  '    " Comment here',
  '    LOOP AT it_nets INTO DATA(lv_net).',
  "      rv = rv + strlen( lv_net ) + strlen( 'Mixed Case' ).",
  '    ENDLOOP.',
  '  ENDMETHOD.',
  'ENDCLASS.',
].join('\n');

describe('checkFormat, ABAP', () => {
  it('passes case, indentation, alignment, empty lines and re-spaced comments', () => {
    expect(guard('abap', ABAP, FORMATTED)).toEqual({ verified: true });
  });

  it('refuses a rewrite, naming the first token that differs', () => {
    const rewritten = FORMATTED.replace("rv = rv + strlen( lv_net ) + strlen( 'Mixed Case' ).", "rv += strlen( lv_net ) + strlen( 'Mixed Case' ).");
    expect(guard('abap', ABAP, rewritten)).toEqual({
      verified: false,
      difference: `line 9 "rv = rv + strlen( lv_net ) + strlen( 'Mixed Case' )." became line 12 "rv += strlen( lv_net ) + strlen( 'Mixed Case' )."`,
    });
  });

  it('compares literals exactly', () => {
    expect(guard('abap', ABAP, FORMATTED.replace("'Mixed Case'", "'MIXED CASE'"))).toMatchObject({ verified: false, difference: expect.stringContaining("'Mixed Case'") });
  });

  it('refuses a dropped statement at the end', () => {
    expect(guard('abap', ABAP, FORMATTED.replace(/ENDCLASS\.$/, ''))).toMatchObject({ verified: false, difference: expect.stringMatching(/became the end$/) });
  });
});

const CDS = [
  "@EndUserText.label: 'Trip'",
  'define view entity ZADTPLUS_I_Trip as select from zadtplus_trip',
  '{',
  'key id as Id,',
  'destination as Destination',
  '}',
].join('\n');

describe('checkFormat, DDL syntax', () => {
  it('passes alignment and line breaks', () => {
    const aligned = CDS.replace(' as select', '\n  as select').replace('key id as Id', '  key id          as Id').replace('destination as', '      destination as');
    expect(guard('ddl', CDS, aligned)).toEqual({ verified: true });
  });

  it('refuses a changed label', () => {
    expect(guard('ddl', CDS, CDS.replace("'Trip'", "'trip'"))).toMatchObject({ verified: false, difference: `line 1 "@EndUserText.label: 'Trip'" became line 1 "@EndUserText.label: 'trip'"` });
  });

  it('refuses a dropped or changed comment, which abaplint has no token for', () => {
    const commented = CDS.replace('destination as Destination', '// where to\ndestination as Destination');
    expect(guard('ddl', commented, CDS)).toMatchObject({ verified: false, difference: expect.stringMatching(/^line 5 "\/\/ where to" became line 5 "destination as Destination"/) });
    expect(guard('ddl', commented, commented.replace('where to', '   where   to'))).toEqual({ verified: true });
  });

  it('checks a source abaplint does not parse (BDEF) by its text, whitespace and case aside', () => {
    const bdef = 'managed implementation in class zbp_x unique;\ndefine behavior for ZR_X alias X\n{ create; update; }';
    const aligned = 'managed implementation in class zbp_x unique;\n\ndefine behavior for ZR_X alias X\n{\n  create;\n  update;\n}';
    expect(guard('ddl', bdef, aligned)).toEqual({ verified: true });
    expect(guard('ddl', bdef, aligned.replace('  update;\n', ''))).toMatchObject({ verified: false });
  });
});

describe('checkFormat, unparsedLines', () => {
  it('lists the lines of statements abaplint does not parse in the input, once each, ABAP only', () => {
    expect(checkFormat('abap', ABAP, FORMATTED).unparsedLines).toEqual([]);
    const broken = ABAP.replace('loop at it_nets', 'if x = .  loop at it_nets');
    expect(checkFormat('abap', broken, broken).unparsedLines).toEqual([8]);
    expect(checkFormat('ddl', 'anything', 'anything').unparsedLines).toEqual([]);
  });
});
