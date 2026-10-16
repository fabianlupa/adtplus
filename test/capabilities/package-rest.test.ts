import type { AdtLsClient } from '@arc-mcp/adt-ls';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPackageXml,
  createPackage,
  deletePackage,
  editPackage,
  parsePackageXml,
  validateCreatePackage,
  type PackageDefinition,
} from '../../src/capabilities/package.js';
import type { Destination } from '../../src/core/destinations.js';
import { routedRest, type Route } from '../helpers/rest.js';

// Trimmed from the live ONPREM / cloud-erp GET responses.
function packageXml(p: Partial<PackageDefinition> & { name: string }): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><pak:package adtcore:responsible="${p.responsible ?? 'DEVELOPER'}" adtcore:masterLanguage="DE" ` +
    `adtcore:name="${p.name}" adtcore:type="DEVC/K" adtcore:description="${p.description ?? 'desc'}" ` +
    'xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core">' +
    `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/${p.name.toLowerCase()}" adtcore:name="${p.name}"/>` +
    `<pak:attributes pak:packageType="development" pak:isPackageTypeEditable="true" pak:recordChanges="${p.recordChanges ?? true}" ` +
    `pak:isRecordChangesEditable="false" pak:languageVersion="${p.languageVersion ?? ''}" pak:isLanguageVersionVisible="true"/>` +
    `<pak:superPackage adtcore:uri="/x" adtcore:type="DEVC/K" adtcore:name="${p.superPackage ?? 'ZDEV_MAIN'}" adtcore:description="d"/>` +
    `<pak:applicationComponent pak:name="${p.applicationComponent ?? ''}" pak:description="" pak:isVisible="true"/>` +
    `<pak:transport><pak:softwareComponent pak:name="${p.softwareComponent ?? 'HOME'}" pak:description="Kundenentwicklungen"/>` +
    `<pak:transportLayer pak:name="${p.transportLayer ?? 'ZDEV'}" pak:description="x"/></pak:transport>` +
    '<pak:useAccesses pak:isVisible="true"/><pak:packageInterfaces pak:isVisible="true"/>' +
    '<pak:subPackages><pak:packageRef adtcore:name="ZOTHER" pak:name="ignored"/></pak:subPackages></pak:package>'
  );
}

