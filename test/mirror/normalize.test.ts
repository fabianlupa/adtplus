import { describe, expect, it } from 'vitest';
import { contentHash, lineStyle, normalize, toLocal, toSystem } from '../../src/mirror/normalize.js';

describe('normalize', () => {
  it('turns CRLF into LF and drops one final newline', () => {
    expect(normalize('a\r\nb\r\n')).toBe('a\nb');
    expect(normalize('a\nb\n\n')).toBe('a\nb\n');
    expect(normalize('')).toBe('');
  });

  it('keeps trailing whitespace: it is content', () => {
    expect(normalize('a  \r\nb\t\r\n')).toBe('a  \nb\t');
  });
});

describe('contentHash', () => {
  it('is the same for CRLF and LF, with or without a final newline', () => {
    const h = contentHash('x\ny');
    expect(contentHash('x\r\ny')).toBe(h);
    expect(contentHash('x\r\ny\r\n')).toBe(h);
    expect(contentHash('x\ny\n')).toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when content differs, trailing whitespace included', () => {
    expect(contentHash('x \ny')).not.toBe(contentHash('x\ny'));
    expect(contentHash('x\ny\n\n')).not.toBe(contentHash('x\ny'));
  });
});

describe('toLocal', () => {
  it('writes LF with one final newline; empty stays empty', () => {
    expect(toLocal('a\r\nb')).toBe('a\nb\n');
    expect(toLocal('{\n  "a": 1\n}')).toBe('{\n  "a": 1\n}\n');
    expect(toLocal('a\n')).toBe('a\n');
    expect(toLocal('')).toBe('');
  });

  it('hashes like the text it came from', () => {
    for (const text of ['a\r\nb\r\n', '{"x":1}', '', 'p \t\r\n']) expect(contentHash(toLocal(text))).toBe(contentHash(text));
  });
});

describe('lineStyle and toSystem', () => {
  it("takes the system's majority line ending and its final newline", () => {
    expect(lineStyle('a\r\nb\r\nc\n', 'x.clas.abap')).toEqual({ eol: '\r\n', finalNewline: true });
    expect(lineStyle('{\n  "a": 1\n}', 'x.clas.json')).toEqual({ eol: '\n', finalNewline: false });
    expect(toSystem('a\nb\n', { eol: '\r\n', finalNewline: true })).toBe('a\r\nb\r\n');
    expect(toSystem('{\n}\n', { eol: '\n', finalNewline: false })).toBe('{\n}');
  });

  it("uses a file kind's default for a file without line endings (ADR-007)", () => {
    expect(lineStyle('', 'x.clas.abap')).toEqual({ eol: '\r\n', finalNewline: true });
    expect(lineStyle('', 'x.ddls.acds')).toEqual({ eol: '\r\n', finalNewline: true });
    expect(lineStyle('', 'x.bdef.abdl')).toEqual({ eol: '\n', finalNewline: false });
    expect(lineStyle('one line', 'x.clas.abap')).toEqual({ eol: '\r\n', finalNewline: false });
  });

  it('keeps trailing whitespace and an empty file empty', () => {
    expect(toSystem('a  \nb\n', { eol: '\r\n', finalNewline: false })).toBe('a  \r\nb');
    expect(toSystem('', { eol: '\r\n', finalNewline: true })).toBe('');
  });
});
