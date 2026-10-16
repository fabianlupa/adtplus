import { execFile } from 'node:child_process';

/**
 * Read a macOS Keychain generic-password secret by service name.
 * Uses execFile (argv array, no shell), per ADR-001 finding 4 — the `onprem`
 * password contains `"`, so it must never pass through a shell string.
 */
export async function readKeychainSecret(service: string): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      (err, out) => {
        if (err) reject(err);
        else resolve(out);
      },
    );
  });
  return stdout.replace(/\n$/, '');
}

/**
 * Whether a Keychain generic-password item exists for this service. Leaves out
 * `-w`, so `security` prints only the item's attributes and never the secret;
 * that output is discarded. Exit code 44 is "not found".
 */
export async function keychainEntryExists(service: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', service], (err) => {
      if (!err) resolve(true);
      else if ((err as { code?: unknown }).code === 44) resolve(false);
      else reject(err);
    });
  });
}
