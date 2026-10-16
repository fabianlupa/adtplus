import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import * as quality from '../../src/capabilities/quality.js';
import { ThrottledError } from '../../src/daemon/ratelimit.js';
import type { Destination } from '../../src/core/destinations.js';

const CLAS_SOURCE = [
  'CLASS zcl_adtplus_m3 DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    METHODS bar.',
  'ENDCLASS.',
  'CLASS zcl_adtplus_m3 IMPLEMENTATION.',
  '  METHOD bar.',
  '    DATA lv_unused TYPE i.',
  '  ENDMETHOD.',
  'ENDCLASS.',
  '',
].join('\n');

/** The AFF `.json` of a class at `version`. */
const classJson = (version: string) => JSON.stringify({ formatVersion: '1', header: { description: 'x', originalLanguage: 'en', abapLanguageVersion: version } });

function fakeAdt(overrides: Record<string, unknown> = {}): AdtLsClient {
  return {
    quality: {
      listAtcVariants: vi.fn(async () => ({ variants: [] })),
      runAtc: vi.fn(async () => ({ atcRunCheckResults: [] })),
      runUnitTestsWithCoverage: vi.fn(async () => ({ status: 'PASSED' })),
    },
    lifecycle: {
      runUnitTests: vi.fn(async () => ({ message: 'Overall Test Run Status: [PASSED]' })),
      resolveAffUri: vi.fn(async () => 'abap:/repotree-v1/adtplus_onprem/System%20Library/ZADTPLUS_TEST/Source%20Code%20Library/Classes/ZCL_ADTPLUS_M3/zcl_adtplus_m3.clas.abap'),
    },
    repository: { readFile: vi.fn(async (uri: string) => (uri.endsWith('.json') ? classJson('standard') : CLAS_SOURCE)) },
    source: { read: vi.fn(async () => CLAS_SOURCE) },
    ...overrides,
  } as unknown as AdtLsClient;
}

const ref = { name: 'ZCL_ADTPLUS_M3', objectType: 'CLAS/OC' };

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: [],
};

const cloudErp: Destination = { ...onprem, id: 'cloud-erp', kind: 'cloud' };

/** Unit tests execute code, so they need the object's package in the allowlist (docs/decisions/003-write-gates.md). */
const testable: Destination = { ...onprem, writeAllowlist: ['ZADTPLUS_TEST'] };

describe('quality capability', () => {
  it('listAtcVariants/runAtc/runUnitTests pass through', async () => {
    const adt = fakeAdt();
    await quality.listAtcVariants(adt, ref);
    expect(adt.quality.listAtcVariants).toHaveBeenCalledWith(ref);

    await quality.runAtc(adt, { ref, checkVariant: 'DEFAULT' });
    expect(adt.quality.runAtc).toHaveBeenCalledWith(ref, { checkVariant: 'DEFAULT', timeoutMs: quality.ATC_DEFAULT_TIMEOUT_MS });

    await quality.runUnitTests(adt, testable, { ref });
    expect(adt.lifecycle.runUnitTests).toHaveBeenCalledWith({ ...ref, uri: expect.any(String) });

    await quality.runUnitTests(adt, testable, { ref, coverage: true });
    expect(adt.quality.runUnitTestsWithCoverage).toHaveBeenCalledWith({ ...ref, uri: expect.any(String) });
  });

  it('runUnitTests refuses an object outside the write allowlist before running anything', async () => {
    const adt = fakeAdt();
    await expect(quality.runUnitTests(adt, onprem, { ref })).rejects.toThrow(/package "ZADTPLUS_TEST" is not in the write allowlist/);
    expect(adt.lifecycle.runUnitTests).not.toHaveBeenCalled();
  });

  it('runAbaplint lints an on-prem object at the version its .json names and finds the unused variable', async () => {
    const adt = fakeAdt();
    const result = await quality.runAbaplint(adt, onprem, ref);

    expect(result.languageVersion).toBe('standard');
    expect(adt.repository.readFile).toHaveBeenCalledWith(expect.stringMatching(/\/ZCL_ADTPLUS_M3\/zcl_adtplus_m3\.clas\.json$/));
    expect(result.filename).toBe('zcl_adtplus_m3.clas.abap');
    expect(result.findings.some((f) => f.key === 'unused_variables')).toBe(true);
  });

  it('runAbaplint reads a cloudDevelopment object on premise as such, standard when the .json is unreadable', async () => {
    const json = (read: () => Promise<string>) =>
      fakeAdt({ repository: { readFile: vi.fn(async (uri: string) => (uri.endsWith('.json') ? read() : CLAS_SOURCE)) } });
    expect((await quality.runAbaplint(json(async () => classJson('cloudDevelopment')), onprem, ref)).languageVersion).toBe('cloudDevelopment');
    const unreadable = json(async () => {
      throw new Error('not found');
    });
    expect((await quality.runAbaplint(unreadable, onprem, ref)).languageVersion).toBe('standard');
    const throttled = json(async () => {
      throw new ThrottledError('slow down', 1000);
    });
    await expect(quality.runAbaplint(throttled, onprem, ref)).rejects.toThrow(ThrottledError);
  });

  it('runAbaplint lints at cloudDevelopment on a cloud system without reading the .json', async () => {
    const adt = fakeAdt();
    const result = await quality.runAbaplint(adt, cloudErp, ref);

    expect(result.languageVersion).toBe('cloudDevelopment');
    expect(adt.repository.readFile).not.toHaveBeenCalledWith(expect.stringMatching(/\.json$/));
  });
});

