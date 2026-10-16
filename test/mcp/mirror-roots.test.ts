import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonRequest } from '../../src/daemon/protocol.js';

const sent: DaemonRequest[] = [];
vi.mock('../../src/daemon/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/daemon/client.js')>()),
  sendCommand: vi.fn(async (req: DaemonRequest) => {
    sent.push(req);
    return { ok: true, result: null };
  }),
}));

const { createMcpServer } = await import('../../src/mcp/server.js');

const WS = '/work/ws';

async function session() {
  const server = createMcpServer({ folders: async () => [WS] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const UPDATE = { action: 'update', system: 'onprem', name: 'ZCL_A', objectType: 'CLAS/OC', source: 'x' };
const lastUpdate = () => sent.filter((r) => r.cmd === 'object.update').at(-1) as Extract<DaemonRequest, { cmd: 'object.update' }>;

afterEach(() => {
  sent.length = 0;
});

describe('the mirrors a session used ride on updateSource (ADR-009)', () => {
  it('sends none before a mirror call, then every root the session named, with its workspace folders', async () => {
    const client = await session();
    await client.callTool({ name: 'adtplus_object_write', arguments: UPDATE });
    expect(lastUpdate()).not.toHaveProperty('mirrorRoots');

    await client.callTool({ name: 'adtplus_mirror', arguments: { action: 'status', root: 'mirror-onprem' } });
    await client.callTool({ name: 'adtplus_mirror_write', arguments: { action: 'push', system: 'onprem', root: '/work/ws/other', dryRun: true } });
    await client.callTool({ name: 'adtplus_mirror', arguments: { action: 'status', root: 'mirror-onprem' } });
    await client.callTool({ name: 'adtplus_object_write', arguments: UPDATE });
    expect(lastUpdate()).toMatchObject({ mirrorRoots: ['/work/ws/mirror-onprem', '/work/ws/other'], workspaceFolders: [WS] });
    await client.close();
  });

  it('a new session starts with no mirrors', async () => {
    const first = await session();
    await first.callTool({ name: 'adtplus_mirror', arguments: { action: 'status' } });
    await first.close();
    const second = await session();
    await second.callTool({ name: 'adtplus_object_write', arguments: UPDATE });
    expect(lastUpdate()).not.toHaveProperty('mirrorRoots');
    await second.close();
  });
});

describe('a check target', () => {
  it('passes every target given on, so the daemon refuses name + objectType beside a package', async () => {
    const client = await session();
    await client.callTool({
      name: 'adtplus_quality',
      arguments: { action: 'atc', system: 'onprem', name: 'ZCL_X', objectType: 'CLAS/OC', package: 'ZPKG' },
    });
    expect(sent.at(-1)).toMatchObject({ cmd: 'quality.atc', ref: { name: 'ZCL_X', objectType: 'CLAS/OC' }, package: 'ZPKG' });
    await client.close();
  });

  it('refuses a name without an objectType instead of checking the package alone', async () => {
    const client = await session();
    const before = sent.length;
    const res = await client.callTool({ name: 'adtplus_quality', arguments: { action: 'atc', system: 'onprem', name: 'ZCL_X', package: 'ZPKG' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('give \\"name\\" and \\"objectType\\" together');
    expect(sent.length).toBe(before);
    await client.close();
  });
});
