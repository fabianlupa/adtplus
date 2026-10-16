import { Tokens } from '@abaplint/core';
import type { AdtLsClient, Locator, ObjectRef } from '@arc-mcp/adt-ls';
import { abapStatements, declaredMethod, implementedMethod } from '../core/abap-statements.js';
import type { ActiveRead } from '../core/active-source.js';

/**
 * Code navigation over adt-ls's LSP providers. All reads. Results are the
 * SDK's raw payloads plus `notes` for the places M6.0 measured them to be
 * thin or misleading, so a caller cannot mistake an empty answer for a clean one.
 */
export interface NavigateResult {
  result: unknown;
  notes: string[];
  /** `references` only: adt+'s own scan of the object's source (see `SourceScan`). */
  sourceScan?: SourceScan;
}

export interface SourceMatch {
  /** Which include the line sits in; `main` is the object's own source. */
  include: string;
  /** 1-based, as an editor counts. */
  line: number;
  text: string;
  /** A `METHODS`/`METHOD` header mentions the symbol without calling it. */
  kind: 'call' | 'declaration';
  /** Which stored version holds this line. `both` when the two agree. */
  version: 'active' | 'inactive' | 'both';
}

export interface SourceScan {
  symbol: string;
  /** The includes actually read. */
  scanned: string[];
  /**
   * Versions read. `inactive` is `source.read`, which serves the logged-on
   * user's draft if there is one. `active` comes from adt-ls switched to the
   * active version (`core/active-source.ts`) — M6.4c run 4 hit the split it
   * closes: a test include whose draft was an empty stub while its active
   * version had three calling test methods.
   */
  versions: Array<'active' | 'inactive'>;
  /** Includes whose active and draft text differ — worth naming in the answer. */
  diverged: string[];
  matches: SourceMatch[];
}

/**
 * Reads the given includes at the ACTIVE version, in one go; `undefined` is the
 * main source. Supplied by the daemon, which keeps other requests on the object
 * out while adt-ls serves the active version (`core/active-source.ts`).
 */
export type ActiveSourceReader = (includes: Array<string | undefined>) => Promise<ActiveRead>;

const isCds = (ref: ObjectRef): boolean => ref.objectType.startsWith('DDLS');

const isEmpty = (v: unknown): boolean =>
  v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

const CDS_THIN =
  'CDS gets hover and go-to-definition/declaration only; outline, highlight and type hierarchy return nothing on CDS.';

// M6.4c: `get_customer_counts` was called from the same class's own `main` (active source line 27) but
// where-used returned only the test-class file (ARC-1's class-level view listed `main` as a user).
const SAME_OBJECT_SCANNED =
  'Where-used misses callers inside the object\'s own source (measured: a private method called from the same class\'s own method was not returned), so adt+ read that source and scanned it — see `sourceScan`. Report BOTH sets: every caller in `result`, tests included and marked as tests, plus every `kind: "call"` line in `sourceScan.matches`. Never drop the index\'s hits.';

// The note adt+ shipped before it did the scan itself. Kept for the case where it cannot.
const SAME_OBJECT_GAP =
  'Callers inside the object\'s own main source can be missing (measured: a private method called from the same class\'s own method was not returned). Treat this list as a floor: also search the object\'s own source for the symbol and report both sets — the callers returned here plus the ones found in the source.';

const VERSION_SPLIT =
  '`result` comes from SAP\'s index, which reflects the ACTIVE version; `sourceScan` read the stored source, which is the INACTIVE draft. Where they disagree, report both and name which version each came from.';

const VERSION_BOTH =
  '`sourceScan` read BOTH versions: each match carries `version` (`both` where they agree). `sourceScan.diverged` names the includes whose active and draft text differ — if the symbol is called in one and not the other, say so and name the version, because activating the draft would change the answer.';

/** A class keeps callers in its local includes too; `undefined` is the object's own source. */
const CLAS_INCLUDES: Array<string | undefined> = [
  undefined,
  'definitions',
  'implementations',
  'macros',
  'testclasses',
];

/** What the scan looks for: a method name, and for `ZCL_X=>METH` the class a static call must name. */
interface ScanTarget {
  name: string;
  staticClass?: string;
}