describe('quality batches', () => {
  const refs = ['ZCL_A', 'ZCL_B', 'ZCL_C'].map((name) => ({ name, objectType: 'CLAS/OC' }));
  const uriOf = (name: string) => `abap:/repotree-v1/adtplus_onprem/Classes/${name}/${name.toLowerCase()}.clas.abap`;

  it('runAtcBatch runs per object at most `concurrency` at a time and sums up, errors first', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runAtc = vi.fn(async (ref: { name: string }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (ref.name === 'ZCL_C') throw new Error('ATC run failed');
      return {
        atcRunCheckResults: [
          { lineNumber: 1, priority: 3, location: uriOf(ref.name), message: 'info', checkTitle: 'SLIN' },
          ...(ref.name === 'ZCL_B'
            ? [{ lineNumber: 12, priority: 1, location: uriOf(ref.name), message: 'bad', checkTitle: 'Security' }]
            : []),
        ],
      };
    });
    const adt = fakeAdt({ quality: { runAtc } });

    const result = await quality.runAtcBatch(adt, { refs, checkVariant: 'V', timeoutMs: 1000, concurrency: 2 });

    expect(maxInFlight).toBe(2);
    expect(runAtc).toHaveBeenCalledWith(refs[0], { checkVariant: 'V', timeoutMs: 1000 });
    expect(result).toMatchObject({ objects: 3, checked: 2, counts: { error: 1, warning: 0, info: 2 }, omitted: 0 });
    expect(result.byCheck).toEqual({ SLIN: 2, Security: 1 });
    expect(result.findings[0]).toEqual({
      object: 'CLAS ZCL_B',
      severity: 'error',
      check: 'Security',
      message: 'bad',
      uri: uriOf('ZCL_B'),
      line: 12,
    });
    expect(result.failed).toEqual([{ object: 'CLAS ZCL_C', message: 'ATC run failed' }]);
  });

  const noCheckRun = async (): Promise<never> => {
    throw new Error('no JSON type in this batch');
  };

  it('checkSyntaxBatch checks each object by its resolved URI and counts lines from 1', async () => {
    const checkSyntax = vi.fn(async (ref: { name: string }) => ({
      kind: 'full',
      items: ref.name === 'ZCL_A' ? [{ range: { start: { line: 19 } }, severity: 1, code: 'MESSAGE(GZH)', message: 'Incomplete' }] : [],
    }));
    const adt = fakeAdt({
      navigation: { checkSyntax },
      lifecycle: { resolveAffUri: vi.fn(async (ref: { name: string }) => uriOf(ref.name)) },
    });

    const result = await quality.checkSyntaxBatch(adt, refs.slice(0, 2), 4, noCheckRun);

    expect(checkSyntax).toHaveBeenCalledWith({ ...refs[0], uri: uriOf('ZCL_A') });
    expect(result.counts).toEqual({ error: 1, warning: 0, info: 0 });
    expect(result.findings).toEqual([
      { object: 'CLAS ZCL_A', severity: 'error', check: 'MESSAGE(GZH)', message: 'Incomplete', uri: uriOf('ZCL_A'), line: 20 },
    ]);
  });

  it('checkSyntaxBatch leaves an SRVB out of the calls and of `checked`', async () => {
    const checkSyntax = vi.fn(async () => ({ items: [] }));
    const adt = fakeAdt({
      navigation: { checkSyntax },
      lifecycle: { resolveAffUri: vi.fn(async (ref: { name: string }) => uriOf(ref.name)) },
    });

    const result = await quality.checkSyntaxBatch(adt, [refs[0]!, { name: 'ZUI_X_O4', objectType: 'SRVB/SVB' }], 4, noCheckRun);

    expect(checkSyntax).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ objects: 2, checked: 1, notes: [expect.stringMatching(/^Not checked: SRVB ZUI_X_O4\./)] });
  });

  it('checkSyntaxBatch sends the types adt-ls cannot check to the check run', async () => {
    const checkSyntax = vi.fn(async () => ({ items: [] }));
    const adt = fakeAdt({
      navigation: { checkSyntax },
      lifecycle: { resolveAffUri: vi.fn(async (ref: { name: string }) => uriOf(ref.name)) },
    });
    const at = { line: 8, character: 4 };
    const checkRun = vi.fn(async () => [{ range: { start: at, end: at }, severity: 2 as const, message: 'Domain CHAR10 is deprecated.' }]);
    const nrob = { name: 'ZADTP_APNR', objectType: 'NROB/NRO' };

    const result = await quality.checkSyntaxBatch(adt, [refs[0]!, nrob], 4, checkRun);

    expect(checkRun).toHaveBeenCalledWith(nrob);
    expect(checkSyntax).toHaveBeenCalledTimes(1);
    expect(result.findings).toEqual([
      { object: 'NROB ZADTP_APNR', severity: 'warning', check: '', message: 'Domain CHAR10 is deprecated.', uri: uriOf('ZADTP_APNR'), line: 9 },
    ]);
  });

  it('checkSyntaxBatch notes inactive dependencies across all objects', async () => {
    const checkSyntax = vi.fn(async () => ({ items: [{ severity: 1, message: 'The data source "ZR_X" does not exist or is not active' }] }));
    const adt = fakeAdt({
      navigation: { checkSyntax },
      lifecycle: { resolveAffUri: vi.fn(async (ref: { name: string }) => uriOf(ref.name)) },
    });

    const result = await quality.checkSyntaxBatch(adt, refs.slice(0, 2), 4, noCheckRun);

    expect(result.notes).toEqual([expect.stringMatching(/^2 findings name an object that is inactive/)]);
  });

  it('runAbaplintBatch lints the objects together: with check_syntax on, a call into another batch object is checked', async () => {
    const sources: Record<string, string> = {
      ZCL_A: [
        'CLASS zcl_a DEFINITION PUBLIC FINAL CREATE PUBLIC.',
        '  PUBLIC SECTION.',
        '    METHODS run.',
        'ENDCLASS.',
        'CLASS zcl_a IMPLEMENTATION.',
        '  METHOD run.',
        '    zcl_b=>helpr( ).',
        '  ENDMETHOD.',
        'ENDCLASS.',
        '',
      ].join('\n'),
      ZCL_B: [
        'CLASS zcl_b DEFINITION PUBLIC FINAL CREATE PUBLIC.',
        '  PUBLIC SECTION.',
        '    CLASS-METHODS helper.',
        'ENDCLASS.',
        'CLASS zcl_b IMPLEMENTATION.',
        '  METHOD helper.',
        '  ENDMETHOD.',
        'ENDCLASS.',
        '',
      ].join('\n'),
      ZCL_C: 'CLASS zcl_c DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS run\nENDCLASS.\n',
    };
    const adt = fakeAdt({
      lifecycle: { resolveAffUri: vi.fn(async (ref: { name: string }) => uriOf(ref.name)) },
      source: { read: vi.fn(async (ref: { name: string }) => sources[ref.name]) },
    });
    const typo = (findings: Array<{ check: string; message: string }>) =>
      findings.some((f) => f.check === 'check_syntax' && /helpr/i.test(f.message));
    const rules = { check_syntax: true };

    // Alone, zcl_b is unknown: a void reference, as SAP's objects are.
    const alone = await quality.runAbaplintBatch(adt, onprem, refs.slice(0, 1), 4, rules);
    expect(typo(alone.findings)).toBe(false);
    // Off by default.
    expect(typo((await quality.runAbaplintBatch(adt, onprem, refs.slice(0, 2), 4)).findings)).toBe(false);
    // Only a source that doesn't parse is an error.
    const broken = await quality.runAbaplintBatch(adt, onprem, [{ name: 'ZCL_C', objectType: 'CLAS/OC' }], 4);
    expect(broken.counts.error).toBeGreaterThan(0);

    const together = await quality.runAbaplintBatch(adt, onprem, refs.slice(0, 2), 4, rules);
    expect(typo(together.findings)).toBe(true);
    expect(together.findings.find((f) => f.check === 'check_syntax')?.severity).toBe('warning');
    expect(together.languageVersions).toEqual({ standard: 2 });
    expect(together.checked).toBe(2);
    expect(together.findings.every((f) => f.object === 'CLAS ZCL_A' || f.object === 'CLAS ZCL_B')).toBe(true);
  });

  it('runAbaplintBatch lints each object at its own language version, one run per version', async () => {
    const cls = (name: string) =>
      `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS m.\nENDCLASS.\nCLASS ${name} IMPLEMENTATION.\n  METHOD m.\n    WRITE 'x'.\n  ENDMETHOD.\nENDCLASS.\n`;
    const adt = fakeAdt({
      lifecycle: { resolveAffUri: vi.fn(async (ref: { name: string }) => uriOf(ref.name)) },
      source: { read: vi.fn(async (ref: { name: string }) => cls(ref.name.toLowerCase())) },
      repository: { readFile: vi.fn(async (uri: string) => classJson(uri.includes('/ZCL_A/') ? 'cloudDevelopment' : 'standard')) },
    });
    const result = await quality.runAbaplintBatch(adt, onprem, refs.slice(0, 2), 4);
    expect(result.languageVersions).toEqual({ cloudDevelopment: 1, standard: 1 });
    expect([...new Set(result.findings.filter((f) => f.severity === 'error').map((f) => f.object))]).toEqual(['CLAS ZCL_A']);
  });

  it('refuses an empty batch and one over 50 objects', async () => {
    const adt = fakeAdt();
    await expect(quality.runAtcBatch(adt, { refs: [], concurrency: 4 })).rejects.toThrow(/no objects/);
    const many = Array.from({ length: 51 }, (_, i) => ({ name: `ZCL_${i}`, objectType: 'CLAS/OC' }));
    await expect(quality.checkSyntaxBatch(adt, many, 4, noCheckRun)).rejects.toThrow(/at most 50/);
    expect(adt.quality.runAtc).not.toHaveBeenCalled();
  });

  it('lists at most 100 findings and counts the rest as omitted', async () => {
    const runAtc = vi.fn(async () => ({
      atcRunCheckResults: Array.from({ length: 60 }, (_, i) => ({ lineNumber: i + 1, priority: 2, message: 'w', checkTitle: 'C' })),
    }));
    const result = await quality.runAtcBatch(fakeAdt({ quality: { runAtc } }), { refs: refs.slice(0, 2), concurrency: 4 });
    expect(result.counts.warning).toBe(120);
    expect(result.findings).toHaveLength(100);
    expect(result.omitted).toBe(20);
  });
});

