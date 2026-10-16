import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import { runApplication } from '../../src/capabilities/run.js';
import type { Destination } from '../../src/core/destinations.js';

/** Every ref resolves into package ZADTPLUS_TEST (core/placement.ts). */
const resolving = {
  lifecycle: {
    resolveAffUri: vi.fn(async (r: { name: string }) => `abap:/repotree-v1/adtplus_onprem/System%20Library/ZADTPLUS_TEST/Source%20Code%20Library/Classes/${r.name}/${r.name.toLowerCase()}.clas.abap`),
  },
  repository: { readFile: vi.fn(async () => 'source') },
};

function fakeAdt(): AdtLsClient {
  return {
    ...resolving,
    services: { runApplication: vi.fn(async () => ({ output: 'adt+ spike ok\n\n' })) },
  } as unknown as AdtLsClient;
}

const destination: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: ['ZADTPLUS_TEST'],
  allowRun: true,
};

describe('runApplication', () => {
  it.each([undefined, false])('refuses on a system with allowRun %j, naming the setting', async (allowRun) => {
    const adt = fakeAdt();
    await expect(
      runApplication(adt, { ...destination, allowRun }, { ref: { name: 'ZCL_X', objectType: 'CLAS/OC' }, confirm: true }),
    ).rejects.toThrow(/adt\+ system "onprem": run is off here\. It needs "allowRun": true/);
    expect(adt.services.runApplication).not.toHaveBeenCalled();
    expect(adt.lifecycle.resolveAffUri).not.toHaveBeenCalled();
  });

  it('refuses without confirm: true', async () => {
    const adt = fakeAdt();
    await expect(
      runApplication(adt, destination, { ref: { name: 'ZCL_X', objectType: 'CLAS/OC' } }),
    ).rejects.toThrow(/requires confirm: true/);
    expect(adt.services.runApplication).not.toHaveBeenCalled();
  });

  it('runs and returns console output when confirmed', async () => {
    const adt = fakeAdt();
    const result = await runApplication(adt, destination, {
      ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
      confirm: true,
    });
    expect(adt.services.runApplication).toHaveBeenCalledWith({ name: 'ZCL_X', objectType: 'CLAS/OC', uri: expect.any(String) });
    expect(result).toEqual({ output: 'adt+ spike ok\n\n' });
  });

  it('refuses a class outside the write allowlist before running it', async () => {
    const adt = fakeAdt();
    await expect(
      runApplication(adt, { ...destination, writeAllowlist: ['ZADTPLUS_OTHER'] }, { ref: { name: 'ZCL_X', objectType: 'CLAS/OC' }, confirm: true }),
    ).rejects.toThrow(/package "ZADTPLUS_TEST" is not in the write allowlist/);
    expect(adt.services.runApplication).not.toHaveBeenCalled();
  });
});
