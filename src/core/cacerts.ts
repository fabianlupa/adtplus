import { readFile } from 'node:fs/promises';
import tls from 'node:tls';
import type { Destination } from './destinations.js';

/**
 * Teach *this Node process* the systems' extra CA certificates.
 *
 * `extraCaCerts` in systems.json is forwarded to adt-ls, but that only feeds
 * the language server's JVM truststore. Node keeps its own,
 * and every direct HTTP call adt+ makes runs on Node's: the Basic
 * reentrance-ticket GET in core/session.ts, the whole REST fallback in
 * backends/rawadt.ts, and the ticket redeem in core/reentrance.ts. Without
 * this, `onprem`'s corporate CA is unknown here and those calls die with
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY — which, in the logon handler, used to
 * look like a 180 s "Waiting for user logon timed out".
 *
 * `NODE_EXTRA_CA_CERTS` does the same job, but Node reads it once at startup,
 * so the daemon cannot set it for itself. `tls.setDefaultCACertificates()` is
 * the runtime equivalent (Node >= 22.15).
 *
 * The extras are *added* to the default bundle, never substituted for it:
 * `cloud-erp`'s cloud endpoint is signed by a public CA and must keep working.
 */

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export interface CaCertInstallResult {
  /** Certificate files read, in the order they were applied. */
  files: string[];
  /** PEM blocks newly added to the default list (0 when already present). */
  added: number;
}

export function splitPem(content: string, file: string): string[] {
  const blocks = content.match(PEM_BLOCK);
  if (!blocks?.length) {
    throw new Error(`adt+ CA certificate file "${file}" contains no PEM CERTIFICATE block`);
  }
  return blocks.map((block) => block.trim());
}

/**
 * Add every configured `extraCaCerts` file to this process's default CA list.
 *
 * Idempotent: certificates already in the list are skipped, so calling it
 * again (or configuring the same file on two systems) adds nothing.
 */
export async function installExtraCaCerts(
  destinations: Record<string, Destination>,
): Promise<CaCertInstallResult> {
  // First file wins for the error message; a file shared by two systems is read once.
  const wanted = new Map<string, string>();
  for (const destination of Object.values(destinations)) {
    for (const file of destination.extraCaCerts) {
      if (!wanted.has(file)) wanted.set(file, destination.id);
    }
  }
  if (wanted.size === 0) return { files: [], added: 0 };

  if (typeof tls.setDefaultCACertificates !== 'function') {
    throw new Error(
      `adt+ needs Node >= 22.15 to trust extraCaCerts (${[...wanted.keys()].join(', ')}); ` +
        `this is ${process.version}. Either upgrade Node, or start the daemon with ` +
        'NODE_EXTRA_CA_CERTS=<pem> pointing at the same file.',
    );
  }

  const current = tls.getCACertificates('default');
  const seen = new Set(current.map((pem) => pem.trim()));
  const added: string[] = [];

  for (const [file, system] of wanted) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (err) {
      throw new Error(
        `adt+ system "${system}": cannot read extraCaCerts file "${file}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    for (const pem of splitPem(content, file)) {
      if (seen.has(pem)) continue;
      seen.add(pem);
      added.push(pem);
    }
  }

  if (added.length > 0) tls.setDefaultCACertificates([...current, ...added]);
  return { files: [...wanted.keys()], added: added.length };
}
