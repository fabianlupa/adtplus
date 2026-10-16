import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSystemsConfigPath, loadConfig, loadDestinations, systemsConfigJsonSchema } from '../../src/core/destinations.js';
import { approve, sha256 } from '../../src/core/project-config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adtplus-destinations-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: unknown): string {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(content));
  return p;
}

describe('loadDestinations', () => {
  it('uses systems.json systemUrl directly when set (ONPREM: adtls has RFC, not HTTP)', async () => {
    const systemsConfigPath = write('systems.json', {
      onprem: {
        kind: 'onprem',
        auth: 'basic',
        client: '100',
        systemUrl: 'https://onprem.example:44300',
        user: 'DEVELOPER',
        keychainService: 'DEV_100_SECRET',
        writeAllowlist: ['ZADTPLUS_TEST'],
      },
    });
    const adtlsDestinationsPath = write('destinations.json', {
      formatVersion: '1.0',
      destinations: [
        {
          id: 'DEV_100_DEVELOPER_EN',
          protocol: 'rfc',
          properties: { systemId: 'DEV' },
        },
      ],
    });

    const dests = await loadDestinations({ systemsConfigPath, adtlsDestinationsPath });

    expect(dests.onprem?.systemUrl).toBe('https://onprem.example:44300');
    expect(dests.onprem?.writeAllowlist).toEqual(['ZADTPLUS_TEST']);
  });

  it('accepts subpackages entries next to plain ones and rejects unknown keys', async () => {
    const systemsConfigPath = write('systems.json', {
      onprem: {
        kind: 'onprem',
        auth: 'basic',
        client: '100',
        systemUrl: 'https://onprem.example:44300',
        writeAllowlist: ['ZADTPLUS_TEST', { package: 'ZADTPLUS_TEST_MCP', subpackages: true }],
      },
    });
    const dests = await loadDestinations({ systemsConfigPath, adtlsDestinationsPath: write('destinations.json', { destinations: [] }) });
    expect(dests.onprem?.writeAllowlist).toEqual(['ZADTPLUS_TEST', { package: 'ZADTPLUS_TEST_MCP', subpackages: true }]);

    const bad = write('systems.json', {
      onprem: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://onprem.example', writeAllowlist: [{ package: 'X', subpackage: true }] },
    });
    await expect(loadDestinations({ systemsConfigPath: bad, adtlsDestinationsPath: write('destinations.json', { destinations: [] }) })).rejects.toThrow();
  });

  it('resolves systemUrl from an HTTP adtls destination via adtlsDestinationId', async () => {
    const systemsConfigPath = write('systems.json', {
      'cloud-erp': {
        kind: 'cloud',
        auth: 'interactive',
        client: '100',
        adtlsDestinationId: 'cloud-erp-100',
        writeAllowlist: ['ZADTPLUS_TEST'],
      },
    });
    const adtlsDestinationsPath = write('destinations.json', {
      formatVersion: '1.0',
      destinations: [
        {
          id: 'cloud-erp-100',
          protocol: 'http',
          properties: { systemUrl: 'https://my000000-api.s4hana.cloud.sap' },
        },
      ],
    });

    const dests = await loadDestinations({ systemsConfigPath, adtlsDestinationsPath });

    expect(dests['cloud-erp']?.systemUrl).toBe('https://my000000-api.s4hana.cloud.sap');
  });

  it('rejects an adtlsDestinationId that resolves to a non-HTTP protocol', async () => {
    const systemsConfigPath = write('systems.json', {
      onprem: {
        kind: 'onprem',
        auth: 'basic',
        client: '100',
        adtlsDestinationId: 'DEV_100_DEVELOPER_EN',
        writeAllowlist: [],
      },
    });
    const adtlsDestinationsPath = write('destinations.json', {
      formatVersion: '1.0',
      destinations: [{ id: 'DEV_100_DEVELOPER_EN', protocol: 'rfc', properties: {} }],
    });

    await expect(
      loadDestinations({ systemsConfigPath, adtlsDestinationsPath }),
    ).rejects.toThrow(/protocol "rfc"/);
  });

  it('rejects an unknown adtlsDestinationId', async () => {
    const systemsConfigPath = write('systems.json', {
      'cloud-erp': { kind: 'cloud', auth: 'interactive', client: '100', adtlsDestinationId: 'MISSING' },
    });
    const adtlsDestinationsPath = write('destinations.json', {
      formatVersion: '1.0',
      destinations: [],
    });

    await expect(
      loadDestinations({ systemsConfigPath, adtlsDestinationsPath }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects a policy with neither systemUrl nor adtlsDestinationId', async () => {
    const systemsConfigPath = write('systems.json', {
      broken: { kind: 'onprem', auth: 'basic', client: '100' },
    });
    const adtlsDestinationsPath = write('destinations.json', { destinations: [] });

    await expect(
      loadDestinations({ systemsConfigPath, adtlsDestinationsPath }),
    ).rejects.toThrow(/neither/);
  });

  it('works when ~/.adtls/destinations.json does not exist', async () => {
    const systemsConfigPath = write('systems.json', {
      onprem: {
        kind: 'onprem',
        auth: 'basic',
        client: '100',
        systemUrl: 'https://onprem.example:44300',
      },
    });
    const missingAdtlsPath = path.join(dir, 'does-not-exist.json');

    const dests = await loadDestinations({
      systemsConfigPath,
      adtlsDestinationsPath: missingAdtlsPath,
    });

    expect(dests.onprem?.systemUrl).toBe('https://onprem.example:44300');
  });

  it('takes restTimeout in whole seconds from 1 to 3600', async () => {
    const entry = { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://onprem.example' };
    const load = (restTimeout: unknown) =>
      loadDestinations({ systemsConfigPath: write('systems.json', { onprem: { ...entry, restTimeout } }), adtlsDestinationsPath: path.join(dir, 'missing.json') });
    expect((await load(600)).onprem?.restTimeout).toBe(600);
    for (const bad of [0, 2.5, 3601, '120']) await expect(load(bad)).rejects.toThrow();
  });

  it('rejects an invalid systems.json (schema validation)', async () => {
    const systemsConfigPath = write('systems.json', {
      onprem: { kind: 'not-a-kind', auth: 'basic', client: '100', systemUrl: 'https://x' },
    });

    await expect(
      loadDestinations({
        systemsConfigPath,
        adtlsDestinationsPath: path.join(dir, 'missing.json'),
      }),
    ).rejects.toThrow();
  });

  it('names the file and each bad field in a schema error', async () => {
    const systemsConfigPath = write('systems.json', {
      onprem: { kind: 'not-a-kind', auth: 'basic', client: '100', systemUrl: 'https://x', writeAllowlist: [42] },
    });

    const err = await loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'missing.json') }).catch(
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`${systemsConfigPath}: invalid adt+ systems config`);
    expect((err as Error).message).toMatch(/^  onprem\.kind: /m);
    expect((err as Error).message).toMatch(/^  onprem\.writeAllowlist\.0: /m);
  });

  it('names the file when it is not valid JSON', async () => {
    const systemsConfigPath = path.join(dir, 'systems.json');
    writeFileSync(systemsConfigPath, '{ "onprem": ');
    const adtlsDestinationsPath = path.join(dir, 'destinations.json');
    writeFileSync(adtlsDestinationsPath, 'nope');

    await expect(
      loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'missing.json') }),
    ).rejects.toThrow(`${systemsConfigPath}: not valid JSON`);

    const valid = write('valid.json', { onprem: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://x' } });
    await expect(loadDestinations({ systemsConfigPath: valid, adtlsDestinationsPath })).rejects.toThrow(
      `${adtlsDestinationsPath}: not valid JSON`,
    );
  });

  it('accepts a "$schema" key and does not read it as a system', async () => {
    const systemsConfigPath = write('systems.json', {
      $schema: './systems.schema.json',
      onprem: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://x' },
    });

    const dests = await loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'missing.json') });

    expect(Object.keys(dests)).toEqual(['onprem']);
  });

  it('rejects an unknown field on a system, so a typo is not silently dropped', async () => {
    const systemsConfigPath = write('systems.json', {
      onprem: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://x', writeAllowList: ['Z'] },
    });

    await expect(
      loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'missing.json') }),
    ).rejects.toThrow(/onprem: Unrecognized key.*writeAllowList/);
  });

  it('throws when systems.json itself is missing', async () => {
    await expect(
      loadDestinations({
        systemsConfigPath: path.join(dir, 'missing-systems.json'),
        adtlsDestinationsPath: path.join(dir, 'missing.json'),
      }),
    ).rejects.toThrow(/No adt\+ systems config/);
  });

  it.each(['000', '066', '0', '66', ' 066 '])('refuses SAP-reserved client %j at load', async (client) => {
    const systemsConfigPath = write('systems.json', {
      onprem: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://onprem.example:44300' },
      bad: { kind: 'onprem', auth: 'basic', client, systemUrl: 'https://onprem.example:44300' },
    });

    await expect(
      loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'missing.json') }),
    ).rejects.toThrow(/adt\+ system "bad": client 0(00|66) is SAP-reserved/);
  });

  it('refuses a reserved client before resolving the system URL', async () => {
    const systemsConfigPath = write('systems.json', {
      'cloud-erp': { kind: 'cloud', auth: 'interactive', client: '000', adtlsDestinationId: 'MISSING' },
    });

    await expect(
      loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'missing.json') }),
    ).rejects.toThrow(/SAP-reserved/);
  });

  it('accepts other clients, including ones that start with 0', async () => {
    const systemsConfigPath = write('systems.json', {
      'cloud-erp': { kind: 'cloud', auth: 'interactive', client: '100', systemUrl: 'https://cloud-erp.example' },
      dev: { kind: 'onprem', auth: 'basic', client: '001', systemUrl: 'https://dev.example' },
    });

    const dests = await loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'missing.json') });

    expect(Object.keys(dests)).toEqual(['cloud-erp', 'dev']);
  });
});

