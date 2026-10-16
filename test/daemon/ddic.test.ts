import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawAdtClient, RequestOptions } from '../../src/backends/rawadt.js';
import type { Destination } from '../../src/core/destinations.js';
import type { SessionManager } from '../../src/core/session.js';
import { createDaemonServer } from '../../src/daemon/server.js';

// Domains and data elements as form-based objects through the REST fallback.

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-ddic-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  user: 'DEVELOPER',
  writeAllowlist: ['ZPKG'],
};

const DTEL_URI = '/sap/bc/adt/ddic/dataelements/zadtplus_de';
const DOMA_URI = '/sap/bc/adt/ddic/domains/zadtplus_dom';

const DATA_ELEMENT =
  '<blue:wbobj adtcore:masterLanguage="EN" adtcore:abapLanguageVersion="standard" adtcore:name="ZADTPLUS_DE" adtcore:type="DTEL/DE" ' +
  'adtcore:version="active" adtcore:description="Demo" xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<adtcore:packageRef adtcore:name="ZPKG"/><dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">' +
  '<dtel:typeKind>domain</dtel:typeKind><dtel:typeName>ZADTPLUS_DOM</dtel:typeName><dtel:dataType>CHAR</dtel:dataType>' +
  '<dtel:dataTypeLength>000001</dtel:dataTypeLength><dtel:dataTypeDecimals>000000</dtel:dataTypeDecimals>' +
  '<dtel:shortFieldLabel>Flag</dtel:shortFieldLabel><dtel:shortFieldLength>10</dtel:shortFieldLength><dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength>' +
  '<dtel:mediumFieldLabel>Flag</dtel:mediumFieldLabel><dtel:mediumFieldLength>20</dtel:mediumFieldLength><dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength>' +
  '<dtel:longFieldLabel>Flag</dtel:longFieldLabel><dtel:longFieldLength>40</dtel:longFieldLength><dtel:longFieldMaxLength>40</dtel:longFieldMaxLength>' +
  '<dtel:headingFieldLabel>Flag</dtel:headingFieldLabel><dtel:headingFieldLength>55</dtel:headingFieldLength><dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength>' +
  '<dtel:searchHelp/><dtel:searchHelpParameter/><dtel:setGetParameter/><dtel:defaultComponentName/>' +
  '<dtel:deactivateInputHistory>false</dtel:deactivateInputHistory><dtel:changeDocument>false</dtel:changeDocument>' +
  '<dtel:leftToRightDirection>false</dtel:leftToRightDirection><dtel:deactivateBIDIFiltering>false</dtel:deactivateBIDIFiltering>' +
  '</dtel:dataElement></blue:wbobj>';

const DOMAIN =
  '<doma:domain adtcore:masterLanguage="EN" adtcore:abapLanguageVersion="standard" adtcore:name="ZADTPLUS_DOM" adtcore:type="DOMA/DD" ' +
  'adtcore:version="active" adtcore:description="Demo" xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<adtcore:packageRef adtcore:name="ZPKG"/><doma:content>' +
  '<doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>000001</doma:length><doma:decimals>000000</doma:decimals></doma:typeInformation>' +
  '<doma:outputInformation><doma:length>000001</doma:length><doma:style>00</doma:style><doma:conversionExit/><doma:signExists>false</doma:signExists>' +
  '<doma:lowercase>false</doma:lowercase><doma:ampmFormat>false</doma:ampmFormat></doma:outputInformation>' +
  '<doma:valueInformation><doma:valueTableRef/><doma:appendExists>false</doma:appendExists><doma:fixValues>' +
  '<doma:fixValue><doma:position>0001</doma:position><doma:low>X</doma:low><doma:high/><doma:text>Yes</doma:text></doma:fixValue>' +
  '</doma:fixValues></doma:valueInformation></doma:content></doma:domain>';

const ACTIVATED =
  '<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><chkl:properties checkExecuted="true" activationExecuted="true" generationExecuted="false"/></chkl:messages>';

