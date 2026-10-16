/**
 * Languages as BCP 47 tags, as AFF writes them (`de`, `zh-Hant`), and SAP's two-character codes
 * (`DE`, `ZF`). The table is AFF's `docs/languages.md` (SAP/abap-file-formats `c305541`), from SAP
 * Note 73606: ISO 639-1 alone can't tell SAP's variants apart (`zh-Hant` is `ZF`, `en-GB` `6N`).
 */
const LANGUAGES: ReadonlyArray<readonly [bcp47: string, sap: string]> = [
  ['af', 'AF'],
  ['sq', 'SQ'],
  ['eu', 'EU'],
  ['bs', 'BS'],
  ['bg', 'BG'],
  ['ca', 'CA'],
  ['zh', 'ZH'],
  ['zh-SG', '3C'],
  ['zh-Hant', 'ZF'],
  ['hr', 'HR'],
  ['cs', 'CS'],
  ['da', 'DA'],
  ['nl', 'NL'],
  ['nl-BE', '1D'],
  ['en', 'EN'],
  ['en-GB', '6N'],
  ['en-AU', '1E'],
  ['en-BZ', '2E'],
  ['en-CA', '3E'],
  ['en-HK', '5E'],
  ['en-IN', '6E'],
  ['en-ID', '7E'],
  ['en-IE', '8E'],
  ['en-JM', '9E'],
  ['en-MY', '0E'],
  ['en-NZ', '1N'],
  ['en-PH', '2N'],
  ['en-SG', '3N'],
  ['en-ZA', '4N'],
  ['en-TT', '5N'],
  ['en-ZW', '7N'],
  ['et', 'ET'],
  ['fi', 'FI'],
  ['fr', 'FR'],
  ['fr-BE', '1F'],
  ['fr-CM', '2F'],
  ['fr-CA', '3F'],
  ['fr-CG', '4F'],
  ['fr-CI', '5F'],
  ['fr-HT', '6F'],
  ['fr-LU', '7F'],
  ['fr-ML', '8F'],
  ['fr-MC', '9F'],
  ['fr-MA', '1H'],
  ['fr-RE', '2H'],
  ['fr-SN', '3H'],
  ['fr-CH', '4H'],
  ['gd', 'GD'],
  ['gl', 'GL'],
  ['de', 'DE'],
  ['de-AT', '1G'],
  ['de-LI', '2G'],
  ['de-LU', '3G'],
  ['de-CH', '4G'],
  ['el', 'EL'],
  ['he', 'HE'],
  ['hu', 'HU'],
  ['is', 'IS'],
  ['id', 'ID'],
  ['ga', 'GA'],
  ['it', 'IT'],
  ['it-CH', '1I'],
  ['ja', 'JA'],
  ['ko', 'KO'],
  ['lv', 'LV'],
  ['lt', 'LT'],
  ['ms', 'MS'],
  ['ms-BN', '1M'],
  ['no', 'NO'],
  ['pl', 'PL'],
  ['pt', 'PT'],
  ['rm', 'RM'],
  ['ro', 'RO'],
  ['ru', 'RU'],
  ['sr-Cyrl', 'SR'],
  ['sr-Latn', 'SH'],
  ['sk', 'SK'],
  ['sl', 'SL'],
  ['wen', 'SB'],
  ['dsb', 'DS'],
  ['hsb', 'HS'],
  ['es', 'ES'],
  ['es-AR', '1S'],
  ['es-BO', '2S'],
  ['es-CL', '3S'],
  ['es-CO', '0S'],
  ['es-CR', '4S'],
  ['es-DO', '5S'],
  ['es-EC', '6S'],
  ['es-SV', '7S'],
  ['es-GT', '8S'],
  ['es-HN', '9S'],
  ['es-MX', '1X'],
  ['es-NI', '2X'],
  ['es-PA', '3X'],
  ['es-PY', '4X'],
  ['es-PE', '5X'],
  ['es-PR', '6X'],
  ['es-UY', '7X'],
  ['es-VE', '8X'],
  ['sw', 'SW'],
  ['sv', 'SV'],
  ['tl', 'TL'],
  ['th', 'TH'],
  ['tr', 'TR'],
  ['uk', 'UK'],
  ['vi', 'VI'],
  ['wa', 'WA'],
];

const toSap = new Map(LANGUAGES.map(([tag, sap]) => [tag.toLowerCase(), sap]));
const toTag = new Map(LANGUAGES.map(([tag, sap]) => [sap, tag]));

/**
 * `de` → `DE`, `zh-Hant` → `ZF` (tags compared without case). Two characters AFF doesn't list as a
 * tag are taken as SAP's code, as `languageTag` hands them out (`AR`, `1G`); anything else is refused.
 */
export function sapLanguage(tag: string): string {
  const sap = toSap.get(tag.trim().toLowerCase());
  if (sap) return sap;
  if (/^[a-z0-9]{2}$/i.test(tag.trim())) return tag.trim().toUpperCase();
  throw new Error(`"${tag}" is not a language AFF lists: give a BCP 47 tag such as "de", "fr", "zh-Hant", "en-GB", or SAP's two-character code`);
}

/** `DE` → `de`, `ZF` → `zh-Hant`; a code AFF doesn't list is passed on as SAP has it. */
export function languageTag(sap: string): string {
  return toTag.get(sap.toUpperCase()) ?? sap;
}
