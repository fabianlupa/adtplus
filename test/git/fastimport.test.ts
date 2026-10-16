import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { blobSha, ident, importStream, quotePath } from '../../src/git/fastimport.js';

describe('fast-import stream', () => {
  it('blobSha is git hash-object', () => {
    const data = Buffer.from('CLASS zcl_a DEFINITION.\nENDCLASS.\n');
    expect(blobSha(data)).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: data, encoding: 'utf8' }).trim());
  });

  it('quotes only paths fast-import would misread', () => {
    expect(quotePath('src/zadtplus_a/(dmo)x.clas.abap')).toBe('src/zadtplus_a/(dmo)x.clas.abap');
    expect(quotePath('src/a b')).toBe('src/a b');
    expect(quotePath('"src/x')).toBe('"\\"src/x"');
    expect(quotePath('src/a\nb')).toBe('"src/a\\nb"');
  });

  it('ident: seconds and the local zone offset', () => {
    const at = new Date('2026-10-07T08:00:00Z');
    expect(ident('ONPREM', 'adtplus@onprem.invalid', at)).toMatch(/^ONPREM <adtplus@onprem\.invalid> 1791360000 [+-]\d{4}$/);
  });

  it('without a commit: just done', () => {
    expect(Buffer.concat(importStream(undefined)).toString()).toBe('feature done\ndone\n');
  });

  it('a commit: from, then D lines, then M lines with byte lengths', () => {
    const text = Buffer.concat(
      importStream({
        ref: 'refs/adtplus/origin/heads/main',
        from: 'abc',
        author: 'ONPREM <adtplus@onprem.invalid> 1 +0000',
        message: 'ONPREM: ZADTPLUS_A at x\n',
        changes: [
          { op: 'D', path: 'src/zadtplus_a/gone.prog.abap' },
          { op: 'M', path: 'src/zadtplus_a/ä.prog.abap', data: Buffer.from('ä\n') },
        ],
      }),
    ).toString();
    expect(text).toBe(
      'feature done\ncommit refs/adtplus/origin/heads/main\n' +
        'author ONPREM <adtplus@onprem.invalid> 1 +0000\ncommitter ONPREM <adtplus@onprem.invalid> 1 +0000\n' +
        'data 24\nONPREM: ZADTPLUS_A at x\n\nfrom abc\nD src/zadtplus_a/gone.prog.abap\n' +
        'M 100644 inline src/zadtplus_a/ä.prog.abap\ndata 3\nä\n\n\ndone\n',
    );
  });
});
