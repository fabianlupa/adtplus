import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import * as object from '../../src/capabilities/object.js';
import type { Destination } from '../../src/core/destinations.js';

/** A realistic repotree prefix: objects below it sit in package ZADTPLUS_TEST (core/placement.ts). */
const R = 'abap:/repotree-v1/adtplus_onprem/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/Source%20Code%20Library/Classes';

function fakeAdt(overrides: Record<string, unknown> = {}): AdtLsClient {
  return {
    health: vi.fn(() => ({ connected: true, backendLive: true, destination: 'adtplus_onprem', mcpPort: 1234 })),
    lifecycle: {
      resolveAffUri: vi.fn(async (ref: { name: string }) => `${R}/${ref.name}/${ref.name.toLowerCase()}.json`),
      create: vi.fn(async () => ({ message: 'created' })),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    repository: {
      readFile: vi.fn(async () => 'source'),
      listInactive: vi.fn(async () => []),
      abapStat: vi.fn(async () => 'active'),
      delete: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      search: vi.fn(async () => ({ references: [] })),
      getLsUri: vi.fn(async (adtUri: string) => adtUri),
    },
    transport: {
      getLockStatus: vi.fn(async () => ({ lockingSupported: true, lockId: null })),
    },
    raw: {
      lsp: vi.fn(async () => ({
        isCheckExecuted: true,
        isActivationExecuted: true,
        isGenerationExecuted: false,
        objectDiagnostics: [],
        refreshFileUris: [`${R}/ZCL_X.json`],
      })),
    },
    ...overrides,
  } as unknown as AdtLsClient;
}

/** A fake that resolves to a realistic class AFF source URI (`…/zcl_x.clas.abap`). */
function clasAdt(): AdtLsClient {
  return fakeAdt({
    lifecycle: {
      resolveAffUri: vi.fn(async (ref: { name: string }) => `${R}/${ref.name}/${ref.name.toLowerCase()}.clas.abap`),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
  });
}

const destination: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: ['ZADTPLUS_TEST'],
};

describe('object capability', () => {
  it('create refuses a package outside the write allowlist', async () => {
    const adt = fakeAdt();
    await expect(
      object.create(adt, destination, {
        name: 'ZCL_X',
        objectType: 'CLAS/OC',
        packageName: 'ZNOT_ALLOWED',
        description: 'x',
      }),
    ).rejects.toThrow(/not in the write allowlist/);
    expect(adt.lifecycle.create).not.toHaveBeenCalled();
  });

  // The ONPREM creation forms as `getObjectTypeDetails` returned them.
  const BDEF_FORM = [
    { tag: 'behaviorDefinitionType', required: true, values: ['definition', 'extension'] },
    { tag: 'packageName', required: true },
    { tag: 'rootEntity', required: true },
    { tag: 'name', required: true, maxLength: 30 },
    { tag: 'description', required: true },
    { tag: 'implementationType', values: ['Managed', 'Unmanaged', 'Projection', 'Abstract', 'Interface'] },
  ];
  const SRVD_FORM = [
    { tag: 'packageName', required: true },
    { tag: 'name', required: true, maxLength: 30 },
    { tag: 'description', required: true },
    { tag: 'sourceType', values: ['S', 'X', 'none'] },
    { tag: 'referencedObject' },
  ];
  const TABL_FORM = [{ tag: 'packageName', required: true }, { tag: 'name', required: true, maxLength: 16 }, { tag: 'description', required: true }];

  it('updateSource refuses an include adt-ls cannot write, before resolving anything', async () => {
    const adt = clasAdt();
    await expect(object.updateSource(adt, destination, { name: 'ZBP_X', objectType: 'CLAS/OC', source: 's', include: 'locals_imp' })).rejects.toThrow(
      /abapGit's locals_imp is "implementations"\. Valid: definitions, implementations, macros, testclasses/,
    );
    await expect(object.updateSource(adt, destination, { name: 'ZI_X', objectType: 'DDLS/DF', source: 's', include: 'definitions' })).rejects.toThrow(/only classes have includes/);
    expect(adt.lifecycle.resolveAffUri).not.toHaveBeenCalled();
    expect(object.checkInclude('CLAS/OC', 'implementations')).toBeUndefined();
    expect(object.checkInclude('CLAS/OC', undefined)).toBeUndefined();
  });

  describe('creation fields', () => {
    it('passes the fields the green runs succeeded with', () => {
      const bdef = { behaviorDefinitionType: 'definition', rootEntity: 'ZADTPLUS_R_TRIPTP', implementationType: 'Managed' };
      expect(object.checkCreationFields('BDEF/BDO', 'ZADTPLUS_R_TRIPTP', BDEF_FORM, bdef)).toBeUndefined();
      expect(object.checkCreationFields('SRVD/SRV', 'ZADTPLUS_TRIP', SRVD_FORM, { sourceType: 'S' })).toBeUndefined();
      expect(object.checkCreationFields('TABL/DT', 'ZADTPLUS_TRIP', TABL_FORM)).toBeUndefined();
    });

    it('refuses the green runs\' guesses, naming every field and value', () => {
      const wrongCase = object.checkCreationFields('BDEF/BDO', 'ZMB_R_TRIPTP', BDEF_FORM, {
        implementationType: 'MANAGED',
        rootEntityName: 'ZMB_R_TRIPTP',
      })!;
      expect(wrongCase).toContain('unknown field "rootEntityName"');
      expect(wrongCase).toContain('"behaviorDefinitionType" is missing');
      expect(wrongCase).toContain('"rootEntity" is missing');
      expect(wrongCase).toContain('"implementationType": "MANAGED" is not one of "Managed", "Unmanaged"');
      expect(wrongCase).toContain('additionalFields for BDEF/BDO: behaviorDefinitionType (required: "definition" | "extension"); rootEntity (required);');
      expect(object.checkCreationFields('SRVD/SRV', 'ZMB_TRIP', SRVD_FORM, { sourceType: 'definition' })).toContain('"sourceType": "definition" is not one of "S", "X", "none"');
      // The form marks sourceType optional; the backend refuses without it.
      expect(object.checkCreationFields('SRVD/SRV', 'ZMB_TRIP', SRVD_FORM)).toContain('"sourceType" is missing');
      expect(object.checkCreationFields('TABL/DT', 'ZADTPLUS_MB_TRIP_TABLE', TABL_FORM)).toContain('at most 16');
    });

    it('create refuses before calling SAP, reads each form once, and fails open without one', async () => {
      const getObjectTypeDetails = vi.fn(async () => ({ fields: SRVD_FORM }));
      const adt = fakeAdt();
      Object.assign(adt.lifecycle, { getObjectTypeDetails });
      const input = { name: 'ZADTPLUS_TRIP', objectType: 'SRVD/SRV', packageName: 'ZADTPLUS_TEST', description: 'x' };
      await expect(object.create(adt, destination, { ...input, additionalFields: { sourceType: 'CDS' } })).rejects.toThrow(/"sourceType": "CDS" is not one of/);
      expect(adt.lifecycle.create).not.toHaveBeenCalled();
      await object.create(adt, destination, { ...input, additionalFields: { sourceType: 'S' } });
      expect(adt.lifecycle.create).toHaveBeenCalledTimes(1);
      expect(getObjectTypeDetails).toHaveBeenCalledTimes(1);

      const noForm = fakeAdt();
      Object.assign(noForm.lifecycle, { getObjectTypeDetails: vi.fn(async () => { throw new Error('no form'); }) });
      await object.create(noForm, destination, { ...input, additionalFields: { anything: 1 } });
      expect(noForm.lifecycle.create).toHaveBeenCalled();
    });

    it('asks for a form again after a failed read, instead of checking nothing for the rest of the session', async () => {
      const getObjectTypeDetails = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({ fields: SRVD_FORM });
      const adt = fakeAdt();
      Object.assign(adt.lifecycle, { getObjectTypeDetails });
      const input = { name: 'ZADTPLUS_TRIP', objectType: 'SRVD/SRV', packageName: 'ZADTPLUS_TEST', description: 'x' };
      await object.create(adt, destination, { ...input, additionalFields: { sourceType: 'CDS' } });
      await expect(object.create(adt, destination, { ...input, additionalFields: { sourceType: 'CDS' } })).rejects.toThrow(/is not one of/);
      expect(getObjectTypeDetails).toHaveBeenCalledTimes(2);
    });
  });

  it('activateBatch refuses more than 50 refs before resolving any (ADR-005, bounded fan-out)', async () => {
    const adt = fakeAdt();
    const refs = Array.from({ length: 51 }, (_, i) => ({ name: `ZCL_X${i}`, objectType: 'CLAS/OC' }));
    await expect(object.activateBatch(adt, destination, { refs })).rejects.toThrow(
      /activate takes at most 50 objects per call, got 51; split the batch/,
    );
    expect(adt.lifecycle.resolveAffUri).not.toHaveBeenCalled();
    expect(adt.raw.lsp).not.toHaveBeenCalled();
  });

  describe('activateBatch with a REST lane', () => {
    const done = { checkExecuted: true, activationExecuted: true, generationExecuted: false, diagnostics: [], refreshedUris: [] };
    const domain = { name: 'ZADTPLUS_DOM', objectType: 'DOMA/DD' };

    it('refuses no objects, an object without its type, and forceActivation for the lane, before any call', async () => {
      const adt = fakeAdt();
      const gate = vi.fn();
      await expect(object.activateBatch(adt, destination, { refs: [] })).rejects.toThrow(/needs at least one object/);
      await expect(object.activateBatch(adt, destination, { refs: [{ name: 'ZCL_X' } as never] })).rejects.toThrow(/needs "name" and "objectType"/);
      await expect(
        object.activateBatch(adt, destination, { refs: [], forceActivation: true, rest: { refs: [domain], label: 'domains (DOMA)', gate } }),
      ).rejects.toThrow(/forceActivation is not available for domains \(DOMA\)/);
      expect(gate).not.toHaveBeenCalled();
      expect(adt.raw.lsp).not.toHaveBeenCalled();
    });

    it('gates every object before activating any: a refused adt-ls object stops the lane too', async () => {
      const adt = fakeAdt();
      const activateLane = vi.fn(async () => done);
      const rest = { refs: [domain], label: 'domains (DOMA)', gate: vi.fn(async () => activateLane) };
      const outside = { ...destination, writeAllowlist: ['ZOTHER'] };
      await expect(object.activateBatch(adt, outside, { refs: [{ name: 'ZCL_X', objectType: 'CLAS/OC' }], rest })).rejects.toThrow(/write allowlist/);
      expect(rest.gate).toHaveBeenCalled();
      expect(activateLane).not.toHaveBeenCalled();
      expect(adt.raw.lsp).not.toHaveBeenCalled();
    });

    it('activates the lane first, then the rest, one answer; a lane alone needs no adt-ls', async () => {
      const adt = fakeAdt();
      const order: string[] = [];
      const activateLane = vi.fn(async () => (order.push('rest'), { ...done, diagnostics: [{ object: 'DOMA ZADTPLUS_DOM' }] }));
      vi.mocked(adt.raw.lsp).mockImplementation(async () => (order.push('adt-ls'), { isCheckExecuted: true, isActivationExecuted: true, isGenerationExecuted: true, refreshFileUris: ['u'] }));
      const rest = { refs: [domain], label: 'domains (DOMA)', gate: async () => activateLane };
      const result = await object.activateBatch(adt, destination, { refs: [{ name: 'ZCL_X', objectType: 'CLAS/OC' }], rest });
      expect(order).toEqual(['rest', 'adt-ls']);
      expect(result).toEqual({ checkExecuted: true, activationExecuted: true, generationExecuted: false, diagnostics: [{ object: 'DOMA ZADTPLUS_DOM' }], refreshedUris: ['u'] });

      const client = vi.fn(async () => adt);
      expect(await object.activateBatch(client, destination, { refs: [], rest })).toMatchObject({ activationExecuted: true });
      expect(client).not.toHaveBeenCalled();
    });
  });

  it('activateBatch resolves each ref and sends one raw activation/activate call', async () => {
    const adt = fakeAdt();
    const result = await object.activateBatch(adt, destination, {
      refs: [
        { name: 'ZIF_X', objectType: 'INTF/OI' },
        { name: 'ZCL_X', objectType: 'CLAS/OC' },
      ],
    });

    expect(adt.raw.lsp).toHaveBeenCalledWith('adtLs/activation/activate', {
      destination: 'adtplus_onprem',
      fileUris: [`${R}/ZIF_X/zif_x.json`, `${R}/ZCL_X/zcl_x.json`],
      references: [],
      forceActivation: false,
    });
    expect(result).toEqual({
      checkExecuted: true,
      activationExecuted: true,
      generationExecuted: false,
      diagnostics: [],
      refreshedUris: [`${R}/ZCL_X.json`],
    });
  });

  it('updateSource refuses a comment in the class frame before any write, unless the system has it already', async () => {
    const adt = clasAdt();
    const plain = 'CLASS zcl_x DEFINITION PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\nENDCLASS.\n';
    vi.mocked(adt.repository.readFile).mockResolvedValue(plain);
    await expect(
      object.updateSource(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', source: `${plain}* trailing\n` }),
    ).rejects.toThrow(/^ZCL_X not written: line 6: a comment after the last ENDCLASS/);
    expect(adt.lifecycle.update).not.toHaveBeenCalled();
    // The system serves the class with that comment (ONPREM keeps one there): written back as it is.
    vi.mocked(adt.repository.readFile).mockResolvedValue(`${plain}* trailing\n`);
    await object.updateSource(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', source: `${plain}* trailing\n` });
    // An include is its own file: the check doesn't apply.
    await object.updateSource(adt, destination, { name: 'ZCL_X', objectType: 'CLAS/OC', include: 'implementations', source: '* local\n' });
    expect(adt.lifecycle.update).toHaveBeenCalledTimes(2);
  });

  describe('activateBatch when nothing was activated', () => {
    const refs = [
      { name: 'ZR_X', objectType: 'BDEF/BDO' },
      { name: 'ZBP_X', objectType: 'CLAS/OC' },
    ];
    const answer = (flags: { check: boolean; activation: boolean; generation: boolean }, objectDiagnostics: unknown[] = []) =>
      vi.fn(async () => ({
        isCheckExecuted: flags.check,
        isActivationExecuted: flags.activation,
        isGenerationExecuted: flags.generation,
        objectDiagnostics,
        refreshFileUris: [],
      }));

    it.each([
      ['cloud: all three flags false', { check: false, activation: false, generation: false }],
      ['ONPREM: only generation', { check: false, activation: false, generation: true }],
    ])('is an error naming the objects and the unsaved-editor cause (%s)', async (_, flags) => {
      const adt = fakeAdt({ raw: { lsp: answer(flags) } });
      await expect(object.activateBatch(adt, destination, { refs })).rejects.toThrow(
        'nothing activated: there is no inactive version of ZR_X (BDEF/BDO), ZBP_X (CLAS/OC); what is stored is already active. ' +
          'If you wrote it with `update` (or the mirror), that text is active now, or it equalled the active one: nothing ' +
          'more to do, do not write again. A change made in an editor (an abap: file) is stored only once the editor is saved',
      );
      expect(adt.repository.abapStat).toHaveBeenCalledTimes(2);
    });

    it('takes an answer without objectDiagnostics as none', async () => {
      const adt = fakeAdt({ raw: { lsp: vi.fn(async () => ({ isCheckExecuted: false, isActivationExecuted: false, isGenerationExecuted: false })) } });
      await expect(object.activateBatch(adt, destination, { refs })).rejects.toThrow(/^nothing activated: there is no inactive version/);
    });

    it('names the objects still served inactive when adt-ls gives no reason', async () => {
      const adt = fakeAdt({ raw: { lsp: answer({ check: false, activation: false, generation: false }) } });
      vi.mocked(adt.repository.abapStat)
        .mockResolvedValueOnce('active')
        .mockRejectedValueOnce(new Error('stat failed'));
      await expect(object.activateBatch(adt, destination, { refs })).rejects.toThrow(
        'nothing activated: adt-ls ran neither the check nor the activation and gave no reason; not served active: ZBP_X (CLAS/OC).',
      );
    });

    it('returns the diagnostics of a check that refused the activation', async () => {
      const diagnostics = [{ fileUri: `${R}/ZBP_X/zbp_x.clas.abap`, diagnostic: [{ severity: 1, message: 'The statement "THIS" is invalid.' }] }];
      const adt = fakeAdt({ raw: { lsp: answer({ check: true, activation: false, generation: false }, diagnostics) } });
      const result = await object.activateBatch(adt, destination, { refs });
      expect(result).toMatchObject({ checkExecuted: true, activationExecuted: false, diagnostics });
      expect(adt.repository.abapStat).not.toHaveBeenCalled();
    });
  });

  it('deleteObject refuses without confirm: true', async () => {
    const adt = fakeAdt();
    await expect(
      object.deleteObject(adt, destination, { ref: { name: 'ZCL_X', objectType: 'CLAS/OC' } }),
    ).rejects.toThrow(/requires confirm: true/);
    expect(adt.lifecycle.delete).not.toHaveBeenCalled();
  });

  it('deleteObject deletes the metadata URI for ordinary types', async () => {
    const adt = clasAdt();
    await object.deleteObject(adt, destination, { ref: { name: 'ZCL_X', objectType: 'CLAS/OC' }, confirm: true });
    expect(adt.repository.delete).toHaveBeenCalledWith(`${R}/ZCL_X/zcl_x.clas.json`);
    expect(adt.lifecycle.delete).not.toHaveBeenCalled();
  });

  it('updateSource gates on the resolved object, then writes to that URI through lifecycle.update', async () => {
    const adt = clasAdt();
    const input = { name: 'ZCL_X', objectType: 'CLAS/OC', include: 'testclasses', source: 'CLASS ltc_x.' };
    await object.updateSource(adt, destination, input);
    expect(adt.lifecycle.update).toHaveBeenCalledWith({ ...input, uri: `${R}/ZCL_X/zcl_x.clas.abap` });
    expect(adt.lifecycle.resolveAffUri).toHaveBeenCalledTimes(1);
    expect(adt.repository.writeFile).not.toHaveBeenCalled();
  });

  it('deleteObject uses repository.delete on the resolved URI for DDLX/EX', async () => {
    const adt = fakeAdt();
    await object.deleteObject(adt, destination, { ref: { name: 'ZADTPLUS_ADTP_MDE', objectType: 'DDLX/EX' }, confirm: true });
    expect(adt.repository.delete).toHaveBeenCalledWith(`${R}/ZADTPLUS_ADTP_MDE/zadtplus_adtp_mde.json`);
    expect(adt.lifecycle.delete).not.toHaveBeenCalled();
  });

  describe('an object in no open request (1001)', () => {
    /** adt-ls's behaviour: a write answers 1001 until its own file is assigned. */
    function unrecordedAdt() {
      const assigned = new Set<string>();
      const notAssigned = () => Object.assign(new Error('Object not assigned to a transport'), { code: 1001 });
      const writes = (file: string) => {
        if (!assigned.delete(file)) throw notAssigned();
      };
      const adt = fakeAdt({
        lifecycle: {
          resolveAffUri: vi.fn(async (ref: { name: string }) => `${R}/${ref.name}/${ref.name.toLowerCase()}.clas.abap`),
          update: vi.fn(async (args: { uri: string; include?: string }) =>
            writes(args.include ? args.uri.replace(/\.clas\.abap$/, `.clas.${args.include}.abap`) : args.uri),
          ),
        },
        repository: { readFile: vi.fn(async () => 'source'), delete: vi.fn(async (uri: string) => writes(uri)) },
        raw: {
          lsp: vi.fn(async (_method: string, params: { objectUri: string; transport: string }) => {
            if (params.transport === 'DEVK900001') assigned.add(params.objectUri);
          }),
        },
      });
      const assignments = () => vi.mocked(adt.raw.lsp).mock.calls.map(([m, p]) => [m, String((p as { objectUri: string }).objectUri).split('/').pop()]);
      return { adt, assignments };
    }
    const ref = { name: 'ZCL_X', objectType: 'CLAS/OC' };

    it('updateSource assigns the file it writes and writes again', async () => {
      const { adt, assignments } = unrecordedAdt();
      await object.updateSource(adt, destination, { ...ref, include: 'implementations', source: 'x', transport: 'devk900001' });
      expect(assignments()).toEqual([['adtLs/cts/transport/assignTransportToObject', 'zcl_x.clas.implementations.abap']]);
      expect(adt.lifecycle.update).toHaveBeenCalledTimes(2);
      expect(adt.lifecycle.update).toHaveBeenLastCalledWith({ ...ref, include: 'implementations', source: 'x', uri: `${R}/ZCL_X/zcl_x.clas.abap` });
    });

    it('without a transport, says to pass one', async () => {
      const { adt, assignments } = unrecordedAdt();
      await expect(object.updateSource(adt, destination, { ...ref, source: 'x' })).rejects.toThrow(
        /not assigned to a transport: the object is in no open request; send it again with transportRequestNumber \(CLI --transport\)/,
      );
      await expect(object.deleteObject(adt, destination, { ref, confirm: true })).rejects.toMatchObject({
        code: 1001,
        message: expect.stringMatching(/send it again with transport \(CLI --transport\)/),
      });
      expect(assignments()).toEqual([]);
    });

    it('a request adt-ls doesn\'t take fails on the second write', async () => {
      const { adt } = unrecordedAdt();
      await expect(object.updateSource(adt, destination, { ...ref, source: 'x', transport: 'DEVK999999' })).rejects.toThrow(
        /transport DEVK999999 was not taken/,
      );
      expect(adt.lifecycle.update).toHaveBeenCalledTimes(2);
    });

    it('deleteObject assigns the deleted file and the main source, then deletes again', async () => {
      const { adt, assignments } = unrecordedAdt();
      await object.deleteObject(adt, destination, { ref, confirm: true, transport: 'DEVK900001' });
      expect(assignments().map(([, f]) => f)).toEqual(['zcl_x.clas.json', 'zcl_x.clas.abap']);
      expect(adt.repository.delete).toHaveBeenCalledTimes(2);
      expect(adt.repository.delete).toHaveBeenLastCalledWith(`${R}/ZCL_X/zcl_x.clas.json`);
    });

    it('other errors pass through untouched, without an assignment', async () => {
      const adt = clasAdt();
      vi.mocked(adt.lifecycle.update).mockRejectedValueOnce(new Error('Syntax error'));
      await expect(object.updateSource(adt, destination, { ...ref, source: 'x', transport: 'DEVK900001' })).rejects.toThrow(/^Syntax error$/);
      expect(adt.raw.lsp).not.toHaveBeenCalled();
    });
  });

  describe('write allowlist on existing objects (docs/decisions/003-write-gates.md)', () => {
    /** Resolves ZCL_FOREIGN into ZADTPLUS_ELSEWHERE, everything else into ZADTPLUS_TEST. */
    function mixedAdt(): AdtLsClient {
      return fakeAdt({
        lifecycle: {
          resolveAffUri: vi.fn(async (ref: { name: string }) =>
            ref.name === 'ZCL_FOREIGN'
              ? `abap:/repotree-v1/adtplus_onprem/System%20Library/ZADTPLUS_ELSEWHERE/Source%20Code%20Library/Classes/${ref.name}/x.clas.abap`
              : `${R}/${ref.name}/${ref.name.toLowerCase()}.clas.abap`,
          ),
          create: vi.fn(async () => ({ message: 'created' })),
          update: vi.fn(async () => undefined),
        },
      });
    }
    const foreign = { name: 'ZCL_FOREIGN', objectType: 'CLAS/OC' };

    it('updateSource and deleteObject refuse before writing', async () => {
      const adt = mixedAdt();
      await expect(object.updateSource(adt, destination, { ...foreign, source: 'x' })).rejects.toThrow(
        /package "ZADTPLUS_ELSEWHERE" is not in the write allowlist/,
      );
      await expect(object.deleteObject(adt, destination, { ref: foreign, confirm: true })).rejects.toThrow(
        /not in the write allowlist/,
      );
      expect(adt.lifecycle.update).not.toHaveBeenCalled();
      expect(adt.repository.delete).not.toHaveBeenCalled();
    });

    it('activateBatch refuses the whole batch when one object is outside', async () => {
      const adt = mixedAdt();
      await expect(
        object.activateBatch(adt, destination, { refs: [{ name: 'ZCL_X', objectType: 'CLAS/OC' }, foreign] }),
      ).rejects.toThrow(/not in the write allowlist/);
      expect(adt.raw.lsp).not.toHaveBeenCalled();
    });

    it('create into a subpackage passes with a subpackages entry, via one package lookup', async () => {
      const adt = fakeAdt({
        lifecycle: {
          resolveAffUri: vi.fn(async () => `${R.replace(/\/Source%20Code%20Library\/Classes$/, '')}/ZADTPLUS_TEST_MCP/zadtplus_test_mcp.devck.jsonc`),
          create: vi.fn(async () => ({ message: 'created' })),
        },
      });
      const subtree: Destination = { ...destination, writeAllowlist: [{ package: 'ZADTPLUS_TEST', subpackages: true }] };
      const input = { name: 'ZCL_NEW', objectType: 'CLAS/OC', packageName: 'ZADTPLUS_TEST_MCP', description: 'x' };
      await object.create(adt, subtree, input);
      expect(adt.lifecycle.create).toHaveBeenCalledWith(input);
      expect(adt.lifecycle.resolveAffUri).toHaveBeenCalledWith({ name: 'ZADTPLUS_TEST_MCP', objectType: 'DEVC/K' });

      await expect(object.create(adt, destination, input)).rejects.toThrow(/package "ZADTPLUS_TEST_MCP" is not in the write allowlist/);
    });
  });

  it('lockStatus and listInactive pass through', async () => {
    const adt = fakeAdt();
    await object.lockStatus(adt, { name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(adt.transport.getLockStatus).toHaveBeenCalledWith({ name: 'ZCL_X', objectType: 'CLAS/OC' });

    await object.listInactive(adt);
    expect(adt.repository.listInactive).toHaveBeenCalled();
  });
});

describe('readSource', () => {
  const CLASS = [
    'CLASS zcl_x DEFINITION PUBLIC.',
    '  PUBLIC SECTION.',
    '    INTERFACES zif_x.',
    '    METHODS run.',
    'ENDCLASS.',
    'CLASS zcl_x IMPLEMENTATION.',
    '  METHOD zif_x~calc.',
    '    rv = 1.',
    '  ENDMETHOD.',
    '  METHOD run.',
    '    DATA(x) = zif_x~calc( ).',
    '  ENDMETHOD.',
    'ENDCLASS.',
    '',
  ].join('\n');
  const main = `${R}/ZCL_X/zcl_x.clas.abap`;

  function readAdt(text = CLASS, stats: Record<string, 'active' | 'inactive'> = { 'zcl_x.clas.abap': 'inactive', 'zcl_x.clas.testclasses.abap': 'active' }) {
    return {
      lifecycle: { resolveAffUri: vi.fn(async () => main) },
      source: { read: vi.fn(async () => text) },
      repository: {
        abapStat: vi.fn(async (uri: string) => {
          const stat = stats[uri.slice(uri.lastIndexOf('/') + 1)];
          if (!stat) throw new Error('no such file');
          return stat;
        }),
      },
    } as unknown as AdtLsClient;
  }
  const deps = (readActive: object.ActiveIncludeReader = vi.fn()) => ({ hold: <T>(fn: () => Promise<T>) => fn(), readActive });
  const ref = { name: 'ZCL_X', objectType: 'CLAS/OC' };

  it('returns the whole source verbatim, which version was served, and the class includes that exist', async () => {
    const adt = readAdt();
    const res = await object.readSource(adt, ref, deps());
    expect(res).toMatchObject({ uri: main, include: 'main', served: 'inactive', totalLines: 13, source: CLASS, includes: ['testclasses'] });
    expect(res.notes).toEqual([expect.stringMatching(/inactive draft/)]);
    // One name search; the read goes to the URI it found.
    expect(adt.lifecycle.resolveAffUri).toHaveBeenCalledTimes(1);
    expect(adt.source.read).toHaveBeenCalledWith({ ...ref, uri: main, include: undefined });
  });

  it('reads an include at its own file and lists no includes for it', async () => {
    const adt = readAdt();
    const res = await object.readSource(adt, { ...ref, include: 'testclasses' }, deps());
    expect(res).toMatchObject({ uri: `${R}/ZCL_X/zcl_x.clas.testclasses.abap`, include: 'testclasses', served: 'active', includes: undefined });
    expect(adt.repository.abapStat).toHaveBeenCalledWith(`${R}/ZCL_X/zcl_x.clas.testclasses.abap`);
  });

  it('refuses an include on a non-class and an abapGit include name before any SAP call', async () => {
    const adt = readAdt();
    await expect(object.readSource(adt, { name: 'ZI_X', objectType: 'DDLS/DF', include: 'main' }, deps())).rejects.toThrow(/only classes/);
    await expect(object.readSource(adt, { ...ref, include: 'locals_imp' }, deps())).rejects.toThrow(/"implementations"/);
    expect(adt.lifecycle.resolveAffUri).not.toHaveBeenCalled();
  });

  it('reads the active version through the exclusive reader', async () => {
    const adt = readAdt();
    const readActive = vi.fn(async () => ({ texts: new Map([['main', 'ACTIVE\n']]) }));
    const res = await object.readSource(adt, { ...ref, version: 'active' }, deps(readActive));
    expect(readActive).toHaveBeenCalledWith({ ...ref, uri: main }, [undefined]);
    expect(adt.source.read).not.toHaveBeenCalled();
    expect(res).toMatchObject({ served: 'active', source: 'ACTIVE\n', totalLines: 1 });
  });

  it('says an object adt-ls cannot switch has no active version', async () => {
    const readActive = vi.fn(async () => ({
      texts: new Map(),
      errors: new Map([['main', 'adt-ls did not switch abap:/x/zi_x.ddls.acds to the active version.']]),
    }));
    await expect(object.readSource(readAdt(), { name: 'ZI_X', objectType: 'DDLS/DF', version: 'active' }, deps(readActive))).rejects.toThrow(
      /^ZI_X has no active version: .*never activated/,
    );
  });

  it('refuses to label a draft saved after the active check as active', async () => {
    const adt = readAdt(CLASS, { 'zcl_x.clas.abap': 'inactive' });
    const readActive = vi.fn(async () => ({ sameAsServed: true as const }));
    await expect(object.readSource(adt, { ...ref, version: 'active' }, deps(readActive))).rejects.toThrow(/changed during the active read/);
  });

  it('asks for the includes only when the whole main source comes back', async () => {
    const adt = readAdt();
    await object.readSource(adt, { ...ref, method: 'run' }, deps());
    expect(adt.repository.abapStat).toHaveBeenCalledTimes(1);
  });

  it('a range past the end of an empty source says which line', async () => {
    const res = await object.readSource(readAdt(''), { ...ref, include: 'testclasses', toLine: 10 }, deps());
    expect(res.notes).toContain('line 1 is past the end: the source has 0 lines');
    expect(res.lines).toBeUndefined();
  });

  it('names why the active version could not be read', async () => {
    const readActive = vi.fn(async () => ({ texts: new Map(), errors: new Map([['main', 'The served version of x changed during the active read']]) }));
    await expect(object.readSource(readAdt(), { ...ref, version: 'active' }, deps(readActive))).rejects.toThrow(
      'the active version of ZCL_X main could not be read: The served version of x changed during the active read',
    );
  });

  it('reads as usual when adt-ls already serves the active version', async () => {
    const adt = readAdt(CLASS, { 'zcl_x.clas.abap': 'active' });
    const res = await object.readSource(adt, { ...ref, version: 'active' }, deps(vi.fn(async () => ({ sameAsServed: true as const }))));
    expect(res).toMatchObject({ served: 'active', source: CLASS, notes: [] });
  });

  it('cuts a method, an interface method by its short name, with line numbers and its class', async () => {
    const res = await object.readSource(readAdt(), { ...ref, method: 'CALC' }, deps());
    expect(res.source).toBeUndefined();
    expect(res.methods).toEqual([
      { method: 'zif_x~calc', className: 'zcl_x', fromLine: 7, toLine: 9, text: '  METHOD zif_x~calc.\n    rv = 1.\n  ENDMETHOD.' },
    ]);
    await expect(object.readSource(readAdt(), { ...ref, method: 'nope' }, deps())).rejects.toThrow(/include "implementations"/);
  });

  it('greps with context, merging hunks that touch', async () => {
    const res = await object.readSource(readAdt(), { ...ref, grep: 'calc', context: 1 }, deps());
    const lines = CLASS.split('\n');
    expect(res.matches).toEqual([
      { fromLine: 6, toLine: 8, text: lines.slice(5, 8).join('\n') },
      { fromLine: 10, toLine: 12, text: lines.slice(9, 12).join('\n') },
    ]);
    const merged = await object.readSource(readAdt(), { ...ref, grep: 'calc', context: 2 }, deps());
    expect(merged.matches).toEqual([{ fromLine: 5, toLine: 13, text: lines.slice(4, 13).join('\n') }]);
    const none = await object.readSource(readAdt(), { ...ref, grep: 'xyz' }, deps());
    expect(none.matches).toEqual([]);
    expect(none.notes).toContain('no line matches /xyz/i');
  });

  it('stops a grep pattern that backtracks catastrophically instead of blocking the event loop', () => {
    const started = Date.now();
    expect(() => object.matchingLines(['a'.repeat(40) + '!'], '(a+)+$', 200)).toThrow(/took over 200 ms and was stopped; narrow the pattern/);
    expect(Date.now() - started).toBeLessThan(2000);
    // The context is reused: a second pattern runs clean after a stopped one.
    expect(object.matchingLines(['x', 'METHOD a', 'y'], 'method')).toEqual([1]);
    expect(object.matchingLines(['METHOD a'], 'nope')).toEqual([]);
  });

  it('returns a line range and cuts it at maxLines', async () => {
    const res = await object.readSource(readAdt(), { ...ref, fromLine: 10, toLine: 99, maxLines: 2 }, deps());
    expect(res).toMatchObject({ lines: { fromLine: 10, toLine: 11, text: '  METHOD run.\n    DATA(x) = zif_x~calc( ).' }, truncated: true });
    const whole = await object.readSource(readAdt(), { ...ref, maxLines: 3 }, deps());
    expect(whole).toMatchObject({ lines: { fromLine: 1, toLine: 3 }, truncated: true, totalLines: 13 });
    expect(whole.source).toBeUndefined();
  });

  it('refuses mixed narrowing, bad numbers and a bad regex', async () => {
    const adt = readAdt();
    await expect(object.readSource(adt, { ...ref, method: 'run', grep: 'x' }, deps())).rejects.toThrow(/at most one of/);
    await expect(object.readSource(adt, { ...ref, fromLine: 0 }, deps())).rejects.toThrow(/fromLine must be/);
    await expect(object.readSource(adt, { ...ref, fromLine: 5, toLine: 2 }, deps())).rejects.toThrow(/before fromLine/);
    await expect(object.readSource(adt, { ...ref, grep: '(' }, deps())).rejects.toThrow(/^grep:/);
  });
});

describe('source line helpers', () => {
  it('splitLines: a final line break ends the last line; CRLF counts as one break', () => {
    expect(object.splitLines('')).toEqual([]);
    expect(object.splitLines('a\r\nb\n')).toEqual(['a', 'b']);
    expect(object.splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('cutMethod: local classes repeating a name, AMDP headers, a missing ENDMETHOD', () => {
    const lines = [
      'CLASS lcl_a IMPLEMENTATION.',
      '  METHOD m.',
      '  ENDMETHOD.',
      'ENDCLASS.',
      'CLASS lcl_b IMPLEMENTATION.',
      '  METHOD m BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT.',
      '  ENDMETHOD.',
      '* METHOD m. in a comment',
      '  METHODS m.',
      '  METHOD m.',
      '    x = 1.',
    ];
    expect(object.cutMethod(lines, 'm').map((f) => [f.className, f.fromLine, f.toLine])).toEqual([
      ['lcl_a', 2, 3],
      ['lcl_b', 6, 7],
      ['lcl_b', 10, 11],
    ]);
    // ENDCLASS ends the class: a METHOD after it belongs to none.
    expect(object.cutMethod(['CLASS lcl_a IMPLEMENTATION.', 'ENDCLASS.', 'METHOD m.', 'ENDMETHOD.'], 'm')[0]!.className).toBeUndefined();
    // A name with `~` matches only itself.
    expect(object.cutMethod(['METHOD zif_y~m.', 'ENDMETHOD.'], 'zif_x~m')).toEqual([]);
  });

  it('cutMethod: a METHOD statement over several lines, and ENDMETHOD in a literal or comment', () => {
    const lines = [
      'CLASS lcl IMPLEMENTATION.',
      '  METHOD',
      '    zif_x~m.',
      `    x = 'ENDMETHOD.'.`,
      '    " ENDMETHOD.',
      '  ENDMETHOD.',
      'ENDCLASS.',
    ];
    expect(object.cutMethod(lines, 'm').map((f) => [f.method, f.className, f.fromLine, f.toLine])).toEqual([['zif_x~m', 'lcl', 2, 6]]);
  });

  it('cutMethod: a namespaced interface method, which abaplint does not parse yet', () => {
    const lines = ['CLASS lcl IMPLEMENTATION.', '  METHOD /ns/if_y~/ns/m.', '  ENDMETHOD.', 'ENDCLASS.'];
    expect(object.cutMethod(lines, '/ns/m').map((f) => [f.method, f.fromLine, f.toLine])).toEqual([['/ns/if_y~/ns/m', 2, 3]]);
  });

  it('capRuns: no cap without maxLines; the budget runs across runs', () => {
    const runs = [
      { fromLine: 1, toLine: 2, text: 'a\nb' },
      { fromLine: 5, toLine: 7, text: 'c\nd\ne' },
    ];
    expect(object.capRuns(runs, undefined)).toEqual({ runs, truncated: false });
    expect(object.capRuns(runs, 5)).toEqual({ runs, truncated: false });
    expect(object.capRuns(runs, 3)).toEqual({ runs: [runs[0], { fromLine: 5, toLine: 5, text: 'c' }], truncated: true });
    expect(object.capRuns(runs, 2)).toEqual({ runs: [runs[0]], truncated: true });
  });
});
