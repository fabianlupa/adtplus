/**
 * Subtypes adt-ls's search filter finds nothing for on `onprem` (adt-ls 1.1.2), on top of the four the
 * SDK maps itself (`SRVD/SRV`, `BDEF/BDO`, `DDLX/EX`, `NROB/NRO`). Each is the only subtype of its
 * main type, so searching by the main type finds the same objects and nothing else.
 */
const SUBTYPE_FILTER_MISSES = new Set(['CHDO/CHD', 'DRAS/RAS', 'DRTY/STY', 'DTEB/DF', 'RONT/ROT']);

/** The type to pass to adt-ls's search for `objectType`. */
export function searchType(objectType: string): string {
  const type = objectType.toUpperCase();
  return SUBTYPE_FILTER_MISSES.has(type) ? type.split('/')[0]! : objectType;
}
