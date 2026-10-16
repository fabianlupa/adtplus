import { describe, expect, it, vi } from 'vitest';
import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { deleteTargetUri, resolveForWrite, resolveObject } from '../../src/core/resolve.js';

function fakeAdt(overrides: {
  resolveAffUri?: (...args: unknown[]) => unknown;
  readFile?: (...args: unknown[]) => unknown;
}): AdtLsClient {
  return {
    lifecycle: {
      resolveAffUri: overrides.resolveAffUri ?? vi.fn(async () => '/repotree/foo.json'),
    },
    repository: {
      readFile: overrides.readFile ?? vi.fn(async () => 'source content'),
    },
  } as unknown as AdtLsClient;
}

describe('resolveObject', () => {
  it('resolves and confirms with a read', async () => {
    const readFile = vi.fn(async () => 'source content');
    const adt = fakeAdt({ readFile });

    const ref = { name: 'ZCL_ADTPLUS_TEST', objectType: 'CLAS/OC' };
    const result = await resolveObject(adt, ref);

    expect(result).toEqual({ ...ref, uri: '/repotree/foo.json' });
    expect(readFile).toHaveBeenCalledWith('/repotree/foo.json');
  });

  it('rejects when the resolved URI cannot be read (stale search index)', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('404 not found');
    });
    const adt = fakeAdt({ readFile });

    await expect(
      resolveObject(adt, { name: 'ZI_DELETED', objectType: 'DDLS/DF' }),
    ).rejects.toThrow(/stale search index/);
  });

  it('propagates a resolveAffUri failure (object never existed)', async () => {
    const resolveAffUri = vi.fn(async () => {
      throw new Error('no search hit');
    });
    const adt = fakeAdt({ resolveAffUri });

    await expect(
      resolveObject(adt, { name: 'ZI_NOPE', objectType: 'DDLS/DF' }),
    ).rejects.toThrow('no search hit');
  });
});

// Real URIs from cloud-erp.
const FG = 'abap:/repotree-v1/cloud-erp-100/System%20Library/ZPARTNER/Source%20Code%20Library/Function%20Groups/ZADTPLUS_AP';

describe('deleteTargetUri', () => {
  it("sends a function group's delete to the group's metadata, not its main program's", () => {
    expect(deleteTargetUri('FUGR/F', `${FG}/zadtplus_ap.fugr.saplzadtplus_ap.reps.abap`)).toBe(`${FG}/zadtplus_ap.fugr.json`);
    expect(deleteTargetUri('fugr/f', `${FG}/zadtplus_ap.fugr.saplzadtplus_ap.reps.abap`)).toBe(`${FG}/zadtplus_ap.fugr.json`);
    expect(deleteTargetUri('FUGR/FF', `${FG}/zadtplus_ap.fugr.z_adtplus_ap_get.func.abap`)).toBe(`${FG}/zadtplus_ap.fugr.z_adtplus_ap_get.func.json`);
  });

  it('deletes a DDLX by its source and anything else by its metadata', () => {
    expect(deleteTargetUri('ddlx/ex', '/r/z.ddlx.acds')).toBe('/r/z.ddlx.acds');
    expect(deleteTargetUri('CLAS/OC', '/r/zcl_x.clas.abap')).toBe('/r/zcl_x.clas.json');
  });
});

describe('resolveForWrite', () => {
  it('reads the file a delete targets, so a fresh session can delete it', async () => {
    const main = `${FG}/zadtplus_ap.fugr.saplzadtplus_ap.reps.abap`;
    const readFile = vi.fn(async (..._args: unknown[]) => 'x');
    await resolveForWrite(fakeAdt({ resolveAffUri: vi.fn(async () => main), readFile }), { name: 'ZADTPLUS_AP', objectType: 'FUGR/F' });
    expect(readFile.mock.calls.map((c) => c[0])).toEqual([
      main,
      `${FG}/zadtplus_ap.fugr.saplzadtplus_ap.reps.json`,
      `${FG}/zadtplus_ap.fugr.json`,
    ]);
  });
});
