import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { ALL_CMDS, GIT_ONLY_CMDS } from '../../src/daemon/protocol.js';
import { READ_ONLY_CMDS } from '../../src/daemon/readonly.js';
import { createMcpServer } from '../../src/mcp/server.js';

/** The five tools that only ever issue a `READ_ONLY_CMDS` command. */
const READ_TOOLS = ['adtplus_system', 'adtplus_transport', 'adtplus_object', 'adtplus_navigate', 'adtplus_quality'];
/** The other six: write, irreversible, or execute. */
const OTHER_TOOLS = [
  'adtplus_transport_write',
  'adtplus_object_write',
  'adtplus_mirror_write',
  'adtplus_irreversible',
  'adtplus_test',
  'adtplus_run',
];
/** Reads SAP but writes local files (ADR-007): not readOnlyHint, yet kept in read-only mode. */
const LOCAL_WRITE_TOOLS = ['adtplus_mirror'];
/** Reads table contents (ADR-013): readOnlyHint, listed only while a system allows data preview. */
const DATA_TOOL = 'adtplus_data';
const RUNTIME_TOOL = 'adtplus_runtime';
/** Read tools listed only while some system switches them on (ADR-013, ADR-015). */
const GATED_READ_TOOLS = [DATA_TOOL, RUNTIME_TOOL];

