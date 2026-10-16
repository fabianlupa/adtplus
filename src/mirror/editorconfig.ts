/**
 * AFF's `.editorconfig`, unchanged (ADR-007), from
 * https://github.com/SAP/abap-file-formats/blob/main/.editorconfig.
 * Copyright (c) 2021 SAP SE or an SAP affiliate company. MIT License.
 */
export const AFF_EDITORCONFIG = `# EditorConfig is awesome: https://EditorConfig.org

# top-most EditorConfig file
root = true

# ensure the LF line endings
[*.{abap,md,properties,acds,json,mjs,gitignore,yml,abdl}]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true


[*.json]
indent_style = space
indent_size = 2
`;

/** What AFF's `.editorconfig` covers: `[*.{abap,md,properties,acds,json,mjs,gitignore,yml,abdl}]`. */
const COVERED = /\.(abap|md|properties|acds|json|mjs|gitignore|yml|abdl)$/i;

export interface FormatFinding {
  /** 1-based; the first offending line. */
  line: number;
  rule: string;
  message: string;
}

/** Lines matching `test`, as 1-based numbers. */
function linesWhere(lines: string[], test: (line: string) => boolean): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => test(l) && out.push(i + 1));
  return out;
}

function onLines(rule: string, what: string, hits: number[]): FormatFinding[] {
  if (hits.length === 0) return [];
  const where = hits.length === 1 ? `line ${hits[0]}` : `${hits.length} lines, first ${hits[0]}`;
  return [{ line: hits[0]!, rule, message: `${what} (${where})` }];
}

/**
 * AFF's `.editorconfig` rules for one file (ADR-007: applied without
 * exceptions; reported, never fixed). One finding per rule, at its first line.
 */
export function checkFormat(fileName: string, bytes: Uint8Array): FormatFinding[] {
  if (!COVERED.test(fileName)) return [];
  const findings: FormatFinding[] = [];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    findings.push({ line: 1, rule: 'editorconfig_charset', message: 'UTF-8 byte order mark: AFF wants UTF-8 without one' });
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return [...findings, { line: 1, rule: 'editorconfig_charset', message: 'not valid UTF-8' }];
  }
  if (text === '') return findings;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  findings.push(...onLines('editorconfig_end_of_line', 'CR line ending: AFF wants LF', linesWhere(lines, (l) => l.includes('\r'))));
  if (!text.endsWith('\n')) {
    findings.push({ line: lines.length, rule: 'editorconfig_insert_final_newline', message: 'no final newline' });
  }
  findings.push(
    ...onLines('editorconfig_trim_trailing_whitespace', 'trailing whitespace', linesWhere(lines, (l) => /[ \t]$/.test(l.replace(/\r$/, '')))),
  );
  if (/\.json$/i.test(fileName)) {
    const indent = (l: string) => l.match(/^[ \t]*/)![0];
    findings.push(
      ...onLines(
        'editorconfig_indent',
        'indentation not in steps of 2 spaces',
        linesWhere(lines, (l) => indent(l).includes('\t') || indent(l).length % 2 !== 0),
      ),
    );
  }
  return findings;
}
