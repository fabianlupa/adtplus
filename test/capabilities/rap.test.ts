import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import * as rap from '../../src/capabilities/rap.js';
import type { Destination } from '../../src/core/destinations.js';

/** A federated tool's answer: the full JSON in `content[0].text`. */
const answer = (data: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });

const PKG_URI = 'abap:/repotree-v1/adtplus_onprem/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/ZADTPLUS_PARITY/zadtplus_parity.devck.jsonc';

function fakeAdt(tool: (name: string, args: Record<string, unknown>) => unknown, overrides: Record<string, unknown> = {}): AdtLsClient {
  return {
    health: vi.fn(() => ({ destination: 'adtplus_onprem' })),
    raw: { tool: vi.fn(async (name: string, args: Record<string, unknown>) => tool(name, args)) },
    lifecycle: { resolveAffUri: vi.fn(async () => PKG_URI) },
    repository: { readFile: vi.fn(async () => '') },
    ...overrides,
  } as unknown as AdtLsClient;
}

const destination: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: [{ package: 'ZADTPLUS_TEST', subpackages: true }],
  languageVersion: 'standard',
};

const PROPOSAL = {
  metadata: {},
  general: { referenceObjectName: 'ZADTP_PAR_TRIP', description: 'ZADTP_PAR_TRIP' },
  businessObject: { dataModelEntity: { cdsName: 'ZR_ADTP_PAR_TRIP' } },
};

const target = { generatorId: 'uiservice', packageName: 'zadtplus_parity', referencedObject: { name: 'zadtp_par_trip', objectType: 'TABL/DT' } };

describe('rap capability', () => {
  it('listGenerators splits the referenced types and strips the HTML', async () => {
    const adt = fakeAdt(() =>
      answer({ generators: [{ id: 'uiservice', title: 'OData UI Service', referencedObjectTypes: 'TABL;BDEF', description: '<p>Creates</p> <li>CDS view</li>' }] }),
    );
    expect(await rap.listGenerators(adt)).toEqual({
      generators: [{ id: 'uiservice', title: 'OData UI Service', referencedObjectTypes: ['TABL', 'BDEF'], description: 'Creates\n- CDS view' }],
    });
  });

  it('generatorSchema sends the main type, upper case, and fills the package into the proposal', async () => {
    const adt = fakeAdt(() => answer({ schema: { title: 'RAP Layers' }, referenceContent: PROPOSAL }));
    const res = await rap.generatorSchema(adt, target);
    expect(adt.raw.tool).toHaveBeenCalledWith('abap_generators-get_schema', {
      destination: 'adtplus_onprem',
      generatorId: 'uiservice',
      packageName: 'ZADTPLUS_PARITY',
      referencedObjectType: 'TABL',
      referencedObjectName: 'ZADTP_PAR_TRIP',
    });
    expect(res.content.metadata).toEqual({ package: 'ZADTPLUS_PARITY' });
  });

  it('generatorSchema turns an "Error:" text into an error', async () => {
    const adt = fakeAdt(() => answer('Error: referencedObjectType is not valid. Expected one of: TABL'));
    await expect(rap.generatorSchema(adt, { generatorId: 'uiservice', packageName: 'ZADTPLUS_PARITY' })).rejects.toThrow(
      /generator schema: referencedObjectType is not valid/,
    );
  });

  it('generate refuses a package outside the allowlist before any generator call', async () => {
    const adt = fakeAdt(() => answer({}), {
      lifecycle: { resolveAffUri: vi.fn(async () => 'abap:/repotree-v1/adtplus_onprem/System%20Library/ZOTHER/zother.devck.jsonc') },
    });
    await expect(rap.generate(adt, destination, { ...target, packageName: 'ZOTHER' })).rejects.toThrow(/not in the write allowlist/);
    expect(adt.raw.tool).not.toHaveBeenCalled();
  });

  it('generate takes the proposal when no content is given and lists the objects', async () => {
    const adt = fakeAdt((name) =>
      name === 'abap_generators-get_schema'
        ? answer({ schema: {}, referenceContent: PROPOSAL })
        : answer({ validationMessages: [], generatedObjects: [{ objectType: 'DDLS/DF', objectName: 'ZR_ADTP_PAR_TRIP' }] }),
    );
    const res = await rap.generate(adt, destination, { ...target, transport: 'DEVK901733' });
    expect(res.generatedObjects).toEqual([{ name: 'ZR_ADTP_PAR_TRIP', objectType: 'DDLS/DF' }]);
    const call = vi.mocked(adt.raw.tool).mock.calls.find(([n]) => n === 'abap_generators-generate_objects')!;
    expect(call[1]).toMatchObject({ transportRequestNumber: 'DEVK901733', packageName: 'ZADTPLUS_PARITY' });
    expect(JSON.parse(call[1]!.content as string).metadata).toEqual({ package: 'ZADTPLUS_PARITY' });
  });

  it('generate fails on validation messages with nothing generated (an existing name)', async () => {
    const adt = fakeAdt(() =>
      answer({ validationMessages: [{ 'Error:': 'ZADTP_PAR_TRIP_D already exists; choose a different name.' }], generatedObjects: [] }),
    );
    await expect(rap.generate(adt, destination, { ...target, content: PROPOSAL })).rejects.toThrow(/created nothing: ZADTP_PAR_TRIP_D already exists/);
  });

  it('generate refuses content whose metadata.package differs from the checked packageName', async () => {
    const adt = fakeAdt(() => answer({ generatedObjects: [{ objectType: 'DDLS/DF', objectName: 'ZR_X' }] }));
    await expect(rap.generate(adt, destination, { ...target, content: { ...PROPOSAL, metadata: { package: 'ZPROD' } } })).rejects.toThrow(
      /metadata.package "ZPROD" differs from package "ZADTPLUS_PARITY"/,
    );
    expect(vi.mocked(adt.raw.tool).mock.calls.map(([n]) => n)).not.toContain('abap_generators-generate_objects');
  });

  it('serviceInfo of an unpublished V4 binding notes it instead of failing', async () => {
    const getServiceInfo = vi.fn();
    const adt = fakeAdt(() => answer({}), {
      services: { listServices: vi.fn(async () => ({ odataVersion: 'V4', isPublished: false, services: [] })), getServiceInfo },
    });
    const res = await rap.serviceInfo(adt, { name: 'ZUI_X_O4', objectType: 'SRVB/SVB' });
    expect(res.serviceInfo).toBeNull();
    expect(res.notes[0]).toMatch(/not published/);
    expect(getServiceInfo).not.toHaveBeenCalled();
  });

  it('serviceInfo of a published binding adds URL and entity sets', async () => {
    const info = { serviceUrl: 'https://onprem.example/sap/opu/odata/sap/Z01_SB_TRAVEL', entitySets: [{ name: 'Travel', navigations: [] }] };
    const adt = fakeAdt(() => answer({}), {
      services: { listServices: vi.fn(async () => ({ odataVersion: 'V2', services: [] })), getServiceInfo: vi.fn(async () => info) },
    });
    expect((await rap.serviceInfo(adt, { name: 'Z01_SB_TRAVEL', objectType: 'SRVB/SVB' })).serviceInfo).toEqual(info);
  });
});
