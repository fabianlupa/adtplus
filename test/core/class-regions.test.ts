import { describe, expect, it } from 'vitest';
import { classRegionProblem } from '../../src/core/class-regions.js';

const CLASS = [
  '* A: before the definition, the public section keeps it',
  'CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    " a comment in a section',
  '    METHODS a.',
  '    METHODS b.',
  'ENDCLASS.',
  '',
  'CLASS zcl_x IMPLEMENTATION.',
  '  METHOD a. " on the METHOD line',
  '    " in a method',
  "    DATA(text) = 'ENDCLASS.'.",
  '  ENDMETHOD. " on the ENDMETHOD line: the method include keeps it',
  '',
  '  METHOD b.',
  '  ENDMETHOD.',
  'ENDCLASS.',
  '',
].join('\r\n');

const lines = () => CLASS.split('\r\n');
/** CLASS with `line` inserted before its 0-based line `at`. */
const insert = (at: number, line: string) => {
  const l = lines();
  l.splice(at, 0, line);
  return l.join('\r\n');
};
/** CLASS with ` " eol` appended to its 0-based line `at`. */
const append = (at: number) => {
  const l = lines();
  l[at] += ' " eol';
  return l.join('\r\n');
};
const where = (text: string) => new RegExp(`^line \\d+: a comment ${text.replace(/[.*…]/g, '.')}`);

describe('classRegionProblem', () => {
  it('accepts comments before the definition, in sections and methods, and on METHOD and ENDMETHOD lines', () => {
    expect(classRegionProblem(CLASS)).toBeUndefined();
  });

  it.each([
    ['between the definition and the implementation', 8, '" B'],
    ['in the implementation outside a METHOD … ENDMETHOD', 9, '  " C: before the first METHOD'],
    ['in the implementation outside a METHOD … ENDMETHOD', 14, '  " D: between methods'],
    ['in the implementation outside a METHOD … ENDMETHOD', 16, '* E: before the last ENDCLASS'],
    ['after the last ENDCLASS', 17, '* F: after the last ENDCLASS'],
  ])('refuses a comment on a line of its own %s (before line %i)', (text, at, line) => {
    const problem = classRegionProblem(insert(at, line));
    expect(problem).toMatch(where(text));
    expect(problem).toMatch(new RegExp(`^line ${at + 1}:`));
  });

  it.each([
    ["the definition's ENDCLASS", 6, 'between the definition and the implementation'],
    ['CLASS … IMPLEMENTATION', 8, 'in the implementation outside a METHOD … ENDMETHOD'],
    ['the last ENDCLASS', 16, 'after the last ENDCLASS'],
  ])('refuses a comment on the line of %s (ONPREM stores it active, without an activation)', (_, at, text) => {
    expect(classRegionProblem(append(at))).toMatch(where(text));
  });

  it("lets a frame comment through that the system's text has in the same place, once", () => {
    const own = append(16);
    expect(classRegionProblem(own, own)).toBeUndefined();
    expect(classRegionProblem(insert(17, '* added'), own.replace(' " eol', ''))).toMatch(where('after the last ENDCLASS'));
    const twice = `${own}* again\r\n`;
    expect(classRegionProblem(twice, own)).toMatch(/^line 18: a comment after the last ENDCLASS/);
  });

  it("matches the system's comment by the comment, not the code before it on the line", () => {
    const system = CLASS.replace(/ENDCLASS\.\r\n$/, 'endclass. "generated\r\n');
    expect(classRegionProblem(CLASS.replace(/ENDCLASS\.\r\n$/, 'ENDCLASS.   "generated\r\n'), system)).toBeUndefined();
  });

  it('leaves statements and what it does not recognise to SAP', () => {
    expect(classRegionProblem(`${CLASS}DATA x TYPE i.\r\n`)).toBeUndefined();
    expect(classRegionProblem('INTERFACE zif_x PUBLIC.\nENDINTERFACE.\n* after\n')).toBeUndefined();
    expect(classRegionProblem('')).toBeUndefined();
  });
});
