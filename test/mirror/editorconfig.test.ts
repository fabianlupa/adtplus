import { describe, expect, it } from 'vitest';
import { checkFormat } from '../../src/mirror/editorconfig.js';

const check = (name: string, text: string | Uint8Array) =>
  checkFormat(name, typeof text === 'string' ? Buffer.from(text, 'utf8') : text);
const rules = (name: string, text: string | Uint8Array) => check(name, text).map((f) => f.rule);

describe("AFF's .editorconfig rules", () => {
  it('passes a file as pull writes it', () => {
    expect(check('zcl_x.clas.abap', 'CLASS zcl_x DEFINITION.\nENDCLASS.\n')).toEqual([]);
    expect(check('zcl_x.clas.json', '{\n  "a": {\n    "b": 1\n  }\n}\n')).toEqual([]);
    expect(check('zcl_x.clas.texts.en.properties', '')).toEqual([]);
  });

  it('reports CR line endings, a missing final newline and trailing whitespace, at the first line', () => {
    expect(check('zi_x.ddls.acds', 'a\r\nb  \r\nc\r\nd ')).toEqual([
      { line: 1, rule: 'editorconfig_end_of_line', message: 'CR line ending: AFF wants LF (3 lines, first 1)' },
      { line: 4, rule: 'editorconfig_insert_final_newline', message: 'no final newline' },
      { line: 2, rule: 'editorconfig_trim_trailing_whitespace', message: 'trailing whitespace (2 lines, first 2)' },
    ]);
  });

  it('reports a BOM and invalid UTF-8', () => {
    expect(rules('x.bdef.abdl', Buffer.from('﻿managed;\n', 'utf8'))).toEqual(['editorconfig_charset']);
    expect(rules('x.bdef.abdl', new Uint8Array([0x61, 0xff, 0x0a]))).toEqual(['editorconfig_charset']);
  });

  it('wants .json indented in steps of two spaces', () => {
    expect(check('x.clas.json', '{\n   "a": 1,\n\t"b": 2\n}\n')).toEqual([
      { line: 2, rule: 'editorconfig_indent', message: 'indentation not in steps of 2 spaces (2 lines, first 2)' },
    ]);
    // Only .json: an ABAP file may indent as it likes.
    expect(check('x.clas.abap', '   x.\n')).toEqual([]);
  });

  it("skips what AFF's glob doesn't cover", () => {
    expect(check('zt.tabl.ddic', 'x  \r\ny')).toEqual([]);
    expect(check('zd.dtelde.jsonc', 'x  ')).toEqual([]);
  });
});
