import { describe, expect, it } from 'vitest';
import { searchType } from '../../src/core/search-type.js';

describe('searchType', () => {
  it('maps the subtypes adt-ls finds nothing for to their main type, any case', () => {
    expect(['CHDO/CHD', 'DRAS/RAS', 'DRTY/STY', 'DTEB/DF', 'ront/rot'].map(searchType)).toEqual(['CHDO', 'DRAS', 'DRTY', 'DTEB', 'RONT']);
  });

  it('leaves every other type as given', () => {
    expect(['CLAS/OC', 'FUGR/FF', 'TABL/DS', 'ENQU/DL', 'CLAS'].map(searchType)).toEqual(['CLAS/OC', 'FUGR/FF', 'TABL/DS', 'ENQU/DL', 'CLAS']);
  });
});
