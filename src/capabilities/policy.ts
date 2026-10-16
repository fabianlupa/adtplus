import type { Destination } from '../core/destinations.js';
import { objectPlacement, type PackageChainLookup } from '../core/placement.js';
import type { ResolvedObject } from '../core/resolve.js';

/**
 * The one write rule (docs/decisions/003-write-gates.md): a write is allowed when the package it lands
 * in is covered by an entry of `destination.writeAllowlist`. A plain string
 * entry covers that package only; `{package, subpackages: true}` covers its
 * whole subtree. An object lands in its own package, a package in its
 * superpackage (core/placement.ts), so the same rule governs object writes and
 * package create/edit/delete — and an allowlist root is never itself deletable.
 *
 * Fails closed: an unknown chain, or a chain lookup that fails, is a refusal.
 */
export async function assertPackageWritable(
  destination: Destination,
  packageName: string,
  where: { chain?: string[]; lookupChain?: PackageChainLookup } = {},
): Promise<void> {
  const pkg = packageName.toUpperCase();
  const entries = allowlistEntries(destination);
  if (entries.some((e) => e.package === pkg)) return;

  const subtrees = entries.filter((e) => e.subpackages);
  if (subtrees.length > 0) {
    let chain = where.chain;
    if (!chain && where.lookupChain) {
      try {
        chain = await where.lookupChain(pkg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `adt+ system "${destination.id}": cannot tell whether package "${pkg}" is inside the write allowlist ` +
            `(${describeAllowlist(entries)}): ${message}`,
        );
      }
    }
    const upper = chain?.map((c) => c.toUpperCase()) ?? [];
    if (subtrees.some((e) => upper.includes(e.package))) return;
  }
  throw new Error(
    `adt+ system "${destination.id}": package "${pkg}" is not in the write allowlist (${describeAllowlist(entries)})`,
  );
}

/**
 * The rule for a write to an object `resolveObject` has just resolved. The
 * package comes from the resolved URI; an object whose package cannot be read
 * off it is refused.
 */
export async function assertObjectWritable(destination: Destination, resolved: ResolvedObject): Promise<void> {
  const placement = objectPlacement(resolved.uri, resolved);
  if (!placement) {
    throw new Error(
      `adt+ system "${destination.id}": cannot tell which package ${resolved.objectType} "${resolved.name}" ` +
        `is in (${resolved.uri}), so the write is refused`,
    );
  }
  await assertPackageWritable(destination, placement.package, { chain: placement.chain });
}

interface AllowlistEntry {
  package: string;
  subpackages: boolean;
}

function allowlistEntries(destination: Destination): AllowlistEntry[] {
  return destination.writeAllowlist.map((e) =>
    typeof e === 'string'
      ? { package: e.toUpperCase(), subpackages: false }
      : { package: e.package.toUpperCase(), subpackages: e.subpackages === true },
  );
}

function describeAllowlist(entries: AllowlistEntry[]): string {
  return entries.map((e) => (e.subpackages ? `${e.package} and its subpackages` : e.package)).join(', ') || 'empty';
}

/** Refuse a destructive action unless the caller explicitly confirmed it. */
export function assertConfirmed(action: string, confirm: boolean | undefined): void {
  if (!confirm) {
    throw new Error(`"${action}" is destructive and requires confirm: true`);
  }
}

/**
 * `run` executes arbitrary ABAP, which can read data anywhere, so it is off
 * unless the system's policy sets `allowRun: true` (ADR-005).
 */
export function assertRunAllowed(destination: Destination): void {
  if (destination.allowRun !== true) {
    throw new Error(
      `adt+ system "${destination.id}": run is off here. It needs "allowRun": true ` +
        `for this system in systems.json, or in the project config that sets it (\`adtplus config show\` names the file).`,
    );
  }
}

/**
 * Data preview reads whatever the SAP user may read on the system, SAP tables included, so it is
 * off unless the system's policy sets `allowDataPreview: true` (ADR-013).
 */
export function assertDataPreviewAllowed(destination: Destination): void {
  if (destination.allowDataPreview !== true) {
    throw new Error(
      `adt+ system "${destination.id}": data preview is off here. It needs "allowDataPreview": true ` +
        `for this system in systems.json, or in the project config that sets it (\`adtplus config show\` names the file).`,
    );
  }
}

/**
 * Runtime logs can hold business data (a dump's variables, a gateway error's message), so short
 * dumps and the gateway error log are off unless the system's policy sets
 * `allowRuntimeLogs: true` (ADR-015). System messages are ungated (ADR-018).
 */
export function assertRuntimeLogsAllowed(destination: Destination): void {
  if (destination.allowRuntimeLogs !== true) {
    throw new Error(
      `adt+ system "${destination.id}": runtime logs are off here. They need "allowRuntimeLogs": true ` +
        `for this system in systems.json, or in the project config that sets it (\`adtplus config show\` names the file).`,
    );
  }
}

/**
 * Translations go through an unreleased OData UI service (`UI_SMTR_PROJECT`), outside ADR-005's
 * ADT APIs, so `object translations` and every action on `TRPR` are off unless the system's
 * policy sets `allowTranslations: true` (ADR-019).
 */
export function assertTranslationsAllowed(destination: Destination): void {
  if (destination.allowTranslations !== true) {
    throw new Error(
      `adt+ system "${destination.id}": translations are off here. They need "allowTranslations": true ` +
        `for this system in systems.json, or in the project config that sets it (\`adtplus config show\` names the file).`,
    );
  }
}

/**
 * Publish and unpublish are on unless the system's policy sets
 * `allowPublishService: false`.
 *
 * It used to be on-prem-only, because cloud un-publish was unproven from adt-ls
 * (M6.0 finding 6). M6.4a proved both directions on `cloud-erp`, so that default no
 * longer described a capability — and nothing else about a cloud publish is
 * exceptional: generating an IAM app is simply how a local service endpoint is
 * published on public cloud. The one property worth knowing, that a cloud publish
 * cannot be undone for some minutes afterwards, belongs in the error a caller
 * actually reads (see `publishService`), not in a default that differs per system.
 * The write allowlist applies as to any write (`assertObjectWritable` on the
 * binding), and `confirm: true` stays as the model-side speed bump (ADR-003).
 */
export function assertPublishServiceAllowed(destination: Destination): void {
  if (destination.allowPublishService === false) {
    throw new Error(
      `adt+ system "${destination.id}": publish and unpublish are disabled here by ` +
        `"allowPublishService": false in this system's policy.`,
    );
  }
}
