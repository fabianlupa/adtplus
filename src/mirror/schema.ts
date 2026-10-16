import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { AFF_SCHEMAS } from './aff-schemas/index.js';

/**
 * A mirror's `.json` files against AFF's schemas (docs/decisions/007-mirror-mode.md,
 * "Local checks"), the schema chosen as AFF's own `json-validator.py` does:
 * the most specific type in the file name, then `<type>-v<formatVersion>`.
 */

export interface SchemaFinding {
  /** 1-based line of the offending key, 1 when it can't be placed. */
  line: number;
  message: string;
}

export type SchemaResult =
  | { status: 'valid'; schema: string }
  | { status: 'invalid'; schema?: string; findings: SchemaFinding[] }
  /** No vendored schema for the file's type (or its format version). */
  | { status: 'noSchema'; type: string };

/** File-name parts that name another schema (json-validator.py `TYPE_ALIASES`). */
const TYPE_ALIASES: Record<string, string> = { 'tabl.settings': 'tabt' };

/**
 * The schema types a file name may stand for, most specific first:
 * `x.fugr.y.func.json` → func, y, fugr, …; `x.tabl.settings.json` → tabt, settings, tabl.
 */
export function schemaTypes(fileName: string): string[] {
  const parts = fileName.toLowerCase().split('.');
  if (parts.length < 3) return [];
  const semantic = parts.slice(1, -1);
  const candidates: string[] = [];
  if (semantic.length >= 2) {
    const combined = `${semantic[0]}.${semantic[semantic.length - 1]}`;
    if (TYPE_ALIASES[combined]) candidates.push(TYPE_ALIASES[combined]);
  }
  for (const part of [...semantic].reverse()) candidates.push(TYPE_ALIASES[part] ?? part);
  for (let n = 2; n <= semantic.length; n++) {
    const joined = semantic.slice(0, n).join('.');
    candidates.push(TYPE_ALIASES[joined] ?? joined);
  }
  return [...new Set(candidates)];
}

let ajv: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();

/** One Ajv for every AFF schema, the mirror's checks and `properties` (`capabilities/properties.ts`) alike. */
export function compileAffSchema(schema: object): ValidateFunction {
  // AFF's schemas carry their own annotation keywords; `date` is their one format.
  ajv ??= new Ajv2020({ allErrors: true, verbose: true, strict: false, formats: { date: /^\d{4}-\d{2}-\d{2}$/ } });
  return ajv.compile(schema);
}

function validatorFor(schema: string): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = compileAffSchema(AFF_SCHEMAS[schema]!);
    compiled.set(schema, validate);
  }
  return validate;
}

/**
 * The one known exception (docs/tools/mirror.md, "check"): adt-ls
 * serves an unpublished binding's `serviceBuildVersion` as `""`, which AFF's
 * pattern `^[0-9]+$` refuses.
 */
function isKnownException(fileName: string, error: ErrorObject): boolean {
  return (
    fileName.toLowerCase().endsWith('.srvb.json') &&
    error.keyword === 'pattern' &&
    /^\/services\/\d+\/versions\/\d+\/serviceBuildVersion$/.test(error.instancePath) &&
    error.data === ''
  );
}

/** Validate one `.json` file's text; `fileName` is its base name. */
export function validateAffJson(fileName: string, text: string): SchemaResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'invalid', findings: [{ line: jsonErrorLine(text, message), message: `not valid JSON: ${message}` }] };
  }
  const types = schemaTypes(fileName);
  const version = data && typeof data === 'object' ? (data as Record<string, unknown>).formatVersion : undefined;
  if (typeof version !== 'string' || !/^\d+$/.test(version)) {
    if (!types.some((t) => Object.keys(AFF_SCHEMAS).some((s) => s.startsWith(`${t}-v`)))) {
      return { status: 'noSchema', type: types[0] ?? '' };
    }
    return { status: 'invalid', findings: [{ line: 1, message: 'formatVersion missing: AFF wants a string such as "1"' }] };
  }
  const schema = types.map((t) => `${t}-v${version}`).find((s) => s in AFF_SCHEMAS);
  if (!schema) return { status: 'noSchema', type: types[0] ?? '' };

  const validate = validatorFor(schema);
  if (validate(data)) return { status: 'valid', schema };
  const errors = (validate.errors ?? []).filter((e) => !isKnownException(fileName, e));
  if (errors.length === 0) return { status: 'valid', schema };
  return {
    status: 'invalid',
    schema,
    findings: errors.map((e) => {
      const extra = e.keyword === 'additionalProperties' ? (e.params as { additionalProperty: string }).additionalProperty : undefined;
      const pointer = extra === undefined ? e.instancePath : `${e.instancePath}/${extra}`;
      return {
        line: lineOf(text, pointer),
        message: `${pointer || '/'} ${e.message ?? e.keyword} [${schema}]`,
      };
    }),
  };
}

/** The line V8 names in a `JSON.parse` error ("… (line 3 column 5)" or "at position 42"). */
function jsonErrorLine(text: string, message: string): number {
  const line = message.match(/\(line (\d+) column \d+\)/);
  if (line) return Number(line[1]);
  const pos = message.match(/at position (\d+)/);
  return pos ? text.slice(0, Number(pos[1])).split('\n').length : 1;
}

/**
 * The 1-based line where the value (or, for a missing one, the parent) at a
 * JSON pointer starts in valid JSON `text`; 1 when it can't be placed.
 */
export function lineOf(text: string, pointer: string): number {
  const want = pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let i = 0;
  let best = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  // Walks one value; `depth` is how many pointer segments the path to it matched.
  const value = (depth: number): void => {
    ws();
    if (depth === want.length) best = i;
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      for (let index = 0; ; index++) {
        ws();
        if (text[i] === close) {
          i++;
          return;
        }
        let key = String(index);
        if (c === '{') {
          const keyAt = i;
          key = str();
          ws();
          i++; // ':'
          if (depth < want.length && key === want[depth] && depth + 1 === want.length) best = keyAt;
        }
        value(depth < want.length && key === want[depth] ? depth + 1 : Number.POSITIVE_INFINITY);
        ws();
        if (text[i] === ',') i++;
      }
    }
    if (c === '"') {
      str();
      return;
    }
    while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
  };
  try {
    value(0);
  } catch {
    return 1;
  }
  return text.slice(0, best).split('\n').length;
}