async function listTools(server: ReturnType<typeof createMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/** Every `cmd: 'x.y'` literal inside one `registerTool('adtplus_foo', ...)` block, source-scanned like deny.test.ts does for the daemon. */
function commandsPerTool(): Map<string, string[]> {
  const source = readFileSync(path.join(__dirname, '../../src/mcp/server.ts'), 'utf8');
  const blocks = [...source.matchAll(/server\.registerTool\(\s*\n\s*'(adtplus_\w+)',([\s\S]*?)\n {2}\);/g)];
  const result = new Map<string, string[]>();
  for (const [, name, body] of blocks) {
    const cmds = [...body!.matchAll(/cmd:\s*'([a-zA-Z.]+)'/g)].map((m) => m[1]!);
    result.set(name!, [...new Set(cmds)]);
  }
  return result;
}

describe('adtplus_* tool surface (docs/decisions/018-names-and-grouping.md)', () => {
  it('registers 12 tools when a system allows run, 14 with data preview and runtime logs, one risk tier each', async () => {
    const tools = await listTools(createMcpServer({ runSystems: ['onprem'] }));
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...OTHER_TOOLS, ...LOCAL_WRITE_TOOLS].sort());
    const all = await listTools(createMcpServer({ runSystems: ['onprem'], dataSystems: ['onprem'], runtimeSystems: ['onprem'] }));
    expect(all).toHaveLength(14);
  });

  it('leaves adtplus_run out when no system sets allowRun: true (ADR-005)', async () => {
    const tools = await listTools(createMcpServer());
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...READ_TOOLS, ...OTHER_TOOLS, ...LOCAL_WRITE_TOOLS].filter((t) => t !== 'adtplus_run').sort(),
    );
  });

  it('adtplus_run takes only the systems that allow run', async () => {
    const tools = await listTools(createMcpServer({ runSystems: ['onprem'] }));
    const run = tools.find((t) => t.name === 'adtplus_run');
    expect((run?.inputSchema.properties?.system as { enum?: string[] }).enum).toEqual(['onprem']);
  });

  it('ADTPLUS_READONLY leaves the five read tools and adtplus_mirror', async () => {
    const tools = await listTools(createMcpServer({ readOnly: true }));
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...LOCAL_WRITE_TOOLS].sort());
  });

  it('adtplus_mirror is not read-only, not destructive, open world (ADR-007)', async () => {
    const tools = await listTools(createMcpServer({ readOnly: true }));
    const mirror = tools.find((t) => t.name === 'adtplus_mirror');
    expect(mirror?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect((mirror?.inputSchema.properties?.action as { enum?: string[] }).enum).toEqual(['init', 'pull', 'status', 'check', 'new']);
  });

  it('adtplus_mirror_write offers push and activate, not read-only, gone in read-only mode and per action under deny', async () => {
    const tools = await listTools(createMcpServer());
    const write = tools.find((t) => t.name === 'adtplus_mirror_write');
    expect(write?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect((write?.inputSchema.properties?.action as { enum?: string[] }).enum).toEqual(['push', 'activate']);
    expect((await listTools(createMcpServer({ readOnly: true }))).map((t) => t.name)).not.toContain('adtplus_mirror_write');
    const denied = (await listTools(createMcpServer({ deny: ['mirror.activate'] }))).find((t) => t.name === 'adtplus_mirror_write');
    expect((denied?.inputSchema.properties?.action as { enum?: string[] }).enum).toEqual(['push']);
  });

  it('ADTPLUS_DENY takes single mirror actions out', async () => {
    const tools = await listTools(createMcpServer({ deny: ['mirror.pull'] }));
    const mirror = tools.find((t) => t.name === 'adtplus_mirror');
    expect((mirror?.inputSchema.properties?.action as { enum?: string[] }).enum).toEqual(['init', 'status', 'check', 'new']);
    const none = await listTools(createMcpServer({ deny: ['mirror.*'] }));
    expect(none.map((t) => t.name)).not.toContain('adtplus_mirror');
  });

  it('ADTPLUS_DENY on the three irreversible commands drops only adtplus_irreversible', async () => {
    const tools = await listTools(createMcpServer({ deny: ['object.delete', 'object.deleteMessages', 'transport.release'], runSystems: ['onprem'] }));
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...READ_TOOLS, ...OTHER_TOOLS, ...LOCAL_WRITE_TOOLS].filter((t) => t !== 'adtplus_irreversible').sort());
    expect(names).toHaveLength(11);
  });

  it('every read tool is readOnlyHint: true, every other tool is false', async () => {
    const tools = await listTools(createMcpServer({ dataSystems: ['onprem'], runtimeSystems: ['onprem'] }));
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(GATED_READ_TOOLS));
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(READ_TOOLS.includes(tool.name) || GATED_READ_TOOLS.includes(tool.name));
    }
  });

  it('a tool is offered read-only exactly when every daemon command it can issue is in READ_ONLY_CMDS', () => {
    const perTool = commandsPerTool();
    expect([...perTool.keys()].sort()).toEqual([...READ_TOOLS, ...OTHER_TOOLS, ...LOCAL_WRITE_TOOLS, ...GATED_READ_TOOLS].sort());
    for (const [tool, cmds] of perTool) {
      expect(cmds.length).toBeGreaterThan(0);
      const allReadOnly = cmds.every((c) => READ_ONLY_CMDS.has(c as never));
      expect(allReadOnly, `${tool}: ${cmds.join(', ')}`).toBe(
        READ_TOOLS.includes(tool) || LOCAL_WRITE_TOOLS.includes(tool) || GATED_READ_TOOLS.includes(tool),
      );
    }
  });

  it('adtplus_data is listed only while a system allows data preview, and takes only those (ADR-013)', async () => {
    expect((await listTools(createMcpServer())).map((t) => t.name)).not.toContain(DATA_TOOL);
    const data = (await listTools(createMcpServer({ dataSystems: ['cloud-erp'] }))).find((t) => t.name === DATA_TOOL);
    expect((data?.inputSchema.properties?.system as { enum?: string[] }).enum).toEqual(['cloud-erp']);
    expect(data?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('adtplus_data stays in read-only mode and goes under ADTPLUS_DENY', async () => {
    expect((await listTools(createMcpServer({ readOnly: true, dataSystems: ['onprem'] }))).map((t) => t.name)).toContain(DATA_TOOL);
    expect((await listTools(createMcpServer({ deny: ['data.*'], dataSystems: ['onprem'] }))).map((t) => t.name)).not.toContain(DATA_TOOL);
  });

  it('adtplus_runtime is listed only while a system allows runtime logs, and takes only those (ADR-015)', async () => {
    expect((await listTools(createMcpServer())).map((t) => t.name)).not.toContain(RUNTIME_TOOL);
    const runtime = (await listTools(createMcpServer({ runtimeSystems: ['cloud-erp'] }))).find((t) => t.name === RUNTIME_TOOL);
    expect((runtime?.inputSchema.properties?.system as { enum?: string[] }).enum).toEqual(['cloud-erp']);
    expect((runtime?.inputSchema.properties?.action as { enum?: string[] }).enum).toEqual(['dumps', 'dump', 'gatewayErrors', 'gatewayError']);
    expect(runtime?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('adtplus_runtime stays in read-only mode; ADTPLUS_DENY takes an action or the tool', async () => {
    expect((await listTools(createMcpServer({ readOnly: true, runtimeSystems: ['onprem'] }))).map((t) => t.name)).toContain(RUNTIME_TOOL);
    expect((await listTools(createMcpServer({ deny: ['runtime.*'], runtimeSystems: ['onprem'] }))).map((t) => t.name)).not.toContain(RUNTIME_TOOL);
    const listOnly = (await listTools(createMcpServer({ deny: ['runtime.dump', 'runtime.gatewayError'], runtimeSystems: ['onprem'] }))).find((t) => t.name === RUNTIME_TOOL);
    expect((listOnly?.inputSchema.properties?.action as { enum?: string[] }).enum).toEqual(['dumps', 'gatewayErrors']);
  });

  it('system messages are ungated in adtplus_system (ADR-018)', async () => {
    const system = (await listTools(createMcpServer({ readOnly: true }))).find((t) => t.name === 'adtplus_system');
    expect((system?.inputSchema.properties?.action as { enum?: string[] }).enum).toEqual(['status', 'connect', 'messages']);
    const denied = (await listTools(createMcpServer({ deny: ['system.messages'] }))).find((t) => t.name === 'adtplus_system');
    expect((denied?.inputSchema.properties?.action as { enum?: string[] }).enum).toEqual(['status', 'connect']);
  });

  it('every daemon command the MCP server can issue is reachable through exactly one tool', () => {
    const perTool = commandsPerTool();
    const seen = new Map<string, string>();
    for (const [tool, cmds] of perTool) {
      for (const cmd of cmds) {
        expect(seen.has(cmd), `"${cmd}" claimed by both ${seen.get(cmd)} and ${tool}`).toBe(false);
        seen.set(cmd, tool);
      }
    }
    // Every ALL_CMDS entry is reachable except the client's own handshake (ping, shutdown) and the
    // git remote helper's own commands (ADR-011: no MCP tool), never a tool.
    expect([...seen.keys()].sort()).toEqual(ALL_CMDS.filter((c) => c !== 'ping' && c !== 'shutdown' && !GIT_ONLY_CMDS.includes(c)).sort());
  });

  it('adtplus_irreversible requires confirm: true on every action', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({
      name: 'adtplus_irreversible',
      arguments: { action: 'deleteObject', system: 'onprem', name: 'ZX', objectType: 'CLAS/OC' },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('confirm: true');
    await client.close();
  });

  it('adtplus_object_write create refuses a source instead of dropping it', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({
      name: 'adtplus_object_write',
      arguments: {
        action: 'create', system: 'onprem', name: 'ZBP_X', objectType: 'CLAS/OC', package: 'ZADTPLUS_MB_GREEN', description: 'x',
        source: 'CLASS zbp_x DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF zx.\nENDCLASS.',
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toMatch(/takes no "source".*nothing was created.*"update"/);
    await client.close();
  });
});
