import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import type { Destination } from '../core/destinations.js';
import { resolveObject } from '../core/resolve.js';
import { assertConfirmed, assertObjectWritable, assertRunAllowed } from './policy.js';

export interface RunApplicationInput {
  ref: ObjectRef;
  confirm?: boolean;
}

/**
 * Run an `if_oo_adt_classrun` object and return its console output. Executing
 * code counts as a write: only objects in the write allowlist run (docs/decisions/003-write-gates.md),
 * and only on systems with `allowRun: true` (docs/decisions/005-api-policy-scope.md).
 */
export async function runApplication(
  adt: AdtLsClient,
  destination: Destination,
  input: RunApplicationInput,
): Promise<{ output: string }> {
  assertRunAllowed(destination);
  assertConfirmed('run application', input.confirm);
  const resolved = await resolveObject(adt, input.ref);
  await assertObjectWritable(destination, resolved);
  return adt.services.runApplication(resolved);
}
