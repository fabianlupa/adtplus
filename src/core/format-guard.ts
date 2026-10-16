import { CDSParser, MemoryFile, Tokens, Unknown } from '@abaplint/core';
import { abapStatements } from './abap-statements.js';

/**
 * Formatting never changes code (ADR-017): the text before and after a format must say the same.
 * ABAP: the same abaplint tokens, keywords and identifiers without case, literals exactly,
 * comments without case and whitespace, since formatters re-space and re-case them (`"x` → `" x`).
 * DDL syntax (CDS, BDEF, SRVD, TABL …): the same text once whitespace is removed and case ignored,
 * comments included; for a data definition abaplint parses, also its literals exactly.
 */

/** `ddl`: the CDS family's syntax (data definitions, behavior definitions, service definitions, tables …). */
export type SourceLanguage = 'abap' | 'ddl';

interface Tok {
  /** What is compared. */
  key: string;
  line: number;
}

export type GuardResult = { verified: true } | { verified: false; difference: string };

export interface FormatCheck {
  guard: GuardResult;
  /** ABAP only: lines of statements abaplint can't parse in `before`; a formatter lays out what follows them by guesswork. */
  unparsedLines: number[];
}

/** One parse: the tokens and the lines abaplint can't parse. */
function abapParse(source: string): { tokens: Tok[]; unparsed: number[] } {
  const statements = abapStatements(source);
  const tokens = statements.flatMap((s) =>
    s.getTokens().map((t) => {
      const str = t.getStr();
      const literal =
        t instanceof Tokens.StringToken ||
        t instanceof Tokens.StringTemplate ||
        t instanceof Tokens.StringTemplateBegin ||
        t instanceof Tokens.StringTemplateMiddle ||
        t instanceof Tokens.StringTemplateEnd;
      const key = literal ? str : t instanceof Tokens.Comment ? str.replace(/\s+/g, '').toLowerCase() : str.toLowerCase();
      return { key, line: t.getRow() };
    }),
  );
  const unparsed = statements.filter((s) => s.get() instanceof Unknown).map((s) => s.getStart().getRow());
  return { tokens, unparsed: [...new Set(unparsed)] };
}

/** A data definition's literals, when abaplint parses it (its tree has no comment tokens). */
function ddlLiterals(source: string): Tok[] | undefined {
  const tree = new CDSParser().parse(new MemoryFile('zadtplus_source.ddls.asddls', source));
  return tree
    ?.getAllTokens()
    .filter((t) => /^['"]/.test(t.getStr()))
    .map((t) => ({ key: t.getStr(), line: t.getRow() }));
}

/** The line a token or character sits on, as the difference names it. */
function quote(source: string, line: number | undefined): string {
  if (line === undefined) return 'the end';
  const text = (source.split('\n')[line - 1] ?? '').trim();
  return `line ${line} "${text.length > 80 ? `${text.slice(0, 77)}...` : text}"`;
}

function firstTokenDifference(before: string, after: string, a: Tok[], b: Tok[]): string | undefined {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]?.key !== b[i]?.key) return `${quote(before, a[i]?.line)} became ${quote(after, b[i]?.line)}`;
  }
  return undefined;
}

/** Each non-whitespace character, lowercased, with its line. */
function visible(source: string): Array<{ ch: string; line: number }> {
  const out: Array<{ ch: string; line: number }> = [];
  let line = 1;
  for (const ch of source.toLowerCase()) {
    if (ch === '\n') line++;
    else if (!/\s/.test(ch)) out.push({ ch, line });
  }
  return out;
}

function firstTextDifference(before: string, after: string): string | undefined {
  const [a, b] = [visible(before), visible(after)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]?.ch !== b[i]?.ch) return `${quote(before, a[i]?.line)} became ${quote(after, b[i]?.line)}`;
  }
  return undefined;
}

export function checkFormat(language: SourceLanguage, before: string, after: string): FormatCheck {
  if (language === 'abap') {
    const [a, b] = [abapParse(before), abapParse(after)];
    const difference = firstTokenDifference(before, after, a.tokens, b.tokens);
    return { guard: difference ? { verified: false, difference } : { verified: true }, unparsedLines: a.unparsed };
  }
  let difference = firstTextDifference(before, after);
  if (!difference) {
    const [a, b] = [ddlLiterals(before), ddlLiterals(after)];
    if (a && b) difference = firstTokenDifference(before, after, a, b);
  }
  return { guard: difference ? { verified: false, difference } : { verified: true }, unparsedLines: [] };
}
