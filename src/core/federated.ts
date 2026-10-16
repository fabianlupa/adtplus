import { parseFederated } from '@arc-mcp/adt-ls';

/**
 * The payload of one of adt-ls's own (federated) MCP tools, or an error naming `what`. A tool
 * refuses either with `isError` or with an "Error: …" text as its result; both throw here.
 */
export function federatedResult(res: unknown, what: string): unknown {
  const { ok, data, text } = parseFederated(res);
  if (!ok || (typeof data === 'string' && /^\s*error\b/i.test(data))) {
    const reason = text.replace(/^\s*Error:\s*/i, '');
    // What the ATC tools answer for a name the backend can't find.
    const hint = /executing tool: null$/.test(reason) ? ' (an object not found gives this; check name and type)' : '';
    throw new Error(`${what}: ${reason}${hint}`);
  }
  return data;
}
