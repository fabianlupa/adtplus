import { readFile } from 'node:fs/promises';
import { splitPem } from './cacerts.js';
import type { Destination } from './destinations.js';
import { keychainEntryExists } from './keychain.js';

/** What `adtplus config validate` found for one system: empty `problems` means it's fine. */
export interface SystemCheck {
  system: string;
  problems: string[];
}

export interface CheckOptions {
  /** Testing seam: replaces the Keychain lookup. */
  keychainEntryExists?: (service: string) => Promise<boolean>;
}

/**
 * Check what `loadDestinations` doesn't: that a basic-auth system names a user
 * and a Keychain item that exists, and that each extraCaCerts file reads and
 * holds a certificate. Reads no secret and opens no SAP session.
 */
export async function checkDestinations(
  destinations: Record<string, Destination>,
  opts: CheckOptions = {},
): Promise<SystemCheck[]> {
  const hasEntry = opts.keychainEntryExists ?? keychainEntryExists;
  const checks: SystemCheck[] = [];
  for (const destination of Object.values(destinations)) {
    const problems: string[] = [];
    if (destination.auth === 'basic') {
      if (!destination.user) problems.push('basic auth needs "user"');
      if (!destination.keychainService) problems.push('basic auth needs "keychainService"');
    }
    if (destination.keychainService) {
      try {
        if (!(await hasEntry(destination.keychainService))) {
          problems.push(`no Keychain item for service "${destination.keychainService}"`);
        }
      } catch (err) {
        problems.push(`Keychain lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const file of destination.extraCaCerts) {
      try {
        splitPem(await readFile(file, 'utf8'), file);
      } catch (err) {
        problems.push(`extraCaCerts "${file}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    checks.push({ system: destination.id, problems });
  }
  return checks;
}