describe('mirror block', () => {
  const base = { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://onprem.example' };

  it('loads concurrency, maxObjects and namespaces', async () => {
    const systemsConfigPath = write('systems.json', {
      onprem: { ...base, mirror: { concurrency: 4, maxObjects: 800, namespaces: ['/NSPC/'] } },
    });
    const dests = await loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'none.json') });
    expect(dests.onprem?.mirror).toEqual({ concurrency: 4, maxObjects: 800, namespaces: ['/NSPC/'] });
  });

  it('loads a concurrency above the bulk ceiling: the lane counts it as 5 (ADR-008)', async () => {
    const systemsConfigPath = write('systems.json', { onprem: { ...base, mirror: { concurrency: 8 } } });
    const dests = await loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'none.json') });
    expect(dests.onprem?.mirror?.concurrency).toBe(8);
  });

  it('refuses a namespace without both slashes, and unknown fields', async () => {
    for (const mirror of [{ namespaces: ['NSPC'] }, { namespaces: ['/NSPC'] }, { share: 1 }]) {
      const systemsConfigPath = write('systems.json', { onprem: { ...base, mirror } });
      await expect(
        loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'none.json') }),
      ).rejects.toThrow(/mirror/);
    }
  });
});

describe('format block (ADR-017)', () => {
  const base = { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://onprem.example' };

  it('loads the engine and the abap-cleaner settings', async () => {
    const format = { engine: 'abap-cleaner', abapCleaner: { path: '~/bin/abap-cleaner', profile: '/opt/team.cfj', release: '758' } };
    const systemsConfigPath = write('systems.json', { onprem: { ...base, format } });
    const dests = await loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'none.json') });
    expect(dests.onprem?.format).toEqual({ ...format, abapCleaner: { ...format.abapCleaner, path: path.join(homedir(), 'bin/abap-cleaner') } });
  });

  it('refuses an unknown engine, a relative path, a release that is no number, and unknown fields', async () => {
    for (const format of [
      { engine: 'prettier' },
      { abapCleaner: { path: 'bin/abap-cleaner' } },
      { abapCleaner: { profile: './team.cfj' } },
      { abapCleaner: { release: '7.58' } },
      { abapCleaner: { rules: [] } },
    ]) {
      const systemsConfigPath = write('systems.json', { onprem: { ...base, format } });
      await expect(loadDestinations({ systemsConfigPath, adtlsDestinationsPath: path.join(dir, 'none.json') })).rejects.toThrow(/format/);
    }
  });
});

