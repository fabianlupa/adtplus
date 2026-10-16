import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawAdtClient, RequestOptions } from '../../src/backends/rawadt.js';
import type { Destination } from '../../src/core/destinations.js';
import type { SessionManager } from '../../src/core/session.js';
import { createDaemonServer } from '../../src/daemon/server.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-dmsag-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  extraCaCerts: [],
  writeAllowlist: ['ZPKG'],
};

const CLASS =
  '<mc:messageClass adtcore:masterLanguage="EN" adtcore:name="ZADTPLUS_MSG" adtcore:type="MSAG/N" adtcore:description="Demo" ' +
  'xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<adtcore:packageRef adtcore:name="ZPKG"/>' +
  '<mc:messages mc:msgno="001" mc:msgtext="Order &amp;1 not found" mc:selfexplainatory="true"/>' +
  '<mc:messages mc:msgno="002" mc:msgtext="Customer missing" mc:selfexplainatory="false"/></mc:messageClass>';

function daemonWith(readOnly = false) {
  const calls: Array<{ method: string; path: string; opts: RequestOptions }> = [];
  let gone = false;
  const request = async (method: string, p: string, opts: RequestOptions = {}) => {
    calls.push({ method, path: p, opts });
    if (method === 'DELETE') gone = true;
    const body = opts.query?._action === 'LOCK' ? '<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR>DEVK900001</CORRNR>' : method === 'GET' && !gone ? CLASS : '';
    return { status: method === 'GET' && gone ? 404 : 200, headers: new Headers(), body };
  };
  const expectOk = (method: string, p: string, _context: string, opts?: RequestOptions) => request(method, p, opts);
  const rest = { request, expectOk, stateful: <T>(fn: () => Promise<T>) => fn() } as unknown as RawAdtClient;
  const adt = { lifecycle: { create: vi.fn() }, repository: { delete: vi.fn() } } as unknown as AdtLsClient;
  const sessionManager = {
    get: vi.fn(async () => ({ adt, info: { adtLsVersion: '1.1.2' } })),
    withRest: vi.fn(async (_key: string, fn: (r: RawAdtClient) => Promise<unknown>) => fn(rest)),
    nativeSupport: vi.fn(async () => ({ messageClass: false })),
    register: vi.fn((d: Destination) => d.id),
    disposeAll: vi.fn(async () => {}),
  } as unknown as SessionManager;
  const daemon = createDaemonServer({
    sessionManager,
    destinations: { onprem },
    socketPath: path.join(dir, 's.sock'),
    readOnly,
    deny: [],
    callLog: null,
    resolveAdtLsPath: () => {
      throw new Error('no adt-ls in this test');
    },
  });
  return { daemon, calls, adt };
}

describe('message classes in the daemon', () => {
  it('reads a message class through REST, grep filtering the messages', async () => {
    const { daemon } = daemonWith(true);
    try {
      const read = await daemon.handleRequest({ cmd: 'object.read', system: 'onprem', ref: { name: 'ZADTPLUS_MSG', objectType: 'MSAG/N' }, grep: 'customer' });
      expect(read).toMatchObject({
        ok: true,
        result: {
          name: 'ZADTPLUS_MSG',
          objectType: 'MSAG/N',
          totalMessages: 2,
          properties: { formatVersion: '1', messages: [{ number: '002', text: 'Customer missing' }] },
          via: 'rest-fallback',
          nativeAvailable: false,
        },
      });
      const narrowed = await daemon.handleRequest({ cmd: 'object.read', system: 'onprem', ref: { name: 'ZADTPLUS_MSG', objectType: 'MSAG' }, fromLine: 1 });
      expect(narrowed).toMatchObject({ ok: false, error: 'a MSAG read returns its properties and takes only "grep", not "fromLine"' });
    } finally {
      await daemon.close();
    }
  });

  it('creates and deletes a message class through REST, never adt-ls', async () => {
    const { daemon, calls, adt } = daemonWith();
    try {
      const fields = await daemon.handleRequest({
        cmd: 'object.create', system: 'onprem', ref: { name: 'ZADTPLUS_MSG', objectType: 'MSAG/N' }, package: 'ZPKG', description: 'Demo', additionalFields: { x: 1 },
      });
      expect(fields).toMatchObject({ ok: false, error: 'a message class takes "properties", not additionalFields' });
      const created = await daemon.handleRequest({
        cmd: 'object.create', system: 'onprem', ref: { name: 'ZADTPLUS_MSG', objectType: 'MSAG/N' }, package: 'ZPKG', description: 'Demo',
        transport: 'DEVK900001',
      });
      expect(created).toMatchObject({ ok: true, result: { messageClass: { name: 'ZADTPLUS_MSG' }, via: 'rest-fallback' } });
      const deleted = await daemon.handleRequest({ cmd: 'object.delete', system: 'onprem', ref: { name: 'ZADTPLUS_MSG', objectType: 'MSAG/N' }, confirm: true });
      expect(deleted).toMatchObject({ ok: true, result: { messageClass: 'ZADTPLUS_MSG', deleted: true } });
      expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
      expect(vi.mocked(adt.lifecycle.create)).not.toHaveBeenCalled();
      expect(vi.mocked(adt.repository.delete)).not.toHaveBeenCalled();
    } finally {
      await daemon.close();
    }
  });

  it('a read-only daemon refuses message writes', async () => {
    const { daemon, calls } = daemonWith(true);
    try {
      const res = await daemon.handleRequest({ cmd: 'object.update', system: 'onprem', ref: { name: 'ZADTPLUS_MSG', objectType: 'MSAG/N' }, properties: { messages: [{ number: '001', text: 'x' }] } });
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
      const del = await daemon.handleRequest({ cmd: 'object.deleteMessages', system: 'onprem', name: 'ZADTPLUS_MSG', numbers: [1], confirm: true });
      expect(del).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
      expect(calls).toHaveLength(0);
    } finally {
      await daemon.close();
    }
  });
});
