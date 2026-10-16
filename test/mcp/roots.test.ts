import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectConfigSetsFromRoots, workspaceFoldersFromRoots } from '../../src/mcp/roots.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { vi } from 'vitest';
import { createMcpServer, followRoots, setDataSystems, setRuntimeSystems, setRunSystems } from '../../src/mcp/server.js';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'adtplus-roots-')));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function project(folder: string): string {
  const dir = path.join(home, folder, '.adtplus');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'systems.json');
  writeFileSync(file, '{}');
  return file;
}

describe('projectConfigSetsFromRoots', () => {
  it('gives one chain per local folder, duplicates dropped', () => {
    const cust = project('cust');
    const repo = project('cust/repo');
    mkdirSync(path.join(home, 'cust', 'other'), { recursive: true });
    mkdirSync(path.join(home, 'plain'), { recursive: true });
    const uri = (p: string) => pathToFileURL(path.join(home, p)).href;

    const sets = projectConfigSetsFromRoots(
      [uri('cust/repo'), uri('cust/other'), uri('cust'), uri('plain'), 'https://example.com/remote'],
      home,
    );

    expect(sets).toEqual([[repo, cust], [cust], []]);
  });

  it('is undefined without a local folder, so the client default applies', () => {
    expect(projectConfigSetsFromRoots([], home)).toBeUndefined();
    expect(projectConfigSetsFromRoots(['vscode-vfs://github/x/y'], home)).toBeUndefined();
  });
});

describe('adtplus_run follows its systems', () => {
  async function connected(server: ReturnType<typeof createMcpServer>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    let changed = 0;
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/tools/list_changed') changed++;
    };
    const run = async () => (await client.listTools()).tools.find((t) => t.name === 'adtplus_run');
    return { client, run, changes: () => changed };
  }

  it('appears, changes its system list, and disappears, telling the client each time', async () => {
    const server = createMcpServer();
    const { client, run, changes } = await connected(server);

    expect(await run()).toBeUndefined();

    setRunSystems(server, ['cust', 'onprem']);
    const shown = await run();
    expect((shown?.inputSchema.properties?.system as { enum?: string[] }).enum).toEqual(['cust', 'onprem']);

    setRunSystems(server, []);
    expect(await run()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(changes()).toBeGreaterThanOrEqual(2);
    await client.close();
  });

  it('never appears in read-only mode', async () => {
    const server = createMcpServer({ readOnly: true });
    const { client, run } = await connected(server);
    setRunSystems(server, ['onprem']);
    expect(await run()).toBeUndefined();
    await client.close();
  });
});

