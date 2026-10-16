import type { AdtLsClient } from '@arc-mcp/adt-ls';

/**
 * Runtime probe for the REST-fallback rows. adt+ keeps using REST while these are false; once a
 * system reports native support (ADT for VS Code 1.2 / Cloud 2702), results
 * and `adtplus_status` flag the fallback as retirable. Switching to the native
 * path is a code change made after a live test, not an automatic one.
 */
export interface NativeSupport {
  /** `getCreatableObjectTypes` lists a DEVC type. */
  packageCreate: boolean;
  /** adt-ls's MCP tool list has a transport release tool. adt-ls 1.1.2 has
   * none; custom `adtLs/*` requests aren't advertised, so the tool list is
   * the only runtime signal. */
  transportRelease: boolean;
  /** adt-ls's MCP tool list has a timeline or version-history tool: change dates without REST (ADR-011's
   * `changedAt` fallback). adt-ls 1.1.2 has none. */
  changeStamps: boolean;
  /** adt-ls's MCP tool list has a tool that reads a request's objects (`transport read`'s fallback).
   * adt-ls 1.1.2 has `abap_transport-get` (find for an object), `-create` and
   * `-unifiedDifference`, none of them that. */
  transportContents: boolean;
  /** `getCreatableObjectTypes` lists an MSAG type: adt-ls 1.1.2 serves message classes as a
   * placeholder and refuses writes and deletes (the message class fallback). */
  messageClass: boolean;
  /** `getCreatableObjectTypes` lists a DOMA type: adt-ls 1.1.2 serves domains as a placeholder, has no
   * creation adapter for them, and its activation answers "Internal error." (the domain fallback). */
  domain: boolean;
  /** `getCreatableObjectTypes` lists a DTEL type: adt-ls 1.1.2 serves data elements as a placeholder and
   * has no creation adapter for them (the data element fallback). */
  dataElement: boolean;
  /** adt-ls's MCP tool list has a data preview or SQL tool (the data query fallback). adt-ls 1.1.2
   * bundles no data preview plug-in. */
  dataPreview: boolean;
  /** adt-ls's MCP tool list has a syntax check tool (SAP's, from 2702/2027), the route for checking
   * unsaved text without the check run fallback. adt-ls 1.1.2 checks stored source only. */
  syntaxText: boolean;
  /** adt-ls's MCP tool list has a feed, dump or error log tool (SAP's feeds tool, from 2702/2027):
   * the runtime log fallbacks (ADR-015). adt-ls 1.1.2 has none. */
  runtimeFeeds: boolean;
  probedAt: string;
}

export async function probeNativeSupport(adt: AdtLsClient): Promise<NativeSupport> {
  const [creatable, caps] = await Promise.all([
    adt.lifecycle.listCreatableObjects().catch(() => null),
    adt.capabilities().catch(() => null),
  ]);
  return {
    packageCreate: /"DEVC\//.test(JSON.stringify(creatable ?? null)),
    transportRelease: (caps?.tools ?? []).some((t) => /transport/i.test(t.name) && /release/i.test(t.name)),
    changeStamps: (caps?.tools ?? []).some((t) => /timeline|version.?history|changed.?at/i.test(t.name)),
    transportContents: (caps?.tools ?? []).some((t) => /transport/i.test(t.name) && /objects|contents|details|read/i.test(t.name)),
    messageClass: /"MSAG\//.test(JSON.stringify(creatable ?? null)),
    domain: /"DOMA\//.test(JSON.stringify(creatable ?? null)),
    dataElement: /"DTEL\//.test(JSON.stringify(creatable ?? null)),
    dataPreview: (caps?.tools ?? []).some((t) => /data.?preview|freestyle|sql.?(console|query)|(run|execute).?sql/i.test(t.name)),
    syntaxText: (caps?.tools ?? []).some((t) => /syntax/i.test(t.name)),
    runtimeFeeds: (caps?.tools ?? []).some((t) => /dump|feed|runtime.?error|error.?log|system.?message/i.test(t.name)),
    probedAt: new Date().toISOString(),
  };
}