/** `ZCL_X=>METH` → METH of ZCL_X; `lo_x->meth` → meth (the variable's class is unknown); else as given. */
function scanTarget(symbol: string): ScanTarget {
  const name = bareSymbol(symbol);
  if (!name) return { name: symbol };
  const at = symbol.lastIndexOf('=>');
  return at > symbol.lastIndexOf('->') ? { name, staticClass: symbol.slice(0, at).trim().toLowerCase() } : { name };
}

/**
 * The lines of `source` naming the target, from abaplint's statements and tokens (ADR-012): a
 * comment, a string literal or a template's text never counts, a template's embedded expression
 * does, and a static call of another class (`zcl_other=>meth`) doesn't. The name a METHODS or
 * METHOD statement declares or implements is a `declaration`, any other use a `call`.
 */
function scanMatches(source: string, include: string, target: ScanTarget): Array<Omit<SourceMatch, 'version'>> {
  const word = new RegExp(`\\b${target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const kinds = new Map<number, SourceMatch['kind']>();
  for (const statement of abapStatements(source)) {
    const declares = declaredMethod(statement) ?? implementedMethod(statement);
    const tokens = statement.getTokens();
    tokens.forEach((token, i) => {
      if (!(token instanceof Tokens.Identifier) || !word.test(token.getStr())) return;
      const arrow = tokens[i - 1];
      const qualifier = tokens[i - 2];
      if (target.staticClass && arrow instanceof Tokens.StaticArrow && qualifier?.getStr().toLowerCase() !== target.staticClass) return;
      const row = token.getRow();
      const kind = declares && declares.getRow() === row && declares.getCol() === token.getCol() ? 'declaration' : 'call';
      if (kinds.get(row) !== 'declaration') kinds.set(row, kind);
    });
  }
  const lines = source.split(/\r?\n/);
  return [...kinds]
    .sort(([a], [b]) => a - b)
    .map(([line, kind]) => ({ include, line, text: (lines[line - 1] ?? '').trim(), kind }));
}

/**
 * Read the object's own source and look for the symbol. This is the half the
 * backend index does not return; an include a class does not have is skipped
 * rather than failing the whole where-used.
 *
 * The draft includes are read first, in parallel, and the active half after
 * them: while adt-ls serves the active version, a draft read would get active
 * text. Without a draft of the logged-on user the draft read already is the
 * active version, and the active half reads nothing. Where an include's two
 * versions are byte-identical it is scanned once and its matches are tagged
 * `both`.
 */
async function scanOwnSource(
  adt: AdtLsClient,
  ref: ObjectRef,
  symbol: string,
  readActive?: ActiveSourceReader,
): Promise<SourceScan | undefined> {
  const includes = ref.objectType.startsWith('CLAS') ? CLAS_INCLUDES : [undefined];
  const target = scanTarget(symbol);
  // Best effort: a read that fails in any way, even synchronously, leaves that version unscanned.
  const text = (read: () => Promise<string>) =>
    Promise.resolve()
      .then(read)
      .then((s) => (typeof s === 'string' ? s : undefined))
      .catch(() => undefined);

  const drafts = await Promise.all(
    includes.map(async (include) => ({
      include: include ?? 'main',
      inactive: await text(() => adt.source.read({ ...ref, include })),
    })),
  );
  const activeRead = readActive ? await readActive(includes).catch(() => undefined) : undefined;
  const reads = drafts.map(({ include, inactive }) => ({
    include,
    inactive,
    active: !activeRead ? undefined : 'sameAsServed' in activeRead ? inactive : activeRead.texts.get(include),
  }));

  const scanned: string[] = [];
  const diverged: string[] = [];
  const matches: SourceMatch[] = [];
  let sawActive = false;
  let sawInactive = false;

  for (const { include, inactive, active } of reads) {
    if (inactive === undefined && active === undefined) continue;
    scanned.push(include);
    if (active !== undefined) sawActive = true;
    if (inactive !== undefined) sawInactive = true;

    if (active !== undefined && inactive !== undefined && active !== inactive) {
      diverged.push(include);
      // The include differs, but most of its lines usually do not. Merge on
      // line+text+kind so a caller present in both is ONE match tagged `both`,
      // not two that read as two callers.
      const merged = new Map<string, SourceMatch>();
      const key = (m: Omit<SourceMatch, 'version'>) => `${m.line}\u0000${m.text}\u0000${m.kind}`;
      for (const m of scanMatches(active, include, target)) merged.set(key(m), { ...m, version: 'active' });
      for (const m of scanMatches(inactive, include, target)) {
        const seen = merged.get(key(m));
        if (seen) seen.version = 'both';
        else merged.set(key(m), { ...m, version: 'inactive' });
      }
      matches.push(...merged.values());
      continue;
    }
    // Identical, or only one side readable.
    const only = active !== undefined && inactive !== undefined ? 'both' : active !== undefined ? 'active' : 'inactive';
    const source = (active ?? inactive) as string;
    matches.push(...scanMatches(source, include, target).map((m) => ({ ...m, version: only as SourceMatch['version'] })));
  }

  if (!scanned.length) return undefined;
  const versions: Array<'active' | 'inactive'> = [];
  if (sawActive) versions.push('active');
  if (sawInactive) versions.push('inactive');
  return {
    symbol,
    scanned,
    versions,
    diverged,
    matches,
  };
}

/**
 * `ZCL_X=>METH` or `lo_x->meth` → `METH`. Interface methods are *declared* as
 * `IF_OO_ADT_CLASSRUN~MAIN`, so `~` is deliberately not split on.
 */
function bareSymbol(symbol: string): string | undefined {
  const at = Math.max(symbol.lastIndexOf('=>'), symbol.lastIndexOf('->'));
  if (at < 0) return undefined;
  const tail = symbol.slice(at + 2).trim();
  return tail.length ? tail : undefined;
}

/**
 * Retry a locator-based call with the bare method name when the symbol was
 * given in ABAP's qualified form.
 *
 * Measured: a Copilot run passed `ZCL_ADTPLUS_AI_DEMO2=>GET_CUSTOMER_COUNTS`, got
 * the SDK's "not found in the outline or source", read that as the tool
 * refusing method-level lookup, and fell back to reading the draft source —
 * reporting that the test class does not call the method, which is false of the
 * active version. The SDK's error even lists the declared symbols; the caller
 * just did not retry. So adt+ retries.
 *
 * Returns the locator that actually worked, so the source scan looks for the
 * same symbol the index answered on.
 */
async function withSymbolFallback<T>(
  locator: Locator,
  run: (locator: Locator) => Promise<T>,
): Promise<{ value: T; locator: Locator }> {
  try {
    return { value: await run(locator), locator };
  } catch (err) {
    const bare = locator.symbol ? bareSymbol(locator.symbol) : undefined;
    const message = err instanceof Error ? err.message : String(err);
    if (!bare || !message.includes('not found in the outline or source')) throw err;
    const retry = { ...locator, symbol: bare };
    return { value: await run(retry), locator: retry };
  }
}

export interface ReferencesOptions {
  timeoutMs?: number;
  /** Skip the source scan. On by default: it is the half the index leaves out. */
  scanSource?: boolean;
  /** Supplied by the daemon so the scan can read the active version too. */
  readActiveSource?: ActiveSourceReader;
}

/**
 * Where-used. An empty result is never reported as "no users": the backend's
 * index is cold right after activation and returned `[]` where ARC-1 saw the
 * reference (M6.0 finding 3). A timeout surfaces the SDK's narrow-the-symbol
 * hint verbatim. `includeDeclaration` is not exposed because adt-ls ignores it.
 */
export async function references(
  adt: AdtLsClient,
  ref: ObjectRef,
  locator: Locator,
  opts: ReferencesOptions = {},
): Promise<NavigateResult> {
  const { value: result, locator: used } = await withSymbolFallback(locator, (l) =>
    adt.navigation.findReferences(ref, l, { timeoutMs: opts.timeoutMs }),
  );
  const notes: string[] = [];

  // The scan needs a name to look for; a line/character locator gives none, and
  // CDS sources are not ABAP, so neither gets one. `used` is the locator the
  // index actually answered on, so both halves look for the same symbol.
  const scannable = !isCds(ref) && opts.scanSource !== false && !!used.symbol;
  const sourceScan = scannable
    ? await scanOwnSource(adt, ref, used.symbol as string, opts.readActiveSource)
    : undefined;

  if (isEmpty(result)) {
    notes.push(
      'No references were returned. This does NOT show that nothing uses the symbol: where-used relies on an ' +
        'index that under-reports shortly after an object is activated. Retry later or cross-check with a SAP where-used.',
    );
  }
  if (!isCds(ref)) {
    notes.push(sourceScan ? SAME_OBJECT_SCANNED : SAME_OBJECT_GAP);
    if (sourceScan) notes.push(sourceScan.versions.includes('active') ? VERSION_BOTH : VERSION_SPLIT);
  }
  if (isCds(ref)) {
    notes.push(
      'On CDS, locate by the view name. A position inside an element resolves to the underlying standard field and returns unrelated hits.',
    );
  }
  return { result, notes, ...(sourceScan ? { sourceScan } : {}) };
}

/** Go to the implementation. On ABAP, `declaration` returned the identical payload in every probe. */
export async function definition(adt: AdtLsClient, ref: ObjectRef, locator: Locator): Promise<NavigateResult> {
  const { value } = await withSymbolFallback(locator, (l) => adt.navigation.goToDefinition(ref, l));
  return { result: value, notes: [] };
}

export async function declaration(adt: AdtLsClient, ref: ObjectRef, locator: Locator): Promise<NavigateResult> {
  const { value } = await withSymbolFallback(locator, (l) => adt.navigation.goToDeclaration(ref, l));
  return { result: value, notes: [] };
}

export async function hover(adt: AdtLsClient, ref: ObjectRef, locator: Locator): Promise<NavigateResult> {
  const { value } = await withSymbolFallback(locator, (l) => adt.navigation.hover(ref, l));
  return { result: value, notes: [] };
}

export async function symbols(adt: AdtLsClient, ref: ObjectRef): Promise<NavigateResult> {
  const result = await adt.navigation.documentSymbols(ref);
  return { result, notes: isCds(ref) && isEmpty(result) ? [CDS_THIN] : [] };
}

export interface HierarchyOptions {
  direction?: 'supertypes' | 'subtypes' | 'both';
}

export async function hierarchy(
  adt: AdtLsClient,
  ref: ObjectRef,
  locator: Locator,
  opts: HierarchyOptions = {},
): Promise<NavigateResult> {
  const { value: result } = await withSymbolFallback(locator, (l) =>
    adt.navigation.typeHierarchy(ref, l, { direction: opts.direction }),
  );
  const empty = isEmpty(result) || (typeof result === 'object' && (result as { item?: unknown }).item === null);
  return { result, notes: isCds(ref) && empty ? [CDS_THIN] : [] };
}

/**
 * Syntax check without activating. It checks the object's *stored* source as
 * last saved (M6.0 finding 5), unactivated changes included: adt-ls has no dry
 * run over other text. Text not yet saved goes through `checkrun.ts` instead.
 */
export async function checkSyntax(adt: AdtLsClient, ref: ObjectRef): Promise<NavigateResult> {
  if (isServiceBinding(ref)) return { result: null, notes: syntaxNotes([ref], []) };
  const result = await adt.navigation.checkSyntax(ref);
  const messages = ((result as { items?: Array<{ message?: string }> } | undefined)?.items ?? []).map((d) => d.message ?? '');
  return {
    result,
    notes: [
      'Checked the stored source as last saved, including unactivated changes; to check text before saving it, pass it as `source`.',
      ...syntaxNotes([ref], messages),
    ],
  };
}

/** SAP's texts for a dependency that is inactive or not there yet. */
const INACTIVE_DEPENDENCY = /does not exist or is not active|has inactive parts/i;

/** A service binding has no source, so adt-ls has nothing to syntax-check: it isn't sent. */
export const isServiceBinding = (ref: ObjectRef): boolean => ref.objectType.split('/')[0]?.toUpperCase() === 'SRVB';

/**
 * What a syntax result can't say itself: service bindings aren't checked, and findings on
 * inactive dependencies go away when the objects are activated together, not by editing this one.
 */
export function syntaxNotes(refs: ObjectRef[], messages: string[]): string[] {
  const notes: string[] = [];
  const bindings = refs.filter(isServiceBinding);
  if (bindings.length > 0) {
    notes.push(
      `Not checked: SRVB ${bindings.map((r) => r.name).join(', ')}. A service binding has no source; ` +
        'its errors show when it is activated or published.',
    );
  }
  const inactive = messages.filter((m) => INACTIVE_DEPENDENCY.test(m)).length;
  if (inactive > 0) {
    notes.push(
      `${inactive} finding${inactive > 1 ? 's name' : ' names'} an object that is inactive or doesn't exist yet. If it was ` +
        'just written, activate it and the objects that use it together in one `activate` call (`refs`), then check again.',
    );
  }
  return notes;
}
