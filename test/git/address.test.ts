import { describe, expect, it } from 'vitest';
import { checkRemoteName, formatAddress, parseAddress } from '../../src/git/address.js';

describe('git address', () => {
  it('a package, with subpackages unless ?no-subpackages', () => {
    expect(parseAddress('ONPREM/package/zadtplus_mb_refac')).toEqual({ system: 'ONPREM', kind: 'package', name: 'ZADTPLUS_MB_REFAC', subpackages: true });
    expect(parseAddress('cloud-erp/package/ZADTPLUS_A?no-subpackages')).toEqual({ system: 'cloud-erp', kind: 'package', name: 'ZADTPLUS_A', subpackages: false });
  });

  it('a software component, always with subpackages', () => {
    expect(parseAddress('cloud-erp/swc/zlocal')).toEqual({ system: 'cloud-erp', kind: 'swc', name: 'ZLOCAL', subpackages: true });
    expect(() => parseAddress('ONPREM/swc/ZT1_DEV?no-subpackages')).toThrow(/for package addresses/);
    expect(() => parseAddress('ONPREM/swc/')).toThrow(/names no package or software component/);
  });

  it('a namespaced package keeps its slashes', () => {
    expect(parseAddress('ONPREM/package//NSPC/PKG').name).toBe('/NSPC/PKG');
  });

  it('formats back to the URL\'s address', () => {
    for (const a of ['ONPREM/package/ZADTPLUS_A', 'ONPREM/package/ZADTPLUS_A?no-subpackages', 'cloud-erp/swc/ZLOCAL']) expect(formatAddress(parseAddress(a))).toBe(a);
  });

  it('refuses unknown options and incomplete addresses', () => {
    expect(() => parseAddress('ONPREM/package/ZADTPLUS_A?history')).toThrow(/unknown option "history"/);
    expect(() => parseAddress('ONPREM/package/')).toThrow(/names no package/);
    expect(() => parseAddress('ONPREM')).toThrow(/names no system/);
    expect(() => parseAddress('/package/ZADTPLUS_A')).toThrow(/names no system/);
    expect(() => parseAddress('ONPREM/transport/DEVK900001')).toThrow(/names no package/);
  });

  it('remote names: named remotes pass, anonymous URLs and unsafe names are refused', () => {
    expect(checkRemoteName('origin')).toBe('origin');
    expect(checkRemoteName('sap/onprem')).toBe('sap/onprem');
    expect(() => checkRemoteName('adtplus::ONPREM/package/ZADTPLUS_A')).toThrow(/git remote add <name> adtplus::ONPREM\/package\/ZADTPLUS_A/);
    expect(() => checkRemoteName('../x')).toThrow(/named remote/);
    expect(() => checkRemoteName('a/../b')).toThrow(/named remote/);
  });
});
