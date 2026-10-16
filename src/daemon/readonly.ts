import type { DaemonRequest } from './protocol.js';

/**
 * Read-only mode, for driving adt+ from a client whose own permissions cannot
 * deny a single MCP action. Off
 * unless ADTPLUS_READONLY is set.
 *
 * Two ways in, either one is enough: the daemon's own environment (every
 * request it serves), or the client's — `sendCommand` stamps `readOnly` onto
 * the request, so a read-only MCP server stays read-only even when it lands on
 * a daemon that some other, unrestricted client started.
 *
 * An allowlist, not a denylist: a command added later is refused until
 * someone decides it only reads.
 */
export const READ_ONLY_CMDS: ReadonlySet<DaemonRequest['cmd']> = new Set<DaemonRequest['cmd']>([
  'ping',
  // Replaces a stale daemon with a fresh one; touches no SAP system.
  'shutdown',
  'system.status',
  'system.connect',
  'transport.list',
  'transport.find',
  'transport.check',
  'transport.read',
  'transport.diff',
  'object.listInactive',
  'object.lockStatus',
  'object.read',
  // Reads through the OData UI service; off unless the system sets allowTranslations (ADR-019).
  'object.translations',
  // SAP's check of a create; creates nothing.
  'object.validate',
  'object.versions',
  'object.diff',
  'object.resolve',
  'object.search',
  'object.list',
  'object.generators',
  'object.generatorSchema',
  'object.serviceInfo',
  'navigate.whereUsed',
  'navigate.definition',
  'navigate.declaration',
  'navigate.hover',
  'navigate.outline',
  'navigate.typeHierarchy',
  'quality.syntax',
  'quality.format',
  'quality.atcVariants',
  'quality.atc',
  'quality.abaplint',
  // Reads table contents, changes nothing; off unless the system sets allowDataPreview (ADR-013).
  'data.query',
  // Read runtime logs, change nothing; off unless the system sets allowRuntimeLogs (ADR-015).
  'runtime.dumps',
  'runtime.dump',
  'runtime.gatewayErrors',
  'runtime.gatewayError',
  'system.messages',
  // Read from SAP and write only local files (ADR-007).
  'mirror.init',
  'mirror.pull',
  'mirror.changes',
  'swc.packages',
  'history.versions',
  'history.released',
  'mirror.status',
  'mirror.check',
  'mirror.new',
]);

/** Set and not `0`/`false` → on. Unset or empty → off. */
export function isReadOnlyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

/** The refusal text when `cmd` is not allowed in read-only mode, else undefined. */
export function readOnlyRefusal(cmd: string, readOnly: boolean): string | undefined {
  if (!readOnly || READ_ONLY_CMDS.has(cmd as DaemonRequest['cmd'])) return undefined;
  return `adt+ is read-only (ADTPLUS_READONLY): "${cmd}" refused`;
}
