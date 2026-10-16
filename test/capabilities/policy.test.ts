import { describe, expect, it, vi } from 'vitest';
import { assertObjectWritable, assertPackageWritable } from '../../src/capabilities/policy.js';
import type { Destination } from '../../src/core/destinations.js';

function dest(writeAllowlist: Destination['writeAllowlist']): Destination {
  return { id: 'onprem', kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://onprem.example', extraCaCerts: [], writeAllowlist };
}

describe('assertPackageWritable', () => {
  it('a plain entry covers that package only, without any lookup', async () => {
    const lookupChain = vi.fn(async () => ['ZADTPLUS_TEST', 'ZADTPLUS_AI_DEMO']);
    await expect(assertPackageWritable(dest(['ZADTPLUS_TEST']), 'zadtplus_test', { lookupChain })).resolves.toBeUndefined();
    await expect(assertPackageWritable(dest(['ZADTPLUS_TEST']), 'ZADTPLUS_AI_DEMO', { lookupChain })).rejects.toThrow(
      /package "ZADTPLUS_AI_DEMO" is not in the write allowlist \(ZADTPLUS_TEST\)/,
    );
    expect(lookupChain).not.toHaveBeenCalled();
  });

  it('a subpackages entry covers the whole subtree, looked up only when needed', async () => {
    const d = dest([{ package: 'ZADTPLUS_TEST', subpackages: true }]);
    const lookupChain = vi.fn(async (pkg: string) => ['ZALL', 'ZDEV_MAIN', 'ZADTPLUS_TEST', 'ZADTPLUS_TEST_A1', pkg]);
    await expect(assertPackageWritable(d, 'ZADTPLUS_ADT', { lookupChain })).resolves.toBeUndefined();
    await expect(assertPackageWritable(d, 'ZADTPLUS_TEST', { lookupChain })).resolves.toBeUndefined();
    expect(lookupChain).toHaveBeenCalledTimes(1);

    await expect(
      assertPackageWritable(d, 'ZADTPLUS_ADT_DIFF', { chain: ['ZPARTNER', 'ZADTPLUS_ADT_DIFF'] }),
    ).rejects.toThrow(/not in the write allowlist \(ZADTPLUS_TEST and its subpackages\)/);
  });

  it('fails closed when the chain cannot be looked up or is not given', async () => {
    const d = dest([{ package: 'ZADTPLUS_TEST', subpackages: true }]);
    await expect(
      assertPackageWritable(d, 'ZADTPLUS_X', { lookupChain: async () => { throw new Error('not found via search'); } }),
    ).rejects.toThrow(/cannot tell whether package "ZADTPLUS_X" is inside the write allowlist.*not found via search/);
    await expect(assertPackageWritable(d, 'ZADTPLUS_X')).rejects.toThrow(/not in the write allowlist/);
  });

  it('refuses everything on an empty allowlist', async () => {
    await expect(assertPackageWritable(dest([]), 'ZADTPLUS_TEST')).rejects.toThrow(/\(empty\)/);
  });
});

describe('assertObjectWritable', () => {
  const inPackage = (pkg: string) =>
    `abap:/repotree-v1/adtplus_onprem/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/${pkg}/Source%20Code%20Library/Classes/ZCL_X/zcl_x.clas.abap`;

  it('checks the package read off the resolved URI', async () => {
    const ref = { name: 'ZCL_X', objectType: 'CLAS/OC' };
    await expect(assertObjectWritable(dest(['ZADTPLUS_AI_DEMO']), { ...ref, uri: inPackage('ZADTPLUS_AI_DEMO') })).resolves.toBeUndefined();
    await expect(assertObjectWritable(dest(['ZADTPLUS_TEST']), { ...ref, uri: inPackage('ZADTPLUS_AI_DEMO') })).rejects.toThrow(
      /package "ZADTPLUS_AI_DEMO" is not in the write allowlist/,
    );
    await expect(
      assertObjectWritable(dest([{ package: 'ZADTPLUS_TEST', subpackages: true }]), { ...ref, uri: inPackage('ZADTPLUS_AI_DEMO') }),
    ).resolves.toBeUndefined();
  });

  it('refuses a $TMP object unless $TMP is listed', async () => {
    const uri = 'abap:/repotree-v1/adtplus_onprem/Local%20Objects%20%28%24TMP%29/DEVELOPER/Source%20Code%20Library/Classes/ZCL_X/zcl_x.clas.abap';
    const ref = { name: 'ZCL_X', objectType: 'CLAS/OC', uri };
    await expect(assertObjectWritable(dest([{ package: 'ZADTPLUS_TEST', subpackages: true }]), ref)).rejects.toThrow(/"\$TMP"/);
    await expect(assertObjectWritable(dest(['$TMP']), ref)).resolves.toBeUndefined();
  });

  it('refuses when the package cannot be read off the URI', async () => {
    await expect(
      assertObjectWritable(dest(['ZADTPLUS_TEST']), { name: 'ZCL_X', objectType: 'CLAS/OC', uri: '/repotree/ZCL_X.json' }),
    ).rejects.toThrow(/cannot tell which package CLAS\/OC "ZCL_X" is in/);
  });
});
