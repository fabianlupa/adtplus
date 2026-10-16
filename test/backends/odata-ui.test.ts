import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertServiceMatches,
  callFunction,
  checkMetadata,
  checkService,
  getEntities,
  literal,
  parseSapMessages,
} from '../../src/backends/odata-ui.js';
import { RawAdtError, type RawAdtClient, type RequestOptions } from '../../src/backends/rawadt.js';

/** `$metadata` of UI_SMTR_PROJECT as cloud-erp served it (F4950 2608.0.0). */
const METADATA = readFileSync(new URL('../capabilities/fixtures/translations/metadata.xml', import.meta.url), 'utf8');

type Call = { method: string; path: string; opts: RequestOptions };

function fakeRest(answer: (path: string) => { status: number; body: string; headers?: Record<string, string> }): RawAdtClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    request: async (method: string, path: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      const a = answer(path);
      return { status: a.status, headers: new Headers(a.headers ?? {}), body: a.body };
    },
  } as unknown as RawAdtClient & { calls: Call[] };
}

describe('service check', () => {
  it('finds nothing to report in the recorded $metadata', () => {
    expect(checkMetadata(METADATA)).toEqual([]);
  });

  it('names a removed parameter, a changed type, a new required parameter and a missing function import', () => {
    const changed = METADATA.replace(/<Parameter Name="downloadType"[^>]*\/>/, '')
      .replace(/(<Property Name="LastPublishedAt" Type=")Edm\.DateTimeOffset/, '$1Edm.String')
      .replace(/(<FunctionImport Name="publishTranslation"[^>]*>)/, '$1<Parameter Name="mode" Type="Edm.String" Mode="In"/>')
      .replace(/<FunctionImport Name="deleteProject"[\s\S]*?<\/FunctionImport>/, '');
    expect(checkMetadata(changed)).toEqual([
      'Translation.LastPublishedAt is Edm.String, not Edm.DateTimeOffset',
      'downloadTranslationFile(downloadType) is missing',
      'publishTranslation(mode) is new and required',
      'function import deleteProject is missing',
    ]);
  });

  it('accepts a new parameter SAP does not need', () => {
    const added = METADATA.replace(/(<FunctionImport Name="publishTranslation"[^>]*>)/, '$1<Parameter Name="mode" Type="Edm.String" Mode="In" Nullable="true"/>');
    expect(checkMetadata(added)).toEqual([]);
  });

  it('names a missing entity set', () => {
    expect(checkMetadata(METADATA.replace(/<EntitySet Name="TextSource"[^>]*>/, ''))).toContain('entity set TextSource is missing');
  });

  it('reads $metadata once per REST session; a failed read is tried again', async () => {
    let fail = true;
    const rest = fakeRest(() => (fail ? { status: 503, body: 'busy' } : { status: 200, body: METADATA }));
    await expect(checkService(rest)).rejects.toThrow(/HTTP 503/);
    fail = false;
    const first = await checkService(rest);
    const second = await checkService(rest);
    expect(first).toBe(second);
    expect(first).toMatchObject({ service: 'UI_SMTR_PROJECT', ok: true });
    expect(rest.calls.map((c) => c.path)).toEqual(['/sap/opu/odata/sap/UI_SMTR_PROJECT/$metadata', '/sap/opu/odata/sap/UI_SMTR_PROJECT/$metadata']);
    expect(rest.calls[0]!.opts.headers).toMatchObject({ Accept: 'application/xml', 'User-Agent': 'adtplus' });
  });

  it('refuses every call when the service changed, naming the system and what', () => {
    expect(() => assertServiceMatches({ service: 'UI_SMTR_PROJECT', ok: false, mismatches: ['a', 'b'], checkedAt: '' }, 'cloud-erp')).toThrow(
      'UI_SMTR_PROJECT changed on cloud-erp: a; b',
    );
  });
});

describe('OData calls', () => {
  it('sends JSON requests with its own user agent and parameters as literals', async () => {
    const rest = fakeRest(() => ({ status: 200, body: '{"d":{"results":[]}}' }));
    await callFunction(rest, 'downloadTranslationFile', { ProjectID: "Z'X", downloadType: 'ALL' });
    expect(rest.calls[0]).toMatchObject({
      method: 'GET',
      path: '/sap/opu/odata/sap/UI_SMTR_PROJECT/downloadTranslationFile',
      opts: { query: { $format: 'json', ProjectID: "'Z''X'", downloadType: "'ALL'" }, headers: { Accept: 'application/json', 'User-Agent': 'adtplus' } },
    });
    expect(literal("it's")).toBe("'it''s'");
  });

  it("returns SAP's messages from sap-message, details flattened", async () => {
    const header = readFileSync(new URL('../capabilities/fixtures/translations/ZADTPLUS_TRPR_P2-ALL.sap-message.json', import.meta.url), 'utf8').trim();
    const rest = fakeRest(() => ({ status: 200, body: '{"d":{}}', headers: { 'sap-message': header } }));
    const { messages } = await getEntities(rest, '/Project');
    expect(messages).toEqual([
      { code: 'SMTR/108', message: 'No text found for NAME of business configuration object ZADTPLUS_CURR in language EN.', severity: 'warning' },
      { code: 'SMTR/108', message: 'No text found for DESCRIPTION of business configuration object ZADTPLUS_CURR in language EN.', severity: 'warning' },
    ]);
    expect(parseSapMessages('not json')).toEqual([{ code: '', message: 'not json', severity: 'unknown' }]);
  });

  it("throws SAP's error code and text; a 401 stays an auth failure", async () => {
    const body = '{"error":{"code":"SMTR/176","message":{"lang":"en","value":"Translation from EN to DE does not exist in project ZADTPLUS_TRPR_P4."}}}';
    await expect(callFunction(fakeRest(() => ({ status: 400, body })), 'downloadTranslationFile', {})).rejects.toThrow(
      'UI_SMTR_PROJECT downloadTranslationFile failed (HTTP 400 SMTR/176): Translation from EN to DE does not exist in project ZADTPLUS_TRPR_P4.',
    );
    const err = await getEntities(fakeRest(() => ({ status: 401, body: '' })), '/Project').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RawAdtError);
    expect((err as RawAdtError).isAuthFailure).toBe(true);
  });

  it('never reads an answer it does not know as success', async () => {
    await expect(getEntities(fakeRest(() => ({ status: 200, body: '<html>logon</html>' })), '/Project')).rejects.toThrow(/not an OData JSON answer: <html>logon/);
    await expect(getEntities(fakeRest(() => ({ status: 302, body: '', headers: { location: '/logon' } })), '/Project')).rejects.toThrow(/HTTP 302.*\/logon/);
    await expect(getEntities(fakeRest(() => ({ status: 204, body: '' })), '/Project')).rejects.toThrow(/HTTP 204/);
  });
});
