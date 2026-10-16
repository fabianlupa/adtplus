import type { AdtLsClient, ObjectRef } from '@arc-mcp/adt-ls';
import type { RawAdtClient } from '../backends/rawadt.js';
import { cleanSource, type AbapCleanerOptions } from '../core/abap-cleaner.js';
import type { Destination } from '../core/destinations.js';
import { checkFormat, type SourceLanguage } from '../core/format-guard.js';

/**
 * Format one object's source, the stored one or `source` text, without saving it (ADR-017).
 * Engines: `sap` (adt-ls's formatter for the stored source; ADT's REST pretty printer for ABAP
 * text, which the SDK can't send to adt-ls) and `abap-cleaner` (local). Every result passes
 * `core/format-guard.ts`: formatting never changes code; one that did is refused.
 */

export type FormatEngine = 'sap' | 'abap-cleaner';

export interface FormatInput {
  ref: ObjectRef;
  /** Text to format as this object's source; omit to format the stored source. */
  source?: string;
}

export interface FormatResult {
  /** The formatted text, `\n` line ends, ending in a newline when the input did. */
  formatted: string;
  /** Whether it differs from the input. */
  changed: boolean;
  engine: FormatEngine;
  /** What was formatted: the stored source as last saved (the logged-on user's draft included), or `source`. */
  input: 'stored' | 'source';
  /** Lines of statements abaplint can't parse, in the input; SAP's formatter lays out what follows them by guesswork. */
  unparsedLines?: number[];
  notes: string[];
  via?: 'rest-fallback';
  /** The REST fallback waits for an SDK whose format takes text, not for a system feature: no runtime probe (ADR-017). */
  nativeAvailable?: null;
}

export interface FormatDeps {
  adt: () => Promise<AdtLsClient>;
  withRest: <T>(fn: (rest: RawAdtClient) => Promise<T>) => Promise<T>;
}

/** Types whose source is in the CDS family's syntax, not ABAP: CDS, behavior and service definitions, tables, scalar functions. */
const DDL_TYPES = new Set(['DDLS', 'DCLS', 'DDLX', 'DRTY', 'BDEF', 'SRVD', 'TABL', 'DSFD']);
const mainType = (ref: ObjectRef) => ref.objectType.split('/')[0]!.toUpperCase();

export function languageOf(ref: ObjectRef): SourceLanguage {
  return DDL_TYPES.has(mainType(ref)) ? 'ddl' : 'abap';
}

export function engineOf(destination: Pick<Destination, 'format'>): FormatEngine {
  return destination.format?.engine ?? 'sap';
}

/** Every check that needs no SAP call, so a refused format opens no session (or SSO window). */
export function checkFormatInput(destination: Pick<Destination, 'format'>, input: FormatInput): void {
  if (mainType(input.ref) === 'SRVB') throw new Error(`SRVB ${input.ref.name} has no source to format`);
  if (input.source !== undefined && engineOf(destination) === 'sap' && languageOf(input.ref) === 'ddl') {
    throw new Error(
      `format.engine "sap" can't format ${mainType(input.ref)} text that isn't saved: adt-ls can, but the SDK sends it only the stored ` +
        `source, and ADT's REST pretty printer formats ABAP only. Save it and format the stored source, or set format.engine to "abap-cleaner"`,
    );
  }
}

/** `\r\n` to `\n`, and a final newline exactly when `like` has one. */
export function normalize(text: string, like: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  const wantsNewline = like.endsWith('\n');
  if (wantsNewline && !lf.endsWith('\n')) return `${lf}\n`;
  if (!wantsNewline && lf.endsWith('\n')) return lf.replace(/\n+$/, '');
  return lf;
}

async function storedSource(adt: AdtLsClient, ref: ObjectRef): Promise<string> {
  return adt.repository.readFile(await adt.lifecycle.resolveAffUri(ref));
}

/** ADT's pretty printer: text in, text out, nothing saved. ABAP only (CDS comes back unchanged). */
async function prettyPrint(rest: RawAdtClient, source: string): Promise<string> {
  const res = await rest.expectOk('POST', '/sap/bc/adt/abapsource/prettyprinter', 'pretty printer', {
    changesNothing: true,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain' },
    body: source,
  });
  return res.body;
}

export async function formatSource(deps: FormatDeps, destination: Pick<Destination, 'format'>, input: FormatInput): Promise<FormatResult> {
  checkFormatInput(destination, input);
  const engine = engineOf(destination);
  const language = languageOf(input.ref);
  const notes: string[] = [];
  let before: string;
  let after: string;
  let via: 'rest-fallback' | undefined;

  if (engine === 'abap-cleaner') {
    before = input.source ?? (await storedSource(await deps.adt(), input.ref));
    after = await cleanSource(before, (destination.format?.abapCleaner ?? {}) as AbapCleanerOptions);
  } else if (input.source !== undefined) {
    before = input.source;
    after = await deps.withRest((rest) => prettyPrint(rest, before));
    via = 'rest-fallback';
  } else {
    const adt = await deps.adt();
    before = await storedSource(adt, input.ref);
    after = (await adt.navigation.format(input.ref)).formatted;
  }
  if (engine === 'sap') notes.push("Formatted with the logon user's pretty printer settings on the system, as ADT's Format does.");
  if (input.source === undefined && mainType(input.ref) === 'CLAS') {
    notes.push("A class's main source only; its local test classes and other includes aren't formatted.");
  }

  const formatted = normalize(after, before);
  const original = before.replace(/\r\n/g, '\n');
  const { guard, unparsedLines: unparsed } = checkFormat(language, before, formatted);
  if (!guard.verified) {
    // adt-ls formats what it reads itself: a save in between, not the formatter, would explain a difference.
    if (engine === 'sap' && input.source === undefined && (await storedSource(await deps.adt(), input.ref)) !== before) {
      throw new Error(`${input.ref.name}'s stored source changed while it was formatted; format it again`);
    }
    throw new Error(`${engine} changed the code, not just its layout: ${guard.difference}. Nothing returned`);
  }
  if (unparsed.length > 0 && engine === 'sap') {
    notes.push(`abaplint can't parse line ${unparsed.join(', ')}: if that is a syntax error, the layout after it is wrong; check syntax first.`);
  }
  return {
    formatted,
    changed: formatted !== original,
    engine,
    input: input.source === undefined ? 'stored' : 'source',
    ...(unparsed.length > 0 ? { unparsedLines: unparsed } : {}),
    notes,
    ...(via ? { via, nativeAvailable: null } : {}),
  };
}