describe('defaultSystemsConfigPath', () => {
  const saved = process.env.ADTPLUS_CONFIG;
  afterEach(() => {
    if (saved === undefined) delete process.env.ADTPLUS_CONFIG;
    else process.env.ADTPLUS_CONFIG = saved;
  });

  it('is ~/.config/adtplus/systems.json without ADTPLUS_CONFIG', () => {
    delete process.env.ADTPLUS_CONFIG;
    expect(defaultSystemsConfigPath()).toMatch(/\.config\/adtplus\/systems\.json$/);
  });

  it('takes ADTPLUS_CONFIG, resolved to an absolute path', () => {
    process.env.ADTPLUS_CONFIG = 'some/dir/systems.json';
    expect(defaultSystemsConfigPath()).toBe(path.resolve('some/dir/systems.json'));
  });

  it('ignores a blank ADTPLUS_CONFIG', () => {
    process.env.ADTPLUS_CONFIG = '  ';
    expect(defaultSystemsConfigPath()).toMatch(/\.config\/adtplus\/systems\.json$/);
  });
});

describe('systemsConfigJsonSchema', () => {
  it('describes systems as additional properties next to "$schema", every field optional', () => {
    const schema = systemsConfigJsonSchema() as {
      properties: Record<string, unknown>;
      additionalProperties: { properties: Record<string, { description?: string }>; required?: string[]; additionalProperties: boolean };
    };

    expect(Object.keys(schema.properties)).toEqual(['$schema']);
    const system = schema.additionalProperties;
    // A project config may override a single field, so the file schema requires none.
    expect(system.required).toBeUndefined();
    expect(system.additionalProperties).toBe(false);
    expect(system.properties.writeAllowlist?.description).toMatch(/ADR-003/);
  });
});

