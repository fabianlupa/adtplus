import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDestinations } from '../../src/core/config-check.js';
import type { Destination } from '../../src/core/destinations.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adtplus-config-check-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function destination(fields: Partial<Destination> & { id: string }): Destination {
  return {
    kind: 'onprem',
    auth: 'interactive',
    client: '100',
    systemUrl: 'https://x',
    extraCaCerts: [],
    writeAllowlist: [],
    ...fields,
  };
}

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

describe('checkDestinations', () => {
  it('passes a basic system whose Keychain item and CA file exist', async () => {
    const ca = path.join(dir, 'ca.pem');
    writeFileSync(ca, PEM);
    const looked: string[] = [];

    const checks = await checkDestinations(
      { onprem: destination({ id: 'onprem', auth: 'basic', user: 'U', keychainService: 'SVC', extraCaCerts: [ca] }) },
      { keychainEntryExists: async (s) => (looked.push(s), true) },
    );

    expect(checks).toEqual([{ system: 'onprem', problems: [] }]);
    expect(looked).toEqual(['SVC']);
  });

  it('reports a basic system without user or keychainService', async () => {
    const checks = await checkDestinations({ onprem: destination({ id: 'onprem', auth: 'basic' }) }, { keychainEntryExists: async () => true });

    expect(checks[0]?.problems).toEqual(['basic auth needs "user"', 'basic auth needs "keychainService"']);
  });

  it('reports a missing Keychain item and a failed lookup', async () => {
    const [missing, failed] = await checkDestinations(
      {
        a: destination({ id: 'a', keychainService: 'NOPE' }),
        b: destination({ id: 'b', keychainService: 'ERR' }),
      },
      {
        keychainEntryExists: async (s) => {
          if (s === 'ERR') throw new Error('security not found');
          return false;
        },
      },
    );

    expect(missing?.problems).toEqual(['no Keychain item for service "NOPE"']);
    expect(failed?.problems).toEqual(['Keychain lookup failed: security not found']);
  });

  it('reports a CA file that is missing or holds no certificate', async () => {
    const empty = path.join(dir, 'empty.pem');
    writeFileSync(empty, 'not a cert');
    const missing = path.join(dir, 'missing.pem');

    const [check] = await checkDestinations({ onprem: destination({ id: 'onprem', extraCaCerts: [missing, empty] }) });

    expect(check?.problems).toHaveLength(2);
    expect(check?.problems[0]).toMatch(new RegExp(`^extraCaCerts "${missing}": .*ENOENT`));
    expect(check?.problems[1]).toMatch(/contains no PEM CERTIFICATE block/);
  });
});
