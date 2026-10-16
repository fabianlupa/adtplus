import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawAdtClient, RequestOptions } from '../../src/backends/rawadt.js';
import type { Destination } from '../../src/core/destinations.js';
import type { SessionManager } from '../../src/core/session.js';
import { createDaemonServer } from '../../src/daemon/server.js';

// Packages and message classes as objects with AFF properties (docs/decisions/018-names-and-grouping.md).

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-dform-')));
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
  writeAllowlist: ['ZDEV_MAIN', 'ZPKG'],
};

const packageXml = (description: string, applicationComponent = '') =>
  '<pak:package adtcore:responsible="DEVELOPER" adtcore:masterLanguage="EN" adtcore:name="ZADTPLUS_ORDERS" adtcore:type="DEVC/K" ' +
  `adtcore:description="${description}" xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core">` +
  '<pak:attributes pak:packageType="development" pak:recordChanges="false" pak:languageVersion=""/>' +
  '<pak:superPackage adtcore:name="ZDEV_MAIN"/>' +
  `<pak:applicationComponent pak:name="${applicationComponent}"/>` +
  '<pak:transport><pak:softwareComponent pak:name="LOCAL"/><pak:transportLayer pak:name=""/></pak:transport></pak:package>';

const CLASS =
  '<mc:messageClass adtcore:masterLanguage="EN" adtcore:name="ZADTPLUS_MSG" adtcore:type="MSAG/N" adtcore:description="Demo" ' +
  'xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<adtcore:packageRef adtcore:name="ZPKG"/>' +
  '<mc:messages mc:msgno="001" mc:msgtext="Order &amp;1 not found" mc:selfexplainatory="true"/></mc:messageClass>';