const validationXml = (severity: string, text = '') =>
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><SEVERITY>${severity}</SEVERITY><SHORT_TEXT>${text}</SHORT_TEXT><LONG_TEXT/></DATA></asx:values></asx:abap>`;

function fakeAdt(lockedIn?: string): AdtLsClient {
  return {
    transport: {
      check: vi.fn(async () => ({ isLockedInRequests: !!lockedIn, locks: lockedIn ? [{ number: lockedIn }] : [] })),
    },
  } as unknown as AdtLsClient;
}

const onprem: Destination = {
  id: 'onprem',
  kind: 'onprem',
  auth: 'basic',
  client: '100',
  systemUrl: 'https://onprem.example',
  user: 'DEVELOPER',
  extraCaCerts: [],
  defaultSoftwareComponent: 'HOME',
  languageVersion: 'standard',
  writeAllowlist: ['ZADTPLUS_TEST'],
};

const cloudErp: Destination = {
  id: 'cloud-erp',
  kind: 'cloud',
  auth: 'interactive',
  client: '100',
  systemUrl: 'https://my1-api.example',
  user: 'CB9980000000',
  extraCaCerts: [],
  defaultSoftwareComponent: 'ZLOCAL',
  languageVersion: 'cloudDevelopment',
  writeAllowlist: ['ZADTPLUS_TEST'],
};

describe('package XML', () => {
  it('parses the fields adt+ writes back, ignoring nested subpackage refs', () => {
    const p = parsePackageXml(
      packageXml({ name: 'ZADTPLUS_TEST', languageVersion: '5', softwareComponent: 'ZLOCAL', transportLayer: '', recordChanges: false, superPackage: 'ZLOCAL' }),
    );
    expect(p).toEqual({
      name: 'ZADTPLUS_TEST',
      description: 'desc',
      masterLanguage: 'DE',
      responsible: 'DEVELOPER',
      packageType: 'development',
      recordChanges: false,
      languageVersion: '5',
      superPackage: 'ZLOCAL',
      applicationComponent: '',
      softwareComponent: 'ZLOCAL',
      transportLayer: '',
    });
  });

  it('round-trips through build → parse, escaping text', () => {
    const def: PackageDefinition = {
      name: 'ZADTPLUS_ADTP_P1',
      description: 'a <b> & "c"',
      masterLanguage: 'EN',
      responsible: 'DEVELOPER',
      packageType: 'development',
      recordChanges: true,
      languageVersion: '5',
      superPackage: 'ZADTPLUS_TEST',
      applicationComponent: '',
      softwareComponent: 'HOME',
      transportLayer: 'ZDEV',
    };
    const xml = buildPackageXml(def);
    expect(xml).toContain('pak:languageVersion="5"');
    expect(xml).toContain('adtcore:masterLanguage="EN" adtcore:language="EN"');
    expect(parsePackageXml(xml)).toEqual(def);
  });

  it('reads "adding further objects not possible" from SAP\'s inverted attribute and sends it back on an edit', () => {
    // cloud-erp: the package with the box checked reads isAddingObjectsAllowed="true", its subpackage without "false".
    const flagged = packageXml({ name: 'ZADTPLUS_ADT_DIFF' }).replace('pak:packageType="development"', 'pak:packageType="development" pak:isAddingObjectsAllowed="true"');
    const open = packageXml({ name: 'ZADTPLUS_ADT_DIFF_SUB' }).replace('pak:packageType="development"', 'pak:packageType="development" pak:isAddingObjectsAllowed="false"');
    expect(parsePackageXml(flagged).addingObjectsNotPossible).toBe(true);
    expect(parsePackageXml(open).addingObjectsNotPossible).toBeUndefined();
    expect(buildPackageXml(parsePackageXml(flagged))).toContain('pak:isAddingObjectsAllowed="true"');
    expect(buildPackageXml(parsePackageXml(open))).not.toContain('isAddingObjectsAllowed');
  });

  it('leaves the text language out when none is known (create)', () => {
    const xml = buildPackageXml({ ...parsePackageXml(packageXml({ name: 'ZX' })), masterLanguage: '' });
    expect(xml).not.toContain('Language=');
  });
});

/** ONPREM-like system: ZADTPLUS_TEST records changes on layer ZDEV / HOME. */
function onpremRoutes(overrides: { validation?: string; created?: Partial<PackageDefinition> } = {}): Route {
  let created = false;
  return ({ method, path }) => {
    if (method === 'GET' && path === '/sap/bc/adt/packages/zadtplus_test') return { body: packageXml({ name: 'ZADTPLUS_TEST' }) };
    if (method === 'POST' && path === '/sap/bc/adt/packages/validation') return { body: overrides.validation ?? validationXml('OK') };
    if (method === 'POST' && path === '/sap/bc/adt/packages') {
      created = true;
      return { status: 201 };
    }
    if (method === 'GET' && path === '/sap/bc/adt/packages/zadtplus_adtp_p1' && created) {
      return { body: packageXml({ name: 'ZADTPLUS_ADTP_P1', superPackage: 'ZADTPLUS_TEST', ...overrides.created }) };
    }
    return undefined;
  };
}

describe('package validate/create (REST fallback)', () => {
  const input = { name: 'zadtplus_adtp_p1', superPackage: 'zadtplus_test', description: 'adt+ test', transport: 'DEVK900001' };

  it('validate resolves defaults from policy and the super package without writing', async () => {
    const rest = routedRest(onpremRoutes());
    const res = await validateCreatePackage(rest, onprem, input, { packageCreate: false, transportRelease: false, changeStamps: false, transportContents: false, messageClass: false, domain: false, dataElement: false, dataPreview: false, syntaxText: false, runtimeFeeds: false, probedAt: '' });

    expect(res.valid).toBe(true);
    expect(res.definition).toMatchObject({
      name: 'ZADTPLUS_ADTP_P1',
      superPackage: 'ZADTPLUS_TEST',
      softwareComponent: 'HOME',
      transportLayer: 'ZDEV',
      recordChanges: true,
      languageVersion: '',
      responsible: 'DEVELOPER',
    });
    expect(res).toMatchObject({ via: 'rest-fallback', nativeAvailable: false });
    expect(rest.calls.some((c) => c.method === 'POST' && c.path === '/sap/bc/adt/packages')).toBe(false);
    const v = rest.calls.find((c) => c.path.endsWith('/validation'))!;
    expect(v.opts.query).toMatchObject({ objname: 'ZADTPLUS_ADTP_P1', packagename: 'ZADTPLUS_TEST', swcomp: 'HOME', checkmode: 'full' });
  });

  it('makes the logged-on user responsible: ADT\'s system information, else the configured user', async () => {
    const routes = onpremRoutes();
    const rest = routedRest((call) =>
      call.path === '/sap/bc/adt/core/http/systeminformation' ? { body: '{"userName":"sso.user"}' } : routes(call),
    );
    const res = await validateCreatePackage(rest, { ...onprem, user: undefined }, input);
    expect(res.definition.responsible).toBe('SSO.USER');
    const noInfo = await validateCreatePackage(routedRest(onpremRoutes()), onprem, input);
    expect(noInfo.definition.responsible).toBe('DEVELOPER');
    await expect(validateCreatePackage(routedRest(onpremRoutes()), { ...onprem, user: undefined }, input)).rejects.toThrow(
      /the logon user is unknown here, so a new package has no responsible user/,
    );
  });

  it('create posts the cloud language version code and verifies it on read-back', async () => {
    const cloudCreated = onpremRoutes({ created: { languageVersion: '5', softwareComponent: 'ZLOCAL', recordChanges: false } });
    const rest = routedRest((call) => {
      if (call.method === 'GET' && call.path === '/sap/bc/adt/packages/zadtplus_test') {
        return { body: packageXml({ name: 'ZADTPLUS_TEST', superPackage: 'ZLOCAL', softwareComponent: 'ZLOCAL', transportLayer: '', recordChanges: false, languageVersion: '5' }) };
      }
      return cloudCreated(call);
    });

    const res = await createPackage(rest, cloudErp, { name: 'ZADTPLUS_ADTP_P1', superPackage: 'ZADTPLUS_TEST', description: 'x' });

    const post = rest.calls.find((c) => c.method === 'POST' && c.path === '/sap/bc/adt/packages')!;
    expect(post.opts.body).toContain('pak:languageVersion="5"');
    expect(post.opts.body).toContain('pak:softwareComponent pak:name="ZLOCAL"');
    expect(post.opts.query).toEqual({ corrNr: '' });
    expect(res.package.languageVersion).toBe('5');
    expect(res.transport).toBeNull();
  });

  it('takes the super package\'s software component before the system default', async () => {
    const routes = onpremRoutes();
    const superIn = (softwareComponent: string): Route => (call) =>
      call.method === 'GET' && call.path === '/sap/bc/adt/packages/zadtplus_test'
        ? { body: packageXml({ name: 'ZADTPLUS_TEST', softwareComponent, languageVersion: '5' }) }
        : routes(call);

    const partner = await validateCreatePackage(routedRest(superIn('ZPARTNER')), cloudErp, input);
    expect(partner.definition.softwareComponent).toBe('ZPARTNER');
    const none = await validateCreatePackage(routedRest(superIn('')), cloudErp, input);
    expect(none.definition.softwareComponent).toBe('ZLOCAL');
    const asked = await validateCreatePackage(routedRest(superIn('ZPARTNER')), cloudErp, { ...input, softwareComponent: 'ZOTHER' });
    expect(asked.definition.softwareComponent).toBe('ZOTHER');
  });

  it('refuses a language version that conflicts with system policy', async () => {
    const rest = routedRest(onpremRoutes());
    await expect(createPackage(rest, cloudErp, { ...input, languageVersion: 'standard' })).rejects.toThrow(
      /must use language version "cloudDevelopment"/,
    );
    expect(rest.calls).toHaveLength(0);
  });

  it('refuses a super package outside the allowlist', async () => {
    const rest = routedRest(onpremRoutes());
    await expect(createPackage(rest, onprem, { ...input, superPackage: 'ZDEV_MAIN' })).rejects.toThrow(/write allowlist/);
    expect(rest.calls).toHaveLength(0);
  });

  it('stops on a SAP validation error', async () => {
    const rest = routedRest(onpremRoutes({ validation: validationXml('ERROR', 'Paket ZADTPLUS_ADTP_P1 existiert bereits') }));
    await expect(createPackage(rest, onprem, input)).rejects.toThrow(/existiert bereits/);
    expect(rest.calls.some((c) => c.method === 'POST' && c.path === '/sap/bc/adt/packages')).toBe(false);
  });

  it('requires a transport when the package inherits change recording', async () => {
    const rest = routedRest(onpremRoutes());
    await expect(createPackage(rest, onprem, { ...input, transport: undefined })).rejects.toThrow(/needs a transport/);
  });

  it('reports a created package whose language version did not stick', async () => {
    const rest = routedRest(onpremRoutes({ created: { languageVersion: '5' } }));
    await expect(createPackage(rest, onprem, input)).rejects.toThrow(
      /was created, but language version is cloudDevelopment, expected standard/,
    );
  });
});

function lockBody(handle: string, corrNr = ''): string {
  return `<asx:abap><asx:values><DATA><LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR></DATA></asx:values></asx:abap>`;
}

describe('package edit/delete (REST fallback)', () => {
  const child = packageXml({ name: 'ZADTPLUS_ADTP_P1', superPackage: 'ZADTPLUS_TEST', description: 'old', languageVersion: '5' });

  it('edit locks with the transport already holding the package, re-sends every field, always unlocks', async () => {
    let description = 'old';
    const rest = routedRest(({ method, path, opts }) => {
      if (path !== '/sap/bc/adt/packages/zadtplus_adtp_p1') return undefined;
      if (method === 'GET') return { body: packageXml({ name: 'ZADTPLUS_ADTP_P1', superPackage: 'ZADTPLUS_TEST', description, languageVersion: '5' }) };
      if (opts.query?._action === 'LOCK') return { body: lockBody('H1') };
      if (method === 'PUT') {
        description = parsePackageXml(opts.body!).description;
        return {};
      }
      if (opts.query?._action === 'UNLOCK') return {};
      return undefined;
    });

    const res = await editPackage(fakeAdt('DEVK900001'), rest, onprem, { name: 'ZADTPLUS_ADTP_P1', description: 'new' });

    const actions = rest.calls.map((c) => `${c.method} ${c.opts.query?._action ?? ''}`.trim());
    expect(actions).toEqual(['GET', 'POST LOCK', 'PUT', 'POST UNLOCK', 'GET']);
    expect(rest.calls[1]!.opts.query).toMatchObject({ corrNr: 'DEVK900001' });
    const put = rest.calls[2]!;
    expect(put.opts.query).toEqual({ lockHandle: 'H1', corrNr: 'DEVK900001' });
    expect(put.opts.body).toContain('pak:languageVersion="5"');
    expect(put.opts.body).toContain('pak:recordChanges="true"');
    expect(put.opts.body).toContain('adtcore:masterLanguage="DE" adtcore:language="DE"');
    expect(res.package.description).toBe('new');
  });

  it('edit unlocks and surfaces the error when the PUT fails', async () => {
    const rest = routedRest(({ method, opts }) => {
      if (method === 'GET') return { body: child };
      if (opts.query?._action === 'LOCK') return { body: lockBody('H1') };
      if (method === 'PUT') return { status: 400, body: 'bad' };
      return {};
    });
    await expect(editPackage(fakeAdt(), rest, onprem, { name: 'ZADTPLUS_ADTP_P1', description: 'x' })).rejects.toThrow(/update package/);
    expect(rest.calls.some((c) => c.opts.query?._action === 'UNLOCK')).toBe(true);
  });

  it('edit reports a PUT that did not persist', async () => {
    const rest = routedRest(({ method, opts }) => {
      if (method === 'GET') return { body: child };
      if (opts.query?._action === 'LOCK') return { body: lockBody('H1') };
      return {};
    });
    await expect(editPackage(fakeAdt(), rest, onprem, { name: 'ZADTPLUS_ADTP_P1', description: 'x' })).rejects.toThrow(
      /not visible on read-back/,
    );
  });

  it('delete requires confirm', async () => {
    const rest = routedRest(() => ({ body: child }));
    await expect(deletePackage(fakeAdt(), rest, onprem, { name: 'ZADTPLUS_ADTP_P1' })).rejects.toThrow(/confirm: true/);
    expect(rest.calls).toHaveLength(0);
  });

  // A package lives in its superpackage, so that is what the allowlist decides (docs/decisions/003-write-gates.md).
  it('delete refuses the allowlist root and packages whose superpackage is not writable', async () => {
    const root = routedRest(() => ({ body: packageXml({ name: 'ZADTPLUS_TEST', superPackage: 'ZDEV_MAIN' }) }));
    await expect(deletePackage(fakeAdt(), root, onprem, { name: 'ZADTPLUS_TEST', confirm: true })).rejects.toThrow(
      /package "ZDEV_MAIN" is not in the write allowlist/,
    );

    const foreign = routedRest(() => ({ body: packageXml({ name: 'ZADTPLUS_OTHER', superPackage: 'ZADTPLUS_ELSEWHERE' }) }));
    await expect(deletePackage(fakeAdt(), foreign, onprem, { name: 'ZADTPLUS_OTHER', confirm: true })).rejects.toThrow(
      /package "ZADTPLUS_ELSEWHERE" is not in the write allowlist/,
    );
    expect([...root.calls, ...foreign.calls].every((c) => c.method === 'GET')).toBe(true);
  });

  it('delete reuses the CORRNR SAP generated at lock time and verifies the package is gone', async () => {
    let gone = false;
    const rest = routedRest(({ method, opts }) => {
      if (method === 'GET') return gone ? { status: 404 } : { body: child };
      if (opts.query?._action === 'LOCK') return { body: lockBody('H9', 'DEVK913999') };
      if (method === 'DELETE') {
        gone = true;
        return {};
      }
      return undefined;
    });

    const res = await deletePackage(fakeAdt(), rest, onprem, { name: 'ZADTPLUS_ADTP_P1', confirm: true });

    expect(rest.calls[1]!.opts.query).toMatchObject({ _action: 'LOCK', corrNr: '' });
    expect(rest.calls[2]!.opts.query).toEqual({ lockHandle: 'H9', corrNr: 'DEVK913999' });
    expect(res).toMatchObject({ name: 'ZADTPLUS_ADTP_P1', deleted: true, transport: 'DEVK913999', via: 'rest-fallback' });
  });

  it('delete explains an S_ABPLNGVS lock refusal', async () => {
    const rest = routedRest(({ method, opts }) => {
      if (method === 'GET') return { body: child };
      if (opts.query?._action === 'LOCK') return { status: 403, body: 'not authorized (authorization object S_ABPLNGVS)' };
      return undefined;
    });
    await expect(deletePackage(fakeAdt(), rest, cloudErp, { name: 'ZADTPLUS_ADTP_P1', confirm: true })).rejects.toThrow(
      /may not change packages of this ABAP language version/,
    );
  });

  it('delete reports a package that is still readable afterwards', async () => {
    const rest = routedRest(({ method, opts }) => {
      if (method === 'GET') return { body: child };
      if (opts.query?._action === 'LOCK') return { body: lockBody('H1') };
      return {};
    });
    await expect(deletePackage(fakeAdt(), rest, onprem, { name: 'ZADTPLUS_ADTP_P1', confirm: true })).rejects.toThrow(
      /still readable/,
    );
  });
});
