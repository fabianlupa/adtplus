import { describe, expect, it } from 'vitest';
import { objectPlacement, packageChain } from '../../src/core/placement.js';

// URIs as `onprem` and `cloud-erp` served them (2026-09-21), packages matched against TADIR.
const ONPREM = 'abap:/repotree-v1/DEV_100_DEVELOPER_EN';
const cloudErp = 'abap:/repotree-v1/cloud-erp-100';

describe('objectPlacement', () => {
  it('reads the package three segments above the object folder, with the chain above it', () => {
    const uri = `${ONPREM}/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/ZADTPLUS_AI_DEMO/Source%20Code%20Library/Classes/ZCL_ADTPLUS_AI_DEMO2/zcl_adtplus_ai_demo2.clas.abap`;
    expect(objectPlacement(uri, { name: 'ZCL_ADTPLUS_AI_DEMO2', objectType: 'CLAS/OC' })).toEqual({
      package: 'ZADTPLUS_AI_DEMO',
      chain: ['ZALL', 'ZDEV_MAIN', 'ZADTPLUS_TEST', 'ZADTPLUS_AI_DEMO'],
    });
  });

  it('holds for cloud paths, service bindings and function groups', () => {
    expect(
      objectPlacement(
        `${cloudErp}/System%20Library/ZLOCAL/ZADTPLUS_TEST/ZADTPLUS_UUID_TEST/Core%20Data%20Services/Behavior%20Definitions/ZR_ADTPLUS_RAPOBJA/zr_adtplus_rapobja.bdef.abdl`,
        { name: 'ZR_ADTPLUS_RAPOBJA', objectType: 'BDEF/BDO' },
      ),
    ).toEqual({ package: 'ZADTPLUS_UUID_TEST', chain: ['ZLOCAL', 'ZADTPLUS_TEST', 'ZADTPLUS_UUID_TEST'] });
    expect(
      objectPlacement(
        `${ONPREM}/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/ZADTPLUS_UUID_TEST/Business%20Services/Service%20Bindings/ZUI_ADTPLUS_RAPOBJA_O4/zui_adtplus_rapobja_o4.srvb.json`,
        { name: 'ZUI_ADTPLUS_RAPOBJA_O4', objectType: 'SRVB/SVB' },
      )?.package,
    ).toBe('ZADTPLUS_UUID_TEST');
    expect(
      objectPlacement(
        `${ONPREM}/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/ZADTPLUS_TEST_A1/Source%20Code%20Library/Function%20Groups/ZADTPLUS_HELPERS/zadtplus_test_function_group.fugr.saplzadtplus_test_function_group.reps.abap`,
        { name: 'ZADTPLUS_HELPERS', objectType: 'FUGR/F' },
      )?.package,
    ).toBe('ZADTPLUS_TEST_A1');
  });

  it("places a function module or include by its group's folder, which holds its file", () => {
    const group = `${cloudErp}/System%20Library/ZPARTNER/ZADTPLUS/ZADTPLUS_OBJTYPES/Source%20Code%20Library/Function%20Groups/ZADTPLUS_AP`;
    expect(objectPlacement(`${group}/zadtplus_ap.fugr.z_adtplus_ap_get.func.abap`, { name: 'Z_ADTPLUS_AP_GET', objectType: 'FUGR/FF' })).toEqual({
      package: 'ZADTPLUS_OBJTYPES',
      chain: ['ZPARTNER', 'ZADTPLUS', 'ZADTPLUS_OBJTYPES'],
    });
    expect(
      objectPlacement(`${group}/zadtplus_ap.fugr.lzadtplus_aptop.reps.abap`, { name: 'LZADTPLUS_APTOP', objectType: 'FUGR/I' })?.package,
    ).toBe('ZADTPLUS_OBJTYPES');
    // a file of another object in the folder
    expect(objectPlacement(`${group}/zadtplus_ap.fugr.z_adtplus_ap_get2.func.abap`, { name: 'Z_ADTPLUS_AP_GET', objectType: 'FUGR/FF' })).toBeUndefined();
    expect(objectPlacement(`${group}/z_adtplus_ap_get.func.abap`, { name: 'Z_ADTPLUS_AP_GET', objectType: 'FUGR/FF' })).toBeUndefined();
  });

  it('matches a namespaced function module in either spelling', () => {
    const group = `${cloudErp}/System%20Library/%2FNS%2FPKG/Source%20Code%20Library/Function%20Groups/%28NS%29FG`;
    const ref = { name: '/NS/FM', objectType: 'FUGR/FF' };
    expect(objectPlacement(`${group}/%28ns%29fg.fugr.%28ns%29fm.func.abap`, ref)?.package).toBe('/NS/PKG');
    const slashed = `${cloudErp}/System%20Library/%2FNS%2FPKG/Source%20Code%20Library/Function%20Groups/%2FNS%2FFG`;
    expect(objectPlacement(`${slashed}/%2Fns%2Ffg.fugr.%2Fns%2Ffm.func.abap`, ref)?.package).toBe('/NS/PKG');
  });

  it('maps the Local Objects root to $TMP, not to the user folder in the package position', () => {
    const uri = `${ONPREM}/Local%20Objects%20%28%24TMP%29/DEVELOPER/Source%20Code%20Library/Interfaces/ZIF_ADTP_TEST_ACC_DOC_WRAPPER/zif_adtp_test_acc_doc_wrapper.intf.abap`;
    expect(objectPlacement(uri, { name: 'ZIF_ADTP_TEST_ACC_DOC_WRAPPER', objectType: 'INTF/OI' })).toEqual({
      package: '$TMP',
      chain: ['$TMP'],
    });
  });

  it('places a package in its superpackage', () => {
    const uri = `${ONPREM}/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/ZADTPLUS_AI_DEMO/zadtplus_ai_demo.devck.jsonc`;
    expect(objectPlacement(uri, { name: 'ZADTPLUS_AI_DEMO', objectType: 'DEVC/K' })).toEqual({
      package: 'ZADTPLUS_TEST',
      chain: ['ZALL', 'ZDEV_MAIN', 'ZADTPLUS_TEST'],
    });
  });

  it('gives up rather than guess', () => {
    // no folder named after the object
    expect(objectPlacement(`${ONPREM}/System%20Library/ZADTPLUS_TEST/Cat/Type/zcl_x.clas.abap`, { name: 'ZCL_X', objectType: 'CLAS/OC' })).toBeUndefined();
    // too shallow for package → category → type → object
    expect(objectPlacement(`${ONPREM}/System%20Library/Classes/ZCL_X/zcl_x.clas.abap`, { name: 'ZCL_X', objectType: 'CLAS/OC' })).toBeUndefined();
    // not a repotree URI
    expect(objectPlacement('/sap/bc/adt/oo/classes/zcl_x', { name: 'ZCL_X', objectType: 'CLAS/OC' })).toBeUndefined();
    // a top-level package has no superpackage in the path
    expect(objectPlacement(`${ONPREM}/System%20Library/ZALL/zall.devck.jsonc`, { name: 'ZALL', objectType: 'DEVC/K' })).toBeUndefined();
  });

  it('keeps a namespaced name whole', () => {
    const uri = `${ONPREM}/System%20Library/%2FNS%2FPKG/Source%20Code%20Library/Classes/%2FNS%2FCL_X/%2Fns%2Fcl_x.clas.abap`;
    expect(objectPlacement(uri, { name: '/NS/CL_X', objectType: 'CLAS/OC' })?.package).toBe('/NS/PKG');
  });
});

describe('packageChain', () => {
  it('ends with the package itself', () => {
    const uri = `${ONPREM}/System%20Library/ZALL/ZDEV_MAIN/ZADTPLUS_TEST/zadtplus_test.devck.jsonc`;
    expect(packageChain(uri, 'zadtplus_test')).toEqual(['ZALL', 'ZDEV_MAIN', 'ZADTPLUS_TEST']);
    expect(packageChain(uri, 'ZADTPLUS_NOT_THERE')).toBeUndefined();
  });
});
