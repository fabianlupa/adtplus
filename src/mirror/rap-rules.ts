/**
 * RAP rules of `mirror check` (docs/decisions/012-local-abap-checks-through-abaplint.md): what `onprem`'s
 * activation refused in the M5 greenfield runs and a local file read can find, in `.tabl.ddic`,
 * `.bdef.abdl`, `.dcls.acds` (against the local `.ddls.acds`). Text-level and tolerant: a file a
 * rule can't read is left alone, never reported. Errors only; every message names the fix.
 */

export interface RapFile {
  /** Relative to the mirror root. */
  path: string;
  text: string;
}

export interface RapFinding {
  path: string;
  line: number;
  rule: string;
  message: string;
}

const fileName = (p: string) => p.split('/').pop()!.toLowerCase();

/** Comments blanked out, offsets and line breaks kept; string literals untouched. */
function blankComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') out += text[i++] === '\r' ? '\r' : ' ';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\r\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

// --- TABL -----------------------------------------------------------------------------------

const ANNOTATION = /@[\w.]+\s*:\s*(?:'(?:[^']|'')*'|\[[\s\S]*?\]|\{[\s\S]*?\}|#?[\w.]+)/g;

function checkTable(file: RapFile): RapFinding[] {
  const text = blankComments(file.text);
  const head = /define\s+table\s+([\w/]+)\s*\{/i.exec(text);
  const end = text.lastIndexOf('}');
  if (!head || end < head.index) return [];
  const table = head[1]!.toLowerCase();
  const bodyStart = head.index + head[0].length;

  interface Field {
    name: string;
    type: string;
    annotations: string;
    offset: number;
  }
  const fields: Field[] = [];
  let hasInclude = false;
  let from = bodyStart;
  for (const statement of text.slice(bodyStart, end).split(';')) {
    const start = from;
    from += statement.length + 1;
    if (/^\s*include\b/i.test(statement.replace(ANNOTATION, ''))) {
      hasInclude = true;
      continue;
    }
    const annotations = statement.match(ANNOTATION)?.join('\n') ?? '';
    const decl = /(?:^|\s)(?:key\s+)?([\w/]+)\s*:\s*([\w./]+)/i.exec(statement.replace(ANNOTATION, (m) => ' '.repeat(m.length)));
    if (!decl) continue;
    fields.push({ name: decl[1]!.toLowerCase(), type: decl[2]!.toLowerCase(), annotations, offset: start + decl.index + decl[0].indexOf(decl[1]!) });
  }

  const known = new Set(fields.map((f) => f.name));
  const findings: RapFinding[] = [];
  const references: Array<[string, RegExp, string, string, string]> = [
    ['abap.curr', /@Semantics\.amount\.currencyCode\s*:\s*'([^']*)'/i, 'amount', "@Semantics.amount.currencyCode : '%t.currency'", 'a currency field (`abap.cuky`)'],
    ['abap.quan', /@Semantics\.quantity\.unitOfMeasure\s*:\s*'([^']*)'/i, 'quantity', "@Semantics.quantity.unitOfMeasure : '%t.unit'", 'a unit field (`abap.unit(3)`)'],
  ];
  for (const f of fields) {
    for (const [type, pattern, kind, annotation, referenced] of references) {
      if (f.type !== type) continue;
      const line = lineOf(text, f.offset);
      const ref = pattern.exec(f.annotations);
      if (!ref) {
        findings.push({
          path: file.path,
          line,
          rule: 'tabl_semantics_reference',
          message: `${kind} field ${f.name} has no reference: put \`${annotation.replace('%t', table)}\` above it and ${referenced} in the table (typing it abap.dec instead loses the semantics)`,
        });
        continue;
      }
      const target = ref[1]!.split('.').pop()!.toLowerCase();
      if (!hasInclude && !known.has(target)) {
        findings.push({ path: file.path, line, rule: 'tabl_semantics_reference', message: `${kind} field ${f.name} refers to ${ref[1]}, but the table has no field ${target}: add ${referenced} named ${target}, or point the annotation at the field you have` });
      }
    }
  }
  return findings;
}

// --- BDEF -----------------------------------------------------------------------------------

