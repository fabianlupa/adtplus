import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installExtraCaCerts } from '../../src/core/cacerts.js';
import type { Destination } from '../../src/core/destinations.js';

function pem(marker: string): string {
  return `-----BEGIN CERTIFICATE-----\n${marker}\n-----END CERTIFICATE-----`;
}

function destination(id: string, extraCaCerts: string[]): Destination {
  return {
    id,
    kind: 'onprem',
    auth: 'basic',
    client: '100',
    systemUrl: `https://${id}.example:44300`,
    extraCaCerts,
    writeAllowlist: [],
  };
}

let dir: string;
let setSpy: ReturnType<typeof vi.spyOn>;
let installed: string[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'adtplus-ca-'));
  installed = ['-----BEGIN CERTIFICATE-----\nBUNDLED\n-----END CERTIFICATE-----'];
  vi.spyOn(tls, 'getCACertificates').mockImplementation(() => [...installed]);
  setSpy = vi.spyOn(tls, 'setDefaultCACertificates').mockImplementation((certs) => {
    installed = [...(certs as string[])];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installExtraCaCerts', () => {
  it('adds every PEM block to the default list without replacing the bundle', async () => {
    const file = path.join(dir, 'corp.pem');
    await writeFile(file, `${pem('ROOT')}\n${pem('INTERMEDIATE')}\n`);

    const result = await installExtraCaCerts({ onprem: destination('onprem', [file]) });

    expect(result).toEqual({ files: [file], added: 2 });
    const applied = setSpy.mock.calls[0]![0] as string[];
    // The bundled CA survives — cloud-erp's public cloud endpoint depends on it.
    expect(applied[0]).toContain('BUNDLED');
    expect(applied).toHaveLength(3);
    expect(applied.some((c) => c.includes('ROOT'))).toBe(true);
    expect(applied.some((c) => c.includes('INTERMEDIATE'))).toBe(true);
  });

  it('is idempotent and reads a file shared by two systems once', async () => {
    const file = path.join(dir, 'corp.pem');
    await writeFile(file, `${pem('ROOT')}\n`);
    const destinations = { onprem: destination('onprem', [file]), s4d: destination('s4d', [file]) };

    const first = await installExtraCaCerts(destinations);
    expect(first).toEqual({ files: [file], added: 1 });

    const second = await installExtraCaCerts(destinations);
    expect(second.added).toBe(0);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no system configures extraCaCerts', async () => {
    const result = await installExtraCaCerts({ 'cloud-erp': destination('cloud-erp', []) });

    expect(result).toEqual({ files: [], added: 0 });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('names the system and path when a certificate file is unreadable', async () => {
    const missing = path.join(dir, 'nope.pem');

    await expect(installExtraCaCerts({ onprem: destination('onprem', [missing]) })).rejects.toThrow(
      /system "onprem": cannot read extraCaCerts file ".*nope\.pem"/,
    );
  });

  it('rejects a file with no PEM certificate block', async () => {
    const file = path.join(dir, 'junk.pem');
    await writeFile(file, 'not a certificate\n');

    await expect(installExtraCaCerts({ onprem: destination('onprem', [file]) })).rejects.toThrow(
      /contains no PEM CERTIFICATE block/,
    );
  });
});