describe('quality: what a batch passes on, what abaplint drops', () => {
  const refs = ['ZCL_A', 'ZCL_B', 'ZCL_C'].map((name) => ({ name, objectType: 'CLAS/OC' }));

  it('a cooldown fails the whole batch instead of filing it as per-object failures', async () => {
    const runAtc = vi.fn(async (r: { name: string }) => {
      if (r.name === 'ZCL_B') throw new ThrottledError('throttled', 5000);
      return { atcRunCheckResults: [] };
    });
    await expect(quality.runAtcBatch(fakeAdt({ quality: { runAtc } }), { refs, concurrency: 1 })).rejects.toBeInstanceOf(ThrottledError);
    const read = vi.fn(async () => {
      throw new ThrottledError('throttled', 5000);
    });
    await expect(quality.runAbaplintBatch(fakeAdt({ source: { read } }), onprem, refs, 1)).rejects.toBeInstanceOf(ThrottledError);
  });

  it("drops what mirror check drops for the file's type: check_abstract on a behaviour pool", async () => {
    const pool = fakeAdt({
      lifecycle: { resolveAffUri: vi.fn(async () => 'abap:/repotree-v1/x/Classes/ZBP_X/zbp_x.clas.abap') },
      source: {
        read: vi.fn(async () => 'CLASS zbp_x DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF zi_x.\nENDCLASS.\n\nCLASS zbp_x IMPLEMENTATION.\nENDCLASS.\n'),
      },
    });
    const ref = { name: 'ZBP_X', objectType: 'CLAS/OC' };
    const single = await quality.runAbaplint(pool, onprem, ref, { check_abstract: true });
    expect(single.findings.map((f) => f.key)).not.toContain('check_abstract');
    const batch = await quality.runAbaplintBatch(pool, onprem, [ref], 1, { check_abstract: true });
    expect(Object.keys(batch.byCheck)).not.toContain('check_abstract');
  });
});