describe('loadConfig with project configs (ADR-006)', () => {
  const ONPREM = { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://onprem.example', user: 'U', keychainService: 'DEV' };

  /** Writes `<dir>/<folder>/.adtplus/systems.json` and returns its path. */
  function project(folder: string, content: unknown): string {
    const d = path.join(dir, folder, '.adtplus');
    mkdirSync(d, { recursive: true });
    const p = path.join(d, 'systems.json');
    writeFileSync(p, JSON.stringify(content));
    return p;
  }

  async function trusted(p: string, content: unknown): Promise<void> {
    await approve(p, sha256(JSON.stringify(content)), path.join(dir, 'trusted.json'));
  }

  function load(projectConfigPaths: string[], systemsConfigPath = write('systems.json', { onprem: ONPREM })) {
    return loadConfig({
      systemsConfigPath,
      adtlsDestinationsPath: path.join(dir, 'missing.json'),
      projectConfigPaths,
      trustStorePath: path.join(dir, 'trusted.json'),
    });
  }

  it('keeps the user systems and adds the project ones', async () => {
    const content = { cust: { kind: 'cloud', auth: 'interactive', client: '100', systemUrl: 'https://cust.example' } };
    const p = project('cust', content);
    await trusted(p, content);

    const config = await load([p]);

    expect(Object.keys(config.destinations)).toEqual(['onprem', 'cust']);
    expect(config.refused).toEqual({});
  });

  it('overrides field by field, the nearest file winning, and an array replaces', async () => {
    const outer = { onprem: { writeAllowlist: ['ZCUST'], allowRun: false } };
    const inner = { onprem: { writeAllowlist: ['ZREPO'] } };
    const o = project('cust', outer);
    const i = project('cust/repo', inner);
    await trusted(o, outer);
    await trusted(i, inner);
    const userPath = write('systems.json', { onprem: { ...ONPREM, writeAllowlist: ['ZDEV'], allowRun: true } });

    const config = await load([i, o], userPath);

    const onprem = config.destinations.onprem!;
    expect(onprem.writeAllowlist).toEqual(['ZREPO']);
    expect(onprem.allowRun).toBe(false);
    expect(onprem.systemUrl).toBe('https://onprem.example');
    expect(config.sources.onprem).toMatchObject({ writeAllowlist: i, allowRun: o, systemUrl: userPath });
    expect(config.layers.map((l) => l.kind)).toEqual(['user', 'project', 'project']);
  });

  it('merges an object field key by key, nested ones too; a list inside it still replaces (ADR-006)', async () => {
    const inner = { onprem: { mirror: { maxObjects: 2000, namespaces: ['/OTHER/'] }, rateLimit: { perMinute: 100 }, format: { abapCleaner: { path: '/opt/abap-cleaner' } } } };
    const i = project('cust', inner);
    await trusted(i, inner);
    const user = {
      onprem: {
        ...ONPREM,
        mirror: { namespaces: ['/NSPC/'], concurrency: 5 },
        rateLimit: { concurrency: 2 },
        format: { engine: 'abap-cleaner' as const, abapCleaner: { release: '758' } },
      },
    };
    const userPath = write('systems.json', user);

    const config = await load([i], userPath);

    expect(config.destinations.onprem).toMatchObject({
      mirror: { namespaces: ['/OTHER/'], concurrency: 5, maxObjects: 2000 },
      rateLimit: { concurrency: 2, perMinute: 100 },
      format: { engine: 'abap-cleaner', abapCleaner: { release: '758', path: '/opt/abap-cleaner' } },
    });
    expect(config.sources.onprem).toMatchObject({
      'mirror.concurrency': userPath,
      'mirror.maxObjects': i,
      'mirror.namespaces': i,
      'rateLimit.concurrency': userPath,
      'rateLimit.perMinute': i,
      'format.engine': userPath,
      'format.abapCleaner.release': userPath,
      'format.abapCleaner.path': i,
    });
    // The user layer's own objects are not changed by the merge.
    expect(config.layers[0]!.systems.onprem!.mirror).toEqual(user.onprem.mirror);
    expect(config.layers[0]!.systems.onprem!.format).toEqual(user.onprem.format);
  });

  it('names a file whose only setting is an empty object among the sources', async () => {
    const inner = { onprem: { rateLimit: {} } };
    const i = project('cust', inner);
    await trusted(i, inner);
    const config = await load([i]);
    expect(Object.values(config.sources.onprem!)).toContain(i);
  });

  it('refuses every system an unapproved file sets, without falling back to the user values', async () => {
    const content = { onprem: { writeAllowlist: ['ZCUST'] }, cust: { kind: 'onprem', auth: 'basic', client: '100', systemUrl: 'https://c' } };
    const p = project('cust', content);

    const config = await load([p]);

    expect(Object.keys(config.destinations)).toEqual([]);
    expect(config.refused.onprem).toMatch(/is not approved/);
    expect(config.refused.cust).toContain(p);
    expect(config.layers[1]?.trusted).toBe(false);
  });

  it('revokes the approval when the file changes', async () => {
    const content = { onprem: { allowRun: true } };
    const p = project('cust', content);
    await trusted(p, content);
    writeFileSync(p, JSON.stringify({ onprem: { allowRun: true, writeAllowlist: ['Z*'] } }));

    const config = await load([p]);

    expect(config.destinations.onprem).toBeUndefined();
    expect(config.refused.onprem).toMatch(/is not approved/);
  });

  it('works with project configs and no user config', async () => {
    const content = { cust: { kind: 'onprem', auth: 'interactive', client: '100', systemUrl: 'https://c' } };
    const p = project('cust', content);
    await trusted(p, content);

    const config = await load([p], path.join(dir, 'no-user.json'));

    expect(Object.keys(config.destinations)).toEqual(['cust']);
  });

  it('names every file of a system whose merge is incomplete', async () => {
    const content = { cust: { writeAllowlist: ['Z'] } };
    const p = project('cust', content);
    await trusted(p, content);

    await expect(load([p])).rejects.toThrow(`adt+ system "cust" (from ${p}): invalid`);
  });

  it('resolves ~ and relative extraCaCerts against the file that names them', async () => {
    const content = { onprem: { extraCaCerts: ['certs/ca.pem', '~/ca.pem', '/abs/ca.pem'] } };
    const p = project('cust', content);
    await trusted(p, content);
    const userPath = write('systems.json', { onprem: { ...ONPREM, extraCaCerts: ['user.pem'] } });

    const fromUser = await load([], userPath);
    const fromProject = await load([p], userPath);

    expect(fromUser.destinations.onprem?.extraCaCerts).toEqual([path.join(dir, 'user.pem')]);
    expect(fromProject.destinations.onprem?.extraCaCerts).toEqual([
      path.join(dir, 'cust', 'certs', 'ca.pem'),
      path.join(homedir(), 'ca.pem'),
      '/abs/ca.pem',
    ]);
  });
});