function daemonWith() {
  const calls: Array<{ method: string; path: string; opts: RequestOptions }> = [];
  let pkg = packageXml('Orders');
  let mc = CLASS;
  let gone = false;
  const request = async (method: string, p: string, opts: RequestOptions = {}) => {
    calls.push({ method, path: p, opts });
    const isPackage = p.includes('/packages/');
    if (opts.query?._action === 'LOCK') return { status: 200, headers: new Headers(), body: '<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR></CORRNR>' };
    if (method === 'PUT' && isPackage) pkg = opts.body as string;
    if (method === 'PUT' && !isPackage) {
      // An upsert: keep the stored messages, add the sent ones.
      const sent = (opts.body as string).match(/<mc:messages [^>]*\/>/g) ?? [];
      mc = mc.replace('</mc:messageClass>', `${sent.filter((m) => !m.includes('msgno="001"')).join('')}</mc:messageClass>`);
    }
    if (method === 'DELETE') gone = true;
    if (method === 'GET') {
      if (gone) return { status: 404, headers: new Headers(), body: '' };
      return { status: 200, headers: new Headers(), body: isPackage ? pkg : mc };
    }
    return { status: 200, headers: new Headers(), body: '' };
  };
  const expectOk = (method: string, p: string, _context: string, opts?: RequestOptions) => request(method, p, opts);
  const rest = { request, expectOk, stateful: <T>(fn: () => Promise<T>) => fn() } as unknown as RawAdtClient;
  const adt = {
    lifecycle: { create: vi.fn(), resolveAffUri: vi.fn() },
    repository: { delete: vi.fn() },
    transport: { check: vi.fn(async () => ({ locks: [] })) },
  } as unknown as AdtLsClient;
  const sessionManager = {
    get: vi.fn(async () => ({ adt, info: { adtLsVersion: '1.1.2' } })),
    withRest: vi.fn(async (_key: string, fn: (r: RawAdtClient) => Promise<unknown>) => fn(rest)),
    nativeSupport: vi.fn(async () => ({ messageClass: false, packageCreate: false })),
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
  return { daemon, calls, adt, sessionManager };
}

const DEVC = { name: 'ZADTPLUS_ORDERS', objectType: 'DEVC/K' };
const MSAG = { name: 'ZADTPLUS_MSG', objectType: 'MSAG/N' };

describe('packages as objects', () => {
  it('read as their AFF properties, through REST', async () => {
    const { daemon } = daemonWith();
    try {
      const res = await daemon.handleRequest({ cmd: 'object.read', system: 'onprem', ref: DEVC });
      expect(res).toMatchObject({
        ok: true,
        result: {
          name: 'ZADTPLUS_ORDERS',
          objectType: 'DEVC/K',
          properties: {
            formatVersion: '1',
            header: { description: 'Orders', originalLanguage: 'en' },
            generalInformation: { type: 'development', superPackage: 'ZDEV_MAIN', softwareComponent: 'LOCAL', supportsRecordChanges: false, defaultAbapLanguageVersion: 'standard' },
          },
          via: 'rest-fallback',
        },
      });
      const narrowed = await daemon.handleRequest({ cmd: 'object.read', system: 'onprem', ref: DEVC, grep: 'x' });
      expect(narrowed).toMatchObject({ ok: false, error: 'a DEVC read returns its properties, not "grep"' });
    } finally {
      await daemon.close();
    }
  });

  it('update the description from properties, gated by the superpackage, and read it back', async () => {
    const { daemon, calls } = daemonWith();
    try {
      const res = await daemon.handleRequest({ cmd: 'object.update', system: 'onprem', ref: DEVC, properties: { header: { description: 'Orders 2' } } });
      expect(res).toMatchObject({ ok: true, result: { package: { description: 'Orders 2' } } });
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
      const refused = await daemon.handleRequest({
        cmd: 'object.update',
        system: 'onprem',
        ref: DEVC,
        properties: { generalInformation: { softwareComponent: 'HOME' } },
      });
      expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('generalInformation.softwareComponent: adt+ changes') });
      const source = await daemon.handleRequest({ cmd: 'object.update', system: 'onprem', ref: DEVC, source: 'x' });
      expect(source).toMatchObject({ ok: false, error: expect.stringContaining('through "properties"') });
    } finally {
      await daemon.close();
    }
  });

  it('delete through object.delete with DEVC/K', async () => {
    const { daemon, calls } = daemonWith();
    try {
      const res = await daemon.handleRequest({ cmd: 'object.delete', system: 'onprem', ref: DEVC, confirm: true });
      expect(res).toMatchObject({ ok: true, result: { name: 'ZADTPLUS_ORDERS', deleted: true } });
      expect(calls.some((c) => c.method === 'DELETE' && c.path.includes('/packages/zadtplus_orders'))).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('validate takes a package only so far, refused before any session', async () => {
    const { daemon, sessionManager } = daemonWith();
    try {
      const res = await daemon.handleRequest({
        cmd: 'object.validate',
        system: 'onprem',
        ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
        package: 'ZPKG',
        description: 'x',
      });
      expect(res).toMatchObject({ ok: false, error: 'validate takes a package (DEVC/K) so far, not CLAS/OC' });
      expect(sessionManager.get).not.toHaveBeenCalled();
    } finally {
      await daemon.close();
    }
  });
});

describe('message classes through properties', () => {
  it('a create whose messages SAP would refuse creates nothing', async () => {
    const { daemon, calls } = daemonWith();
    try {
      const res = await daemon.handleRequest({
        cmd: 'object.create',
        system: 'onprem',
        ref: { name: 'ZADTPLUS_NEW', objectType: 'MSAG/N' },
        package: 'ZPKG',
        description: 'New',
        properties: { messages: [{ number: '001', text: 'a\nb' }] },
      });
      expect(res).toMatchObject({ ok: false, error: 'message 001: the text has a line break or control character' });
      expect(calls).toHaveLength(0);
    } finally {
      await daemon.close();
    }
  });

  it('properties on a source-based type point to additionalFields', async () => {
    const { daemon } = daemonWith();
    try {
      const res = await daemon.handleRequest({
        cmd: 'object.create',
        system: 'onprem',
        ref: { name: 'ZCL_X', objectType: 'CLAS/OC' },
        package: 'ZPKG',
        description: 'x',
        properties: {},
      });
      expect(res).toMatchObject({ ok: false, error: 'CLAS/OC takes additionalFields, not "properties"' });
    } finally {
      await daemon.close();
    }
  });

  it('update adds a message; the others and the self-explanatory flag stay as they are', async () => {
    const { daemon, calls } = daemonWith();
    try {
      const res = await daemon.handleRequest({
        cmd: 'object.update',
        system: 'onprem',
        ref: MSAG,
        properties: { messages: [{ number: '002', text: 'Customer missing' }] },
      });
      expect(res).toMatchObject({ ok: true, result: { messageClass: 'ZADTPLUS_MSG', messages: [{ number: '002', text: 'Customer missing' }] } });
      const put = calls.find((c) => c.method === 'PUT')!;
      expect(put.opts.body).toContain('mc:msgno="002"');
      expect(put.opts.body).not.toContain('mc:msgno="001"');
      const flag = await daemon.handleRequest({
        cmd: 'object.update',
        system: 'onprem',
        ref: MSAG,
        properties: { messages: [{ number: '001', text: 'x', selfExplanatory: false }] },
      });
      expect(flag).toMatchObject({ ok: false, error: expect.stringContaining('"selfExplanatory", which AFF doesn\'t know') });
    } finally {
      await daemon.close();
    }
  });
});
