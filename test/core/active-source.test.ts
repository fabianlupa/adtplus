import type { AdtLsClient, SourceVersion } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import { readActiveIncludes } from '../../src/core/active-source.js';
import { ThrottledError } from '../../src/daemon/ratelimit.js';

const MAIN = 'abap:/repotree-v1/adtplus_onprem/System%20Library/ZADTPLUS_TEST/Source%20Code%20Library/Classes/ZCL_X/zcl_x.clas.abap';
const REF = { name: 'ZCL_X', objectType: 'CLAS/OC' };

const includeOf = (uri: string) => uri.match(/\.clas\.(\w+)\.abap$/)?.[1] ?? 'main';

/**
 * A fake SDK session. `drafts` names the includes with a draft of the
 * logged-on user (versions are per file); `missing` the ones the class lacks.
 */
function fakeAdtLs(opts: { drafts: string[]; missing?: string[]; failRead?: string[] }) {
  const missing = new Set(opts.missing ?? []);
  const adt = {
    lifecycle: { resolveAffUri: vi.fn(async () => MAIN) },
    repository: {
      // The SDK's answer for a file the folder doesn't list.
      abapStat: vi.fn(async (uri: string): Promise<SourceVersion> => {
        const include = includeOf(uri);
        if (missing.has(include)) throw new Error(`abapStat returned no version for ${uri}`);
        return opts.drafts.includes(include) ? 'inactive' : 'active';
      }),
      readDirectory: vi.fn(async () =>
        ['main', 'definitions', 'implementations', 'macros', 'testclasses']
          .filter((include) => !missing.has(include))
          .map((include) => ({ name: include === 'main' ? 'zcl_x.clas.abap' : `zcl_x.clas.${include}.abap`, kind: 'file' })),
      ),
    },
    source: {
      read: vi.fn(async (args: { include?: string; version?: SourceVersion; uri?: string }) => {
        const include = args.include ?? 'main';
        if (opts.failRead?.includes(include)) throw new Error('served version changed');
        return `${args.version === 'active' ? 'ACTIVE' : 'DRAFT'} ${include}`;
      }),
    },
  } as unknown as AdtLsClient;
  return adt;
}