describe('ATC worklist and quick fixes', () => {
  it('applyQuickfixes reports an empty result as possibly changed, not as nothing done', async () => {
    const adt = worklistAdt((name) => (name === 'abap_atc_get_result' ? answer(WORKLIST) : answer({ messages: ['done'] })));
    const res = await quality.applyQuickfixes(adt, allowed, { worklistId: 'WL-EMPTY' }, async () => undefined);
    expect(res.changed).toEqual([]);
    expect(res.notes[0]).toMatch(/may have changed objects anyway/);
  });

  const answer = (data: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
  const PKG_URI = 'abap:/repotree-v1/adtplus_onprem/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/ZADTPLUS_PARITY/zadtplus_parity.devck.jsonc';
  const allowed: Destination = { ...onprem, writeAllowlist: [{ package: 'ZADTPLUS_TEST', subpackages: true }] };
  /** As `onprem` sent it. */
  const WORKLIST = {
    objects: [
      {
        name: 'ZCL_ADTPLUS_PAR_QF',
        type: 'CLAS',
        packageName: 'ZADTPLUS_PARITY',
        findings: [
          { priority: 2, checkTitle: 'ABAP Language Version (Syntax)', messageTitle: 'Syntax error in restricted language scope', messageId: 'X', deterministicQuickfixAvailable: true },
          { priority: 3, checkTitle: 'SLIN', messageTitle: 'Strings without text elements', messageId: 'Y', deterministicQuickfixAvailable: false },
        ],
      },
    ],
  };
  function worklistAdt(tool: (name: string, args: Record<string, unknown>) => unknown): AdtLsClient {
    return fakeAdt({
      health: vi.fn(() => ({ destination: 'adtplus_onprem' })),
      raw: { tool: vi.fn(async (name: string, args: Record<string, unknown>) => tool(name, args)) },
      lifecycle: { resolveAffUri: vi.fn(async () => PKG_URI) },
    });
  }

  it('runAtcWorklist polls until the worklist has objects and counts the quick fixes', async () => {
    let polls = 0;
    const adt = worklistAdt((name) => {
      if (name === 'abap_atc_run') return answer({ worklistId: 'WL1' });
      return answer(++polls < 2 ? {} : WORKLIST);
    });
    vi.useFakeTimers();
    try {
      const pending = quality.runAtcWorklist(adt, { refs: [{ name: 'zcl_adtplus_par_qf', objectType: 'CLAS/OC' }], checkVariant: 'ABAP_CLOUD_READINESS' });
      await vi.runAllTimersAsync();
      const res = await pending;
      expect(res.worklistId).toBe('WL1');
      expect(res.quickfixes).toBe(1);
      expect(res.objects[0]!.findings.map((f) => f.quickfix)).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
    expect(adt.raw.tool).toHaveBeenCalledWith('abap_atc_run', {
      destination: 'adtplus_onprem',
      objects: [{ name: 'ZCL_ADTPLUS_PAR_QF', type: 'CLAS/OC' }],
      checkVariant: 'ABAP_CLOUD_READINESS',
    });
  });

  it('runAtcWorklist names the likely cause of "Error executing tool: null"', async () => {
    const adt = worklistAdt(() => answer('Error executing tool: null', true));
    await expect(quality.runAtcWorklist(adt, { refs: [{ name: 'ZCL_NOPE', objectType: 'CLAS/OC' }] })).rejects.toThrow(/object not found/);
  });

  it('applyQuickfixes refuses when a worklist object is outside the allowlist, before any fix', async () => {
    const adt = worklistAdt((name) => (name === 'abap_atc_get_result' ? answer(WORKLIST) : answer({})));
    vi.mocked(adt.lifecycle.resolveAffUri).mockResolvedValue('abap:/repotree-v1/adtplus_onprem/System%20Library/ZOTHER/ZADTPLUS_PARITY/zadtplus_parity.devck.jsonc');
    await expect(quality.applyQuickfixes(adt, allowed, { worklistId: 'WL1' }, async () => undefined)).rejects.toThrow(/not in the write allowlist/);
    expect(vi.mocked(adt.raw.tool).mock.calls.map(([n]) => n)).not.toContain('abap_atc_execute_deterministic_quickfixes');
  });

  it('applyQuickfixes refuses an object a mirror holds (ADR-009)', async () => {
    const adt = worklistAdt((name) => (name === 'abap_atc_get_result' ? answer(WORKLIST) : answer({})));
    const refuse = vi.fn(async () => 'object.applyQuickfixes refused: CLAS ZCL_ADTPLUS_PAR_QF is mirrored');
    await expect(quality.applyQuickfixes(adt, allowed, { worklistId: 'WL1' }, refuse)).rejects.toThrow(/is mirrored/);
    expect(refuse).toHaveBeenCalledWith({ name: 'ZCL_ADTPLUS_PAR_QF', objectType: 'CLAS' });
  });

  it('runAtcWorklist stops on a text answer instead of polling to the deadline', async () => {
    const adt = worklistAdt((name) =>
      name === 'abap_atc_run' ? answer({ worklistId: 'WL2' }) : answer('ATC run was cancelled. Check transaction ATC for details.'),
    );
    await expect(quality.runAtcWorklist(adt, { refs: [{ name: 'ZCL_ADTPLUS_PAR_QF', objectType: 'CLAS/OC' }] })).rejects.toThrow(/was cancelled/);
    expect(vi.mocked(adt.raw.tool).mock.calls.filter(([n]) => n === 'abap_atc_get_result')).toHaveLength(1);
  });

  it('mainObjectName strips a class include suffix, padded or not', () => {
    expect(quality.mainObjectName('ZCL_ADTPLUS_PAR_QF==================CS', 'CLAS/OC')).toBe('ZCL_ADTPLUS_PAR_QF');
    expect(quality.mainObjectName('ZCL_ABCDEFGHIJKLMNOPQRSTUVWXYZCCIMP', 'CLAS/OC')).toBe('ZCL_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(quality.mainObjectName('ZPROG_WITH_A_SHORT_NAME', 'PROG/P')).toBe('ZPROG_WITH_A_SHORT_NAME');
  });

  it('applyQuickfixes refuses a worklist without quick fixes', async () => {
    const none = { objects: [{ ...WORKLIST.objects[0]!, findings: [WORKLIST.objects[0]!.findings[1]!] }] };
    const adt = worklistAdt(() => answer(none));
    await expect(quality.applyQuickfixes(adt, allowed, { worklistId: 'WL1' }, async () => undefined)).rejects.toThrow(/no finding with a quick fix/);
  });

  it('applyQuickfixes applies, leaves inactive, and names the class for its include', async () => {
    const adt = worklistAdt((name) =>
      name === 'abap_atc_get_result'
        ? answer(WORKLIST)
        : answer({
            messages: ['Id: 000001; Severity: information; Message: Execution completed successfully'],
            affectedObjects: [{ name: 'ZCL_ADTPLUS_PAR_QF==================CS', type: 'CLAS/OC', state: 'inactive' }],
          }),
    );
    const hold = vi.fn(async (_refs: unknown, fn: () => Promise<unknown>) => fn()) as never;
    const res = await quality.applyQuickfixes(adt, allowed, { worklistId: 'WL-OK', transport: 'DEVK901733' }, async () => undefined, hold);
    expect(res.changed).toEqual([{ name: 'ZCL_ADTPLUS_PAR_QF', objectType: 'CLAS/OC' }]);
    expect(res.notes[0]).toMatch(/inactive/);
    expect(hold).toHaveBeenCalledWith([{ name: 'ZCL_ADTPLUS_PAR_QF', objectType: 'CLAS' }], expect.any(Function));
    await expect(quality.applyQuickfixes(adt, allowed, { worklistId: 'WL-OK' }, async () => undefined)).rejects.toThrow(/applied already/);
    expect(adt.raw.tool).toHaveBeenCalledWith('abap_atc_execute_deterministic_quickfixes', {
      destination: 'adtplus_onprem',
      worklistId: 'WL-OK',
      useComments: false,
      useAuthor: false,
      activateAfterFix: false,
      transportId: 'DEVK901733',
    });
  });
});
