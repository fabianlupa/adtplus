import { describe, expect, it } from 'vitest';
import { structureIncludes, textEtags } from '../../src/mirror/changes.js';

const element = (type: string, name: string) => `<abapsource:objectStructureElement adtcore:type="${type}" adtcore:name="${name}" >`;

describe('mirror changes: the parts of a stamp', () => {
  it('takes a group\'s own includes from its object structure, not SAP\'s it uses', () => {
    // A maintenance group as ONPREM lists it: its own includes among SAP's `LSVIM…` ones.
    const xml = [
      element('FUGR/F', 'ZDFL_DEMO_BOOL'),
      element('FUGR/FF', 'TABLEFRAME_ZDFL_DEMO_BOOL'),
      element('FUGR/I', 'LSVIMFXX'),
      element('FUGR/I', 'LZDFL_DEMO_BOOLTOP'),
      element('FUGR/I', 'LSVIMTDT'),
      element('FUGR/I', 'LZDFL_DEMO_BOOLF00'),
      element('FUGR/PX', 'SAPLZDFL_DEMO_BOOL'),
    ].join('');
    expect(structureIncludes(xml, 'ZDFL_DEMO_BOOL')).toEqual(['LZDFL_DEMO_BOOLF00', 'LZDFL_DEMO_BOOLTOP']);
    expect(structureIncludes(element('FUGR/I', '/NSPC/LGRPTOP') + element('FUGR/I', 'LSVIMFXX'), '/NSPC/GRP')).toEqual(['/NSPC/LGRPTOP']);
    // Another group's include, whose name starts with this group's: not this group's.
    expect(structureIncludes(element('FUGR/I', 'LZFOOTOP') + element('FUGR/I', 'LZFOOBARF01'), 'ZFOO')).toEqual(['LZFOOTOP']);
  });

  it('reads one etag per part of the text elements', () => {
    const link = (etag: string) => `<atom:link href="source/x" type="text/html" etag="${etag}"/><atom:link href="source/x/versions"/>`;
    const xml =
      `<rept:textElement adtcore:changedAt="2026-10-04T09:55:57Z">` +
      `<rept:subobject adtcore:name="symbols">${link('47F8A')}</rept:subobject>` +
      `<rept:subobject adtcore:name="selections">${link('DA39A')}</rept:subobject></rept:textElement>`;
    expect(textEtags(xml)).toBe('symbols:47F8A,selections:DA39A');
    // Attributes in another order still count; a body without any etag is an error, not an empty stamp.
    expect(textEtags(`<rept:subobject adtcore:type="X" adtcore:name="symbols">${link('47F8A')}</rept:subobject>`)).toBe('symbols:47F8A');
    expect(() => textEtags('<rept:textElement adtcore:changedAt="2026-10-04T09:55:57Z"/>')).toThrow(/without an etag/);
  });
});