describe('readActiveIncludes', () => {
  it('without an own draft in any include reads nothing: the served version is the active one', async () => {
    const adt = fakeAdtLs({ drafts: [], missing: ['macros'] });
    await expect(readActiveIncludes(adt, REF, [undefined, 'testclasses', 'macros'])).resolves.toEqual({
      sameAsServed: true,
    });
    expect(adt.repository.abapStat).toHaveBeenCalledTimes(3);
    // Listed once, for the failed stat: the folder has no macros, so it is missing.
    expect(adt.repository.readDirectory).toHaveBeenCalledTimes(1);
    expect(adt.source.read).not.toHaveBeenCalled();
  });

  it('a draft in one include only: the main source being active does not hide it', async () => {
    const adt = fakeAdtLs({ drafts: ['testclasses'] });
    const res = await readActiveIncludes(adt, REF, [undefined, 'testclasses']);
    expect(res).toEqual({ texts: new Map([['main', 'ACTIVE main'], ['testclasses', 'ACTIVE testclasses']]), errors: new Map() });
  });

  it('reads each existing include active, by the resolved URI, skipping ones the class lacks', async () => {
    const adt = fakeAdtLs({ drafts: ['main'], missing: ['macros'] });
    const res = await readActiveIncludes(adt, REF, [undefined, 'testclasses', 'macros']);
    expect(res).toEqual({ texts: new Map([['main', 'ACTIVE main'], ['testclasses', 'ACTIVE testclasses']]), errors: new Map() });
    expect(adt.lifecycle.resolveAffUri).toHaveBeenCalledTimes(1);
    for (const [args] of vi.mocked(adt.source.read).mock.calls) {
      expect(args).toMatchObject({ uri: MAIN, version: 'active' });
    }
  });

  it('uses a URI the caller resolved instead of resolving again', async () => {
    const adt = fakeAdtLs({ drafts: ['main'] });
    await readActiveIncludes(adt, { ...REF, uri: MAIN }, [undefined]);
    expect(adt.lifecycle.resolveAffUri).not.toHaveBeenCalled();
  });

  it('an include whose active read fails is missing, not draft text, and keeps its error', async () => {
    const adt = fakeAdtLs({ drafts: ['main'], failRead: ['main'] });
    await expect(readActiveIncludes(adt, REF, [undefined, 'testclasses'])).resolves.toEqual({
      texts: new Map([['testclasses', 'ACTIVE testclasses']]),
      errors: new Map([['main', expect.any(String)]]),
    });
  });

  it('a cooldown on a stat fails the read instead of counting the include as missing', async () => {
    const adt = fakeAdtLs({ drafts: ['testclasses'] });
    vi.mocked(adt.repository.abapStat).mockImplementation(async (uri: string) => {
      if (includeOf(uri) === 'testclasses') throw new ThrottledError('throttled', 5000);
      return 'active';
    });
    await expect(readActiveIncludes(adt, REF, [undefined, 'testclasses'])).rejects.toBeInstanceOf(ThrottledError);
  });

  it('a cooldown on an active read fails the read, after the other reads have finished', async () => {
    const adt = fakeAdtLs({ drafts: ['main'] });
    let slowDone = false;
    vi.mocked(adt.source.read).mockImplementation(async (args: { include?: string }) => {
      if (args.include === undefined) throw new ThrottledError('throttled', 5000);
      await new Promise((r) => setTimeout(r, 20));
      slowDone = true;
      return 'ACTIVE testclasses';
    });
    await expect(readActiveIncludes(adt, REF, [undefined, 'testclasses'])).rejects.toBeInstanceOf(ThrottledError);
    expect(slowDone).toBe(true);
  });

  it('an active read that throws synchronously is an unreadable include, not an escaped error', async () => {
    const adt = fakeAdtLs({ drafts: ['main'] });
    vi.mocked(adt.source.read).mockImplementation(((args: { include?: string }) => {
      if (args.include === undefined) throw new Error('bad arguments');
      return Promise.resolve('ACTIVE testclasses');
    }) as typeof adt.source.read);
    await expect(readActiveIncludes(adt, REF, [undefined, 'testclasses'])).resolves.toEqual({
      texts: new Map([['testclasses', 'ACTIVE testclasses']]),
      errors: new Map([['main', 'bad arguments']]),
    });
  });

  it('a failed stat on an include the folder lists fails the read instead of counting it as missing', async () => {
    const adt = fakeAdtLs({ drafts: ['testclasses'] });
    vi.mocked(adt.repository.abapStat).mockImplementation(async (uri: string) => {
      if (includeOf(uri) === 'testclasses') throw new Error('HTTP 503');
      return 'active';
    });
    await expect(readActiveIncludes(adt, REF, [undefined, 'testclasses'])).rejects.toThrow('HTTP 503');
  });

  it('names the include when the class has none of those asked for', async () => {
    const adt = fakeAdtLs({ drafts: [], missing: ['testclasses'] });
    await expect(readActiveIncludes(adt, REF, ['testclasses'])).rejects.toThrow('ZCL_X has no include testclasses');
  });

  it("lists the folder only when a stat fails, and a stat that answers counts even if the listing doesn't show the file", async () => {
    const adt = fakeAdtLs({ drafts: ['testclasses'] });
    // A stale listing without the include that holds the draft.
    vi.mocked(adt.repository.readDirectory).mockResolvedValue([{ name: 'zcl_x.clas.abap', kind: 'file' }] as never);
    const res = await readActiveIncludes(adt, REF, [undefined, 'testclasses']);
    expect(res).toEqual({ texts: new Map([['main', 'ACTIVE main'], ['testclasses', 'ACTIVE testclasses']]), errors: new Map() });
    expect(adt.repository.readDirectory).not.toHaveBeenCalled();
  });
});
