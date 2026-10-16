import { describe, expect, it } from 'vitest';
import { parseFlags } from '../../src/cli/flags.js';

describe('parseFlags', () => {
  it('pairs values, and takes a flag followed by another flag as a switch', () => {
    expect(parseFlags(['--name', 'ZCL_X', '--active', '--max-lines', '5'])).toEqual({ name: 'ZCL_X', active: 'true', 'max-lines': '5' });
  });

  it('--flag=value takes the value as written, even one starting with --', () => {
    expect(parseFlags(['--grep=-- TODO', '--context=0', '--fields={"a":"b=c"}'])).toEqual({
      grep: '-- TODO',
      context: '0',
      fields: '{"a":"b=c"}',
    });
    // Without `=` such a value still reads as the next flag.
    expect(parseFlags(['--grep', '--x'])).toEqual({ grep: 'true', x: 'true' });
  });
});