function daemonWith() {
  const calls: Array<{ method: string; path: string; opts: RequestOptions }> = [];
  const stored = new Map<string, string>([
    [DTEL_URI, DATA_ELEMENT],
    [DOMA_URI, DOMAIN],
  ]);
  const request = async (method: string, p: string, opts: RequestOptions = {}) => {
    calls.push({ method, path: p, opts });
    const ok = (body = '') => ({ status: 200, headers: new Headers(), body });
    if (opts.query?._action === 'LOCK') return ok('<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR>DEVK900001</CORRNR>');
    if (p === '/sap/bc/adt/activation') {
      // SAP activates what was sent: each reads as active afterwards.
      for (const [uri, body] of stored) stored.set(uri, body.replace(/adtcore:version="\w+"/, 'adtcore:version="active"'));
      return ok(ACTIVATED);
    }
    if (method === 'PUT') stored.set(p, opts.body as string);
    if (method === 'DELETE') stored.delete(p);
    if (method === 'GET') {
      const body = stored.get(p);
      return body ? ok(body) : { status: 404, headers: new Headers(), body: '' };
    }
    return ok();
  };
  const expectOk = (method: string, p: string, _context: string, opts?: RequestOptions) => request(method, p, opts);
  const rest = { request, expectOk, stateful: <T>(fn: () => Promise<T>) => fn() } as unknown as RawAdtClient;
  const adt = { raw: { lsp: vi.fn() } } as unknown as AdtLsClient;
  const sessionManager = {
    get: vi.fn(async () => ({ adt, info: { adtLsVersion: '1.1.2' } })),
    withRest: vi.fn(async (_key: string, fn: (r: RawAdtClient) => Promise<unknown>) => fn(rest)),
    nativeSupport: vi.fn(async () => ({ domain: false, dataElement: false })),
    register: vi.fn((d: Destination) => d.id),
    disposeAll: vi.fn(async () => {}),
  } as unknown as SessionManager;
  const daemon = createDaemonServer({
    sessionManager,
    destinations: { onprem },
    socketPath: path.join(dir, 's.sock'),
    deny: [],
    callLog: null,
    resolveAdtLsPath: () => {
      throw new Error('no adt-ls in this test');
    },
  });
  return { daemon, calls, adt };
}

const DTEL = { name: 'ZADTPLUS_DE', objectType: 'DTEL/DE' };
const DOMA = { name: 'ZADTPLUS_DOM', objectType: 'DOMA/DD' };

