import { describe, expect, it } from 'vitest';
import { idsOfKeys, ownerOf, planFetch } from '../../src/git/incremental.js';
import { parseHits, shortMessage, stampOf } from '../../src/mirror/changes.js';
import { RawAdtError } from '../../src/backends/rawadt.js';

const MIRRORED = ['CLAS ZCL_A', 'DTELDE ZDE_A', 'DDLS ZI_B'];
const NOW = { 'CLAS/OC ZCL_A': 'p 1', 'DTEL/DE ZDE_A': 'p 2', 'DDLS/DF ZI_B': 'p 3', 'DEVC/K ZADTPLUS_A': 'p 0' };

describe('incremental fetch plan', () => {
  it('maps search keys to mirror ids: the main type, or main and subtype joined', () => {
    const ids = idsOfKeys(Object.keys(NOW));
    expect(ids.get('CLAS ZCL_A')).toBe('CLAS/OC ZCL_A');
    expect(ids.get('DTELDE ZDE_A')).toBe('DTEL/DE ZDE_A');
    expect(ids.get('DTEL ZDE_A')).toBe('DTEL/DE ZDE_A');
  });

  it('nothing moved: no object; a moved stamp: that object', () => {
    expect(planFetch(NOW, NOW, MIRRORED)).toEqual({ objects: [], bestEffort: [] });
    expect(planFetch(NOW, { ...NOW, 'CLAS/OC ZCL_A': 'p 9' }, MIRRORED)).toEqual({ objects: ['CLAS ZCL_A'], bestEffort: [] });
  });

  it('a part counts for its owner: a function module for its group, a CDS entity for its view, an enhancement part for the enhancement', () => {
    const ids = new Set(['FUGR ZFG', 'DDLS ZI_X', 'ENHOXH ZENH', 'ENHSXS ZSPOT']);
    expect(ownerOf('FUGR/FF Z_FM', '/sap/bc/adt/functions/groups/zfg/fmodules/z_fm', ids)).toBe('FUGR ZFG');
    expect(ownerOf('STOB/DO ZI_X', '/sap/bc/adt/ddic/ddl/sources/zi_x/source/main', ids)).toBe('DDLS ZI_X');
    expect(ownerOf('ENHO/XHB ZENH', '/sap/bc/adt/enhancements/enhoxhb/zenh', ids)).toBe('ENHOXH ZENH');
    expect(ownerOf('ENHS/XB ZSPOT_OUT', '/sap/bc/adt/enhancements/enhsxsb/zspot', ids)).toBe('ENHSXS ZSPOT');
    expect(ownerOf('CMOD/XP ZPROJ', '/sap/bc/adt/vit/wb/object_type/cmodxp/object_name/ZPROJ', ids)).toBeUndefined();

    const prev = { 'FUGR/F ZFG': 'p 1', 'FUGR/FF Z_FM': 'p 1' };
    const uris = { 'FUGR/FF Z_FM': '/sap/bc/adt/functions/groups/zfg/fmodules/z_fm' };
    expect(planFetch(prev, { ...prev, 'FUGR/FF Z_FM': 'p 2' }, ['FUGR ZFG'], false, uris)).toEqual({ objects: ['FUGR ZFG'], bestEffort: [] });
  });

  it('a full pull when the stamps can\'t vouch: none yet, the ceiling, new or gone hits, a changed hit no object stands for', () => {
    expect(planFetch(undefined, NOW, MIRRORED)).toEqual({ full: 'no change stamps from an earlier fetch' });
    expect(planFetch(NOW, NOW, MIRRORED, true)).toEqual({ full: 'the package search found more objects than the ceiling' });
    expect(planFetch(NOW, { ...NOW, 'PROG/P ZP': 'p 5' }, MIRRORED)).toEqual({ full: 'new on the system: PROG/P ZP' });
    const { 'DDLS/DF ZI_B': _gone, ...without } = NOW;
    expect(planFetch(NOW, without, MIRRORED)).toEqual({ full: 'gone from the system: DDLS/DF ZI_B' });
    const withInclude = { ...NOW, 'PROG/I LZFGTOP': 'p 1' };
    expect(planFetch(withInclude, { ...withInclude, 'PROG/I LZFGTOP': 'p 2' }, MIRRORED)).toEqual({ full: 'changed, and no mirrored object: PROG/I LZFGTOP' });
  });

  it('a stamp whose package changed is a move: a full pull', () => {
    expect(planFetch(NOW, { ...NOW, 'DDLS/DF ZI_B': 'q 3' }, MIRRORED)).toEqual({ full: 'moved to another package: DDLS/DF ZI_B' });
  });

  it('a package\'s own stamp is no reason; an object without a stamp is read every time', () => {
    expect(planFetch(NOW, { ...NOW, 'DEVC/K ZADTPLUS_A': 'p 7' }, MIRRORED)).toEqual({ objects: [], bestEffort: [] });
    expect(planFetch({ ...NOW, 'DDLS/DF ZI_B': null }, { ...NOW, 'DDLS/DF ZI_B': null }, MIRRORED)).toEqual({ objects: [], bestEffort: ['DDLS ZI_B'] });
    expect(planFetch(NOW, NOW, [...MIRRORED, 'SUSH ZADTPLUS_A'])).toEqual({ objects: [], bestEffort: ['SUSH ZADTPLUS_A'] });
  });

  it('a failed metadata read is one short line: an HTML error page only its status', () => {
    expect(shortMessage(new RawAdtError(500, undefined, '<!DOCTYPE html>\n<html><head><style>body {}</style>', 'read ENHO/XH X'))).toBe('HTTP 500');
    expect(shortMessage(new Error(`line one\nline two`))).toBe('line one');
    expect(shortMessage(new Error('x'.repeat(200)))).toHaveLength(158);
  });

  it('parses search hits and stamps: every changedAt, a class include\'s too', () => {
    expect(
      parseHits(
        '<adtcore:objectReferences><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a#x" adtcore:type="CLAS/OC" adtcore:name="zcl_a" adtcore:packageName="zadtplus_a"/></adtcore:objectReferences>',
      ),
    ).toEqual([{ key: 'CLAS/OC ZCL_A', uri: '/sap/bc/adt/oo/classes/zcl_a', package: 'ZADTPLUS_A' }]);
    // A `>` inside an attribute value doesn't end the reference.
    expect(
      parseHits('<adtcore:objectReference adtcore:description="maps A -> B" adtcore:uri="/u" adtcore:type="PROG/P" adtcore:name="ZP" adtcore:packageName="ZADTPLUS_A"/>'),
    ).toEqual([{ key: 'PROG/P ZP', uri: '/u', package: 'ZADTPLUS_A' }]);
    expect(stampOf('<class adtcore:changedAt="2026-10-01T10:00:00Z"><include adtcore:changedAt="2026-10-02T08:00:00Z"/></class>')).toBe(
      '2026-10-01T10:00:00Z,2026-10-02T08:00:00Z',
    );
  });
});
