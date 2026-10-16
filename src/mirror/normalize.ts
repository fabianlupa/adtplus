import { createHash } from 'node:crypto';

/**
 * Line endings in the mirror (docs/decisions/007-mirror-mode.md): local
 * files are LF with one final newline, and a file's hash is taken over its
 * normalized content, so an editor or git touching line endings never makes a
 * file look changed. Trailing whitespace is content and stays.
 */

/** CRLF → LF, then one final newline dropped. */
export function normalize(text: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  return lf.endsWith('\n') ? lf.slice(0, -1) : lf;
}

/** The SHA-1 git gives a blob with this content: what the git helper compares and writes. */
export function blobSha(data: Buffer): string {
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

/** SHA-256 (hex) of the normalized text. */
export function contentHash(text: string): string {
  return createHash('sha256').update(normalize(text), 'utf8').digest('hex');
}

/** What a pull writes: LF with a final newline; an empty file stays empty. */
export function toLocal(text: string): string {
  const body = normalize(text);
  return body === '' ? '' : `${body}\n`;
}

/** How the system keeps a file: its line ending and whether it ends with one. */
export interface LineStyle {
  eol: '\r\n' | '\n';
  finalNewline: boolean;
}

/**
 * The style to write `fileName` in (ADR-007, "Push"): taken from the
 * system's current text, its majority line ending and its final newline. An
 * empty text has none, so a file kind's default applies: CRLF for `.abap` and
 * `.acds`, LF without a final newline for everything else.
 */
export function lineStyle(remote: string, fileName: string): LineStyle {
  const crlf = (remote.match(/\r\n/g) ?? []).length;
  const lf = (remote.match(/\n/g) ?? []).length - crlf;
  if (crlf + lf === 0) {
    const source = /\.(abap|acds)$/i.test(fileName);
    return { eol: source ? '\r\n' : '\n', finalNewline: source && remote === '' };
  }
  return { eol: crlf > lf ? '\r\n' : '\n', finalNewline: remote.endsWith('\n') };
}

/** A local file's text in the system's style. */
export function toSystem(local: string, style: LineStyle): string {
  const body = normalize(local);
  if (body === '') return '';
  return body.replace(/\n/g, style.eol) + (style.finalNewline ? style.eol : '');
}