interface Bdef {
  file: RapFile;
  text: string;
  /** First statement: managed, unmanaged, abstract, projection, interface, extension… */
  kind: string;
  /** `strict ( n )` before the first `define behavior`; bare `strict` is 1, none 0. */
  strict: number;
  strictOffset: number;
  entity?: string;
  entities: Array<{ name: string; header: string; offset: number; headerOffset: number }>;
}

function parseBdef(file: RapFile): Bdef | undefined {
  const text = blankComments(file.text);
  const define = /define\s+behavior\s+for\s+([\w/]+)/i.exec(text);
  const preamble = define ? text.slice(0, define.index) : text;
  const kind = /^\s*(?:(?:with\s+hierarchy|extensible)\s+)?(\w+)/i.exec(preamble.replace(/^\s*\/\*[\s\S]*?\*\//, ''))?.[1]?.toLowerCase();
  if (!kind) return undefined;
  const strict = /(?:^|;)\s*strict\s*(?:\(\s*(\d+)\s*\))?\s*;/i.exec(preamble);
  const entities: Bdef['entities'] = [];
  const re = /define\s+behavior\s+for\s+([\w/]+)([^{]*)\{/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) entities.push({ name: m[1]!, header: m[2]!, offset: m.index, headerOffset: m.index + m[0].length - m[2]!.length - 1 });
  return {
    file,
    text,
    kind,
    strict: strict ? Number(strict[1] ?? 1) : 0,
    strictOffset: strict ? strict.index + strict[0].search(/strict/i) : 0,
    entity: entities[0]?.name,
    entities,
  };
}

function checkBdef(bdef: Bdef, byEntity: Map<string, Bdef>, projections: Map<string, string>): RapFinding[] {
  const { file, text } = bdef;
  const findings: RapFinding[] = [];

  if (bdef.kind === 'strict') {
    findings.push({
      path: file.path,
      line: lineOf(text, text.search(/strict/i)),
      rule: 'bdef_implementation_type_first',
      message: 'a behaviour definition starts with its implementation type (managed, unmanaged, projection, …) and `strict ( n );` follows it; push reads the type from the first statement and refuses this order',
    });
    return findings;
  }

  const managed = bdef.kind === 'managed' || bdef.kind === 'unmanaged';
  for (const entity of bdef.entities) {
    const auth = /\bauthorization\s+master\b\s*(?:\(\s*(\w*)\s*\))?/i.exec(entity.header);
    const line = lineOf(text, auth ? entity.headerOffset + auth.index : entity.offset);
    if (auth) {
      const value = auth[1]?.toLowerCase();
      if (value !== 'global' && value !== 'instance') {
        findings.push({
          path: file.path,
          line,
          rule: 'bdef_authorization_master',
          message: `authorization master takes ( global ) or ( instance ), not ${auth[1] ? `( ${auth[1]} )` : 'nothing'}: use ( instance ) with an authorization check in the behaviour pool, or ( global ) for a check that doesn't depend on the instance`,
        });
      }
    } else if (bdef.strict > 0 && managed && !/\bauthorization\s+dependent\b/i.test(entity.header)) {
      findings.push({
        path: file.path,
        line,
        rule: 'bdef_strict_authorization',
        message: `strict BDEF: ${entity.name} needs \`authorization master ( instance )\` (root entity) or \`authorization dependent by _Assoc\` (child entity) in its header`,
      });
    }
  }

  if (bdef.kind === 'projection' && bdef.entity) {
    const base = byEntity.get(projections.get(bdef.entity.toLowerCase()) ?? '');
    if (base && base.kind !== 'projection' && bdef.strict > base.strict) {
      findings.push({
        path: file.path,
        line: lineOf(text, bdef.strictOffset),
        rule: 'bdef_projection_strictness',
        message: `the projection is stricter than its base (${base.file.path} has ${base.strict ? `strict ( ${base.strict} )` : 'no strict'}): use strict ( ${base.strict} ) here too, or raise the base's`,
      });
    }
  }
  return findings;
}

// --- DCLS -----------------------------------------------------------------------------------

/** The elements a role's `where` compares: `( a, b ) = aspect …`, `a = 'X'`, `_assoc.field is not null`. */
function roleElements(text: string): Array<{ name: string; offset: number }> {
  const where = /\bwhere\b/i.exec(text);
  if (!where) return [];
  const bodyStart = where.index + where[0].length;
  const body = text
    .slice(bodyStart)
    .replace(/aspect\s+\w+\s*\([^)]*\)/gi, (m) => 'aspect' + ' '.repeat(m.length - 6))
    .replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
  const found: Array<{ name: string; offset: number }> = [];
  const lhs = /(\(\s*[\w.\s,]+?\s*\)|[\w.]+)\s*(?:=|<>|<=|>=|<|>|\bis\b|\bin\b|\bbetween\b|\blike\b|\bnot\b)/gi;
  for (let m = lhs.exec(body); m; m = lhs.exec(body)) {
    if (/^(?:and|or|not|aspect)$/i.test(m[1]!)) continue;
    const list = m[1]!.startsWith('(') ? m[1]!.slice(1, -1).split(',') : [m[1]!];
    let at = m.index + (m[1]!.startsWith('(') ? 1 : 0);
    for (const item of list) {
      const name = item.trim();
      if (name) found.push({ name, offset: bodyStart + at + item.indexOf(name) });
      at += item.length + 1;
    }
  }
  return found;
}

function checkRole(file: RapFile, views: Map<string, string>): RapFinding[] {
  const text = blankComments(file.text);
  if (/\binherit\b/i.test(text)) return [];
  const grant = /\bgrant\s+select\s+on\s+([\w/]+)/i.exec(text);
  const view = grant ? views.get(grant[1]!.toLowerCase()) : undefined;
  // a view absent here, or with `*` in its field list (the base's elements), is unknown from here
  if (!grant || view === undefined) return [];
  const known = new Set((view.match(/[\w/]+/g) ?? []).map((w) => w.toLowerCase()));
  const findings: RapFinding[] = [];
  for (const { name, offset } of roleElements(text)) {
    const first = name.split('.')[0]!;
    if (known.has(first.toLowerCase())) continue;
    findings.push({
      path: file.path,
      line: lineOf(text, offset),
      rule: 'dcls_unknown_element',
      message: `${first} is not an element of ${grant[1]} (no ${first} in its local view source): name an element or association the view defines, or add it to the view`,
    });
  }
  return findings;
}

// --- all ------------------------------------------------------------------------------------

export function rapFindings(files: RapFile[]): RapFinding[] {
  const tables: RapFile[] = [];
  const bdefs: Bdef[] = [];
  const roles: RapFile[] = [];
  /** Entity name (lower) → its DDL, `undefined` when the field list has `*`. */
  const views = new Map<string, string>();
  /** Projection entity (lower) → its base entity (lower). */
  const projections = new Map<string, string>();

  for (const file of files) {
    const name = fileName(file.path);
    if (name.endsWith('.tabl.ddic')) tables.push(file);
    else if (name.endsWith('.dcls.acds')) roles.push(file);
    else if (name.endsWith('.bdef.abdl')) {
      const bdef = parseBdef(file);
      if (bdef) bdefs.push(bdef);
    } else if (name.endsWith('.ddls.acds')) {
      const text = blankComments(file.text);
      const define = /define\s+(?:root\s+)?(?:custom\s+)?(?:view\s+entity|view|abstract\s+entity)\s+([\w/]+)([^{]*)\{/i.exec(text);
      if (!define) continue;
      const entity = define[1]!.toLowerCase();
      const base = /\bas\s+projection\s+on\s+([\w/]+)/i.exec(define[2]!);
      if (base) projections.set(entity, base[1]!.toLowerCase());
      const list = text.slice(define.index + define[0].length);
      views.set(entity, /(?:^|[{,\s])\*\s*(?:[,}]|$)/.test(list) && base ? '' : text);
    }
  }
  for (const [entity, ddl] of views) if (ddl === '') views.delete(entity);

  const byEntity = new Map<string, Bdef>();
  for (const bdef of bdefs) if (bdef.entity) byEntity.set(bdef.entity.toLowerCase(), bdef);

  return [
    ...tables.flatMap(checkTable),
    ...bdefs.flatMap((b) => checkBdef(b, byEntity, projections)),
    ...roles.flatMap((r) => checkRole(r, views)),
  ];
}