describe('domains and data elements as objects', () => {
  it.each([
    {
      ref: DOMA,
      properties: { format: { dataType: 'CHAR', length: 1 }, fixedValues: [{ fixedValue: 'X', description: 'Yes' }] },
      refused: 'a DOMA read returns its properties, not "grep"',
    },
    {
      ref: DTEL,
      properties: { dataTypeInformation: { category: 'domain', typeName: 'ZADTPLUS_DOM' }, fieldLabels: { short: 'Flag', shortLength: 10 } },
      refused: 'a DTEL read returns its properties, not "grep"',
    },
  ])('$ref.objectType: read as AFF properties through REST; source narrowing refused', async ({ ref, properties, refused }) => {
    const { daemon } = daemonWith();
    try {
      expect(await daemon.handleRequest({ cmd: 'object.read', system: 'onprem', ref })).toMatchObject({
        ok: true,
        result: { name: ref.name, package: 'ZPKG', version: 'active', properties, via: 'rest-fallback', nativeAvailable: false },
      });
      expect(await daemon.handleRequest({ cmd: 'object.read', system: 'onprem', ref, grep: 'x' })).toMatchObject({ ok: false, error: refused });
    } finally {
      await daemon.close();
    }
  });

  it.each([
    {
      objectType: 'DOMA/DD',
      bad: { format: { dataType: 'FOO', length: 1 } },
      badError: 'format.dataType must be equal to one of the allowed values',
      good: { format: { dataType: 'CHAR', length: 1 } },
      fieldsError: 'a domain takes "properties", not additionalFields',
    },
    {
      objectType: 'DTEL/DE',
      bad: { dataTypeInformation: { category: 'foo' } },
      badError: 'dataTypeInformation.category must be equal to one of the allowed values',
      good: { dataTypeInformation: { category: 'domain', typeName: 'X' } },
      fieldsError: 'a data element takes "properties", not additionalFields',
    },
  ])('$objectType: create takes properties, not additionalFields, and refuses a value AFF doesn\'t know before any call', async ({ objectType, bad, badError, good, fieldsError }) => {
    const { daemon, calls } = daemonWith();
    try {
      const base = { cmd: 'object.create', system: 'onprem', ref: { name: 'ZADTPLUS_NEW', objectType }, package: 'ZPKG', description: 'New' } as const;
      expect(await daemon.handleRequest({ ...base, properties: bad })).toMatchObject({ ok: false, error: expect.stringContaining(badError) });
      expect(await daemon.handleRequest({ ...base, additionalFields: { x: 1 }, properties: good })).toMatchObject({ ok: false, error: fieldsError });
      expect(calls).toEqual([]);
    } finally {
      await daemon.close();
    }
  });

  it('update replaces a fixed value list sent, and answers the domain before', async () => {
    const { daemon, calls } = daemonWith();
    try {
      const res = await daemon.handleRequest({
        cmd: 'object.update',
        system: 'onprem',
        ref: DOMA,
        properties: { fixedValues: [{ fixedValue: 'Y', description: 'Other' }] },
      });
      expect(res).toMatchObject({
        ok: true,
        result: {
          properties: { fixedValues: [{ fixedValue: 'Y', description: 'Other' }] },
          previous: { fixedValues: [{ fixedValue: 'X', description: 'Yes' }] },
          transport: 'DEVK900001',
        },
      });
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  it('update merges a label, and answers the data element before', async () => {
    const { daemon, calls } = daemonWith();
    try {
      const res = await daemon.handleRequest({ cmd: 'object.update', system: 'onprem', ref: DTEL, properties: { fieldLabels: { short: 'Switch' } } });
      expect(res).toMatchObject({
        ok: true,
        result: {
          properties: { fieldLabels: { short: 'Switch', medium: 'Flag' } },
          previous: { fieldLabels: { short: 'Flag' } },
          transport: 'DEVK900001',
        },
      });
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  it('activates a data element and its domain in one ADT activation, not through adt-ls', async () => {
    const { daemon, calls, adt } = daemonWith();
    try {
      const refs = [DTEL, { name: 'ZADTPLUS_DOM', objectType: 'DOMA/DD' }];
      expect(await daemon.handleRequest({ cmd: 'object.activate', system: 'onprem', refs })).toMatchObject({
        ok: true,
        result: { checkExecuted: true, activationExecuted: true, diagnostics: [] },
      });
      const activations = calls.filter((c) => c.path === '/sap/bc/adt/activation');
      expect(activations).toHaveLength(1);
      expect(activations[0]!.opts.body).toContain(`adtcore:uri="${DOMA_URI}"`);
      expect(activations[0]!.opts.body).toContain(`adtcore:uri="${DTEL_URI}"`);
      expect(adt.raw.lsp).not.toHaveBeenCalled();
      // One kind alone: the other kind's gate is skipped.
      expect(await daemon.handleRequest({ cmd: 'object.activate', system: 'onprem', refs: [DOMA] })).toMatchObject({ ok: true, result: { activationExecuted: true } });
      expect(adt.raw.lsp).not.toHaveBeenCalled();
      expect(await daemon.handleRequest({ cmd: 'object.activate', system: 'onprem', refs: [DOMA], forceActivation: true })).toMatchObject({
        ok: false,
        error: expect.stringContaining('forceActivation is not available for domains'),
      });
      expect(await daemon.handleRequest({ cmd: 'object.activate', system: 'onprem', refs: [DTEL], forceActivation: true })).toMatchObject({
        ok: false,
        error: expect.stringContaining('forceActivation is not available for domains and data elements'),
      });
    } finally {
      await daemon.close();
    }
  });

  it.each([
    { ref: DOMA, result: { domain: 'ZADTPLUS_DOM', deleted: true } },
    { ref: DTEL, result: { dataElement: 'ZADTPLUS_DE', deleted: true } },
  ])('$ref.objectType: delete through REST with confirm', async ({ ref, result }) => {
    const { daemon } = daemonWith();
    try {
      expect(await daemon.handleRequest({ cmd: 'object.delete', system: 'onprem', ref })).toMatchObject({ ok: false, error: expect.stringContaining('confirm') });
      expect(await daemon.handleRequest({ cmd: 'object.delete', system: 'onprem', ref, confirm: true })).toMatchObject({ ok: true, result });
    } finally {
      await daemon.close();
    }
  });
});
