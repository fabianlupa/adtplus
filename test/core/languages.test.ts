import { describe, expect, it } from 'vitest';
import { languageTag, sapLanguage } from '../../src/core/languages.js';

describe('languages (AFF languages.md)', () => {
  it('maps BCP 47 tags to SAP codes, the variants included, without case', () => {
    expect(sapLanguage('de')).toBe('DE');
    expect(sapLanguage('zh-Hant')).toBe('ZF');
    expect(sapLanguage('ZH-hant')).toBe('ZF');
    expect(sapLanguage('zh')).toBe('ZH');
    expect(sapLanguage('en-GB')).toBe('6N');
    expect(sapLanguage('sr-Latn')).toBe('SH');
  });

  it('takes two characters AFF does not list as SAP\'s code, as languageTag hands them out', () => {
    expect(sapLanguage('ar')).toBe('AR');
    expect(sapLanguage(languageTag('AR'))).toBe('AR');
    expect(sapLanguage('1G')).toBe('1G');
  });

  it('refuses anything else AFF does not list', () => {
    expect(() => sapLanguage('xxx')).toThrow(/"xxx" is not a language AFF lists/);
    expect(() => sapLanguage('DE-DE')).toThrow(/not a language AFF lists/);
  });

  it('maps SAP codes back, passing an unknown one on', () => {
    expect(languageTag('DE')).toBe('de');
    expect(languageTag('ZF')).toBe('zh-Hant');
    expect(languageTag('1G')).toBe('de-AT');
    expect(languageTag('Q9')).toBe('Q9');
  });
});