describe('adtplus_data follows its systems', () => {
  it('appears with its systems and disappears again, in read-only mode too', async () => {
    const server = createMcpServer({ readOnly: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const data = async () => (await client.listTools()).tools.find((t) => t.name === 'adtplus_data');

    expect(await data()).toBeUndefined();
    setDataSystems(server, ['cloud-erp']);
    expect(((await data())?.inputSchema.properties?.system as { enum?: string[] }).enum).toEqual(['cloud-erp']);
    setDataSystems(server, []);
    expect(await data()).toBeUndefined();
    await client.close();
  });
});

describe('adtplus_runtime follows its systems', () => {
  it('appears with its systems and disappears again, in read-only mode too', async () => {
    const server = createMcpServer({ readOnly: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const runtime = async () => (await client.listTools()).tools.find((t) => t.name === 'adtplus_runtime');

    expect(await runtime()).toBeUndefined();
    setRuntimeSystems(server, ['onprem']);
    expect(((await runtime())?.inputSchema.properties?.system as { enum?: string[] }).enum).toEqual(['onprem']);
    setRuntimeSystems(server, []);
    expect(await runtime()).toBeUndefined();
    await client.close();
  });
});

describe('workspaceFoldersFromRoots', () => {
  it('keeps the local folders, once each; undefined without one', () => {
    const a = pathToFileURL(path.join(home, 'a')).href;
    expect(workspaceFoldersFromRoots([a, 'abap:/repotree-v1/x/', a])).toEqual([path.join(home, 'a')]);
    expect(workspaceFoldersFromRoots(['adt://onprem/x'])).toBeUndefined();
  });
});

describe('followRoots', () => {
  it('reads the roots after initialization and again when they change', async () => {
    const server = createMcpServer();
    const scopes: (string[][] | undefined)[] = [];
    followRoots(server, (sets) => scopes.push(sets), home);
    const cust = project('cust');
    mkdirSync(path.join(home, 'plain'), { recursive: true });
    let roots = [{ uri: pathToFileURL(path.join(home, 'cust')).href }];

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }));
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await vi.waitFor(() => expect(scopes).toHaveLength(1));
    expect(scopes[0]).toEqual([[cust]]);

    roots = [{ uri: pathToFileURL(path.join(home, 'plain')).href }];
    await client.sendRootsListChanged();
    await vi.waitFor(() => expect(scopes).toHaveLength(2));
    expect(scopes[1]).toEqual([[]]);
    await client.close();
  });

  it('reads the local folders of a workspace that also holds non-file roots (ADT system folders)', async () => {
    const server = createMcpServer();
    const scopes: (string[][] | undefined)[] = [];
    const folders: (string[] | undefined)[] = [];
    const ready = followRoots(
      server,
      (sets, local) => {
        scopes.push(sets);
        folders.push(local);
      },
      home,
    );
    const cust = project('cust');
    const roots = [
      { uri: pathToFileURL(path.join(home, 'cust')).href },
      { uri: 'adt://onprem/System%20Library/ZADTPLUS_TEST', name: 'DEV' },
      { uri: 'abap:/repotree-v1/adtplus_cloud-erp/', name: 'DEV' },
    ];

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }));
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await ready();
    expect(scopes).toEqual([[[cust]]]);
    expect(folders).toEqual([[path.join(home, 'cust')]]);
    await client.close();
  });

  it('leaves the default when the client has no roots support', async () => {
    const server = createMcpServer();
    const setScope = vi.fn();
    followRoots(server, setScope);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    await new Promise((r) => setTimeout(r, 20));
    expect(setScope).not.toHaveBeenCalled();
    await client.close();
  });

  describe('the wait every request goes through', () => {
    const connectWith = async (
      answer: () => Promise<{ uri: string }[]>,
      waitMs?: number,
      capabilities: object = { roots: { listChanged: true } },
    ) => {
      const server = createMcpServer();
      const scopes: (string[][] | undefined)[] = [];
      const ready = followRoots(server, (sets) => scopes.push(sets), home, waitMs);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities });
      if ('roots' in capabilities) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: await answer() }));
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      return { client, ready, scopes };
    };

    it('waits for roots that arrive late', async () => {
      const cust = pathToFileURL(path.join(home, 'cust')).href;
      const { client, ready, scopes } = await connectWith(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [{ uri: cust }];
      });
      await ready();
      expect(scopes).toHaveLength(1);
      await client.close();
    });

    it('refuses while a client with roots has not answered in time', async () => {
      const { client, ready } = await connectWith(() => new Promise(() => {}), 50);
      await expect(ready()).rejects.toThrow(/not named its workspace folders/);
      await client.close();
    });

    it('refuses after a failed roots/list and asks again on the next call', async () => {
      let fail = true;
      const cust = pathToFileURL(path.join(home, 'cust')).href;
      const { client, ready, scopes } = await connectWith(async () => {
        if (fail) throw new Error('boom');
        return [{ uri: cust }];
      });
      await expect(ready()).rejects.toThrow(/could not read the workspace folders/);
      fail = false;
      await ready();
      expect(scopes).toHaveLength(1);
      await client.close();
    });

    it('waits for the new roots after roots/list_changed', async () => {
      let delay = 0;
      const { client, ready, scopes } = await connectWith(async () => {
        await new Promise((r) => setTimeout(r, delay));
        return [{ uri: pathToFileURL(path.join(home, 'cust')).href }];
      });
      await ready();
      delay = 100;
      await client.sendRootsListChanged();
      await new Promise((r) => setTimeout(r, 20));
      await ready();
      expect(scopes).toHaveLength(2);
      await client.close();
    });

    it('does not wait for a client without roots support', async () => {
      const { client, ready } = await connectWith(async () => [], 50, {});
      await ready();
      await client.close();
    });
  });
});
