import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serve, type Session } from '../../src/git/protocol.js';

/** Run the loop over `input` and return what the helper wrote. */
async function talk(input: string, session: Partial<Session> = {}): Promise<{ out: string; imports: string[][]; pushes: string[][]; options: string[] }> {
  const imports: string[][] = [];
  const pushes: string[][] = [];
  const options: string[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(c));
  stdin.end(input);
  await serve(stdin, stdout, {
    remote: 'origin',
    tip: async () => 'f'.repeat(40),
    importRefs: async (refs) => {
      imports.push(refs);
      return [Buffer.from('feature done\n'), Buffer.from('done\n')];
    },
    pushRefs: async (specs) => {
      pushes.push(specs);
      return specs.map((s) => (s.startsWith('+') ? `error ${s.split(':')[1]} force refused` : `ok ${s.split(':')[1]}`));
    },
    option: (name, value) => {
      options.push(`${name}=${value}`);
      return name === 'verbosity';
    },
    ...session,
  });
  return { out: Buffer.concat(chunks).toString(), imports, pushes, options };
}

describe('remote-helper protocol', () => {
  it('capabilities: import, push, the private refspec, options', async () => {
    expect((await talk('capabilities\n\n')).out).toBe('import\npush\nrefspec refs/heads/*:refs/adtplus/origin/heads/*\noption\n\n');
  });

  it('a push batch: one answer per spec, then a blank line', async () => {
    const { out, pushes } = await talk('push refs/heads/main:refs/heads/main\npush +HEAD:refs/heads/main\n\n\n');
    expect(pushes).toEqual([['refs/heads/main:refs/heads/main', '+HEAD:refs/heads/main']]);
    expect(out).toBe('ok refs/heads/main\nerror refs/heads/main force refused\n\n');
  });

  it('list: main as `?` for a fetch, the private tip for a push (P1)', async () => {
    expect((await talk('list\n')).out).toBe('? refs/heads/main\n@refs/heads/main HEAD\n\n');
    expect((await talk('list for-push\n')).out).toBe(`${'f'.repeat(40)} refs/heads/main\n@refs/heads/main HEAD\n\n`);
    expect((await talk('list for-push\n', { tip: async () => undefined })).out).toBe('? refs/heads/main\n@refs/heads/main HEAD\n\n');
  });

  it('options answer ok or unsupported, value with spaces kept', async () => {
    const { out, options } = await talk('option verbosity 1\noption push-option a b\n');
    expect(out).toBe('ok\nunsupported\n');
    expect(options).toEqual(['verbosity=1', 'push-option=a b']);
  });

  it("a clone's import batch names main twice: one import", async () => {
    const { out, imports } = await talk('option cloning true\nimport refs/heads/main\nimport refs/heads/main\n\n\n');
    expect(imports).toEqual([['refs/heads/main']]);
    expect(out).toBe('unsupported\nfeature done\ndone\n');
  });

  it('a blank line or the end of input ends the session; an unknown command fails', async () => {
    expect((await talk('\nlist\n')).out).toBe('');
    expect((await talk('')).out).toBe('');
    await expect(talk('export\n')).rejects.toThrow('git sent an unknown command "export"');
  });

  it('a failed command lets go of stdin, so the helper can exit while git keeps it open', async () => {
    const stdin = new PassThrough();
    stdin.write('import refs/heads/main\n\n');
    const session: Session = {
      remote: 'origin',
      tip: async () => undefined,
      importRefs: async () => {
        throw new Error('package ZADTPLUS_NOPE not found on onprem');
      },
      pushRefs: async () => [],
      option: () => false,
    };
    await expect(serve(stdin, new PassThrough(), session)).rejects.toThrow('not found');
    expect(stdin.isPaused()).toBe(true);
  });
});
