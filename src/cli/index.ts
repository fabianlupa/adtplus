import { homedir } from 'node:os';
import { sendCommand } from '../daemon/client.js';
import { runConfig } from './config.js';
import { parseFlags, type Flags } from './flags.js';
import { buildMirrorRequest, ruleSwitches } from './mirror.js';
import { tildePath } from '../core/project-config.js';
import type { TranslationStatus } from '../capabilities/translations.js';
import type { CheckTargets, ConnectResponse, DaemonRequest, DaemonResponse, ErrorResponse, StatusResponse } from '../daemon/protocol.js';

function num(flags: Flags, key: string): number | undefined {
  const v = flags[key];
  return v === undefined ? undefined : Number(v);
}

function bool(flags: Flags, key: string): boolean | undefined {
  const v = flags[key];
  return v === undefined ? undefined : v !== 'false';
}

function requireStr(flags: Flags, key: string): string {
  const v = flags[key];
  if (v === undefined) throw new Error(`missing required --${key}`);
  return v;
}

function ref(flags: Flags): { name: string; objectType: string } {
  return { name: requireStr(flags, 'name'), objectType: requireStr(flags, 'type') };
}

/**
 * A check's target: `--refs '<json>'` or `--package <pkg> [--subpackages]` for a batch, else `--name --type`.
 * Every target given is passed on: the daemon refuses more than one.
 */
function checkTarget(flags: Flags): CheckTargets {
  const given = [flags.name !== undefined || flags.type !== undefined, flags.refs !== undefined, flags.package !== undefined];
  if (given.filter(Boolean).length > 1) throw new Error('give exactly one of --name + --type, --refs or --package');
  if (flags.refs !== undefined) return { refs: JSON.parse(flags.refs) as { name: string; objectType: string }[] };
  if (flags.package !== undefined) return { package: flags.package, subpackages: bool(flags, 'subpackages') };
  return { ref: ref(flags) };
}

/** `--fields '{"sourceType":"S"}'`: a create's type-specific fields, as one JSON object. */
function jsonObject(value: string | undefined, flag: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${flag} must be a JSON object`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${flag} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

/** `--status missing,outdated`: translation statuses; the daemon checks the names. */
function statuses(v: string | undefined): TranslationStatus[] | undefined {
  return v === undefined ? undefined : (v.split(',').map((s) => s.trim()).filter(Boolean) as TranslationStatus[]);
}

/** `--path` is a JSON array of folder names, or a single bare folder name. */
function folderPath(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (!v.trim().startsWith('[')) return [v];
  const parsed: unknown = JSON.parse(v);
  if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
    throw new Error('--path must be a JSON array of folder names');
  }
  return parsed;
}

function printStatus(res: StatusResponse, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(
    `daemon pid ${res.pid}, uptime ${Math.round(res.uptimeMs / 1000)}s ` +
      `(build ${res.identity.build}, config ${res.identity.config})`,
  );
  const { adtLs } = res;
  console.log(
    `adt-ls ${adtLs.version ?? 'version unknown'} (${adtLs.source}; verified ${adtLs.verified}` +
      `${adtLs.match === false ? ', MISMATCH' : ''}) at ${adtLs.path ?? 'no binary found'}`,
  );
  for (const warning of res.warnings ?? []) console.log(`  ⚠ ${warning}`);
  for (const file of res.config?.files ?? []) {
    if (file.kind === 'project') console.log(`project config ${tildePath(file.path)}${file.trusted ? '' : ' (NOT approved)'}`);
  }
  if (res.config?.error) console.log(`  ⚠ config: ${res.config.error}`);
  for (const [system, info] of Object.entries(res.sessions)) {
    const from = res.config?.projectFiles[system]?.map((f) => tildePath(f)) ?? [];
    const suffix = from.length > 0 ? ` [from ${from.join(', ')}]` : '';
    if (!info) {
      console.log(`  ${system}: no session${suffix}`);
      continue;
    }
    console.log(
      `  ${system}: connected (${info.logonKind}, dest ${info.destination}, since ${info.connectedAt})${suffix}`,
    );
  }
  for (const [system, reason] of Object.entries(res.config?.refused ?? {})) {
    console.log(`  ${system}: refused, ${reason.replaceAll(`${homedir()}/`, '~/')}`);
  }
  for (const [system, rest] of Object.entries(res.restSessions)) {
    if (rest) console.log(`  ${system}: REST fallback session (${rest.kind}, since ${rest.connectedAt})`);
  }
  for (const [system, clock] of Object.entries(res.clocks ?? {})) {
    if (!clock) continue;
    const scale = (m: number | undefined, why: string | undefined) =>
      m === undefined ? `not measured (${why ?? 'unknown'}), as sent` : `UTC${m < 0 ? '-' : '+'}${Math.floor(Math.abs(m) / 60)}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
    console.log(
      `  ${system}: system clock ${scale(clock.localOffsetMinutes, clock.errors?.local)}, feed times ` +
        `${scale(clock.feedOffsetMinutes, clock.errors?.feed)} (measured ${clock.measuredAt}; reported times corrected to UTC)`,
    );
  }
  for (const [system, check] of Object.entries(res.serviceChecks ?? {})) {
    if (!check) continue;
    console.log(
      `  ${system}: OData UI service ${check.service} ${check.ok ? 'as adt+ calls it' : `changed: ${check.mismatches?.join('; ')}`} (checked ${check.checkedAt})`,
    );
  }
  for (const [system, native] of Object.entries(res.native)) {
    if (!native) continue;
    const retirable = [
      native.packageCreate && 'package',
      native.transportRelease && 'transport release',
      native.transportContents && 'transport read',
      native.messageClass && 'message classes',
    ].filter(Boolean);
    console.log(
      `  ${system}: native support probed ${native.probedAt} — ` +
        (retirable.length ? `REST fallback retirable for: ${retirable.join(', ')}` : 'REST fallbacks still needed'),
    );
  }
}

function buildRequest(tool: string, action: string, flags: Flags): DaemonRequest {
  const system = requireStr(flags, 'system');
  switch (tool) {
    case 'transport':
      switch (action) {
        case 'list':
          return { cmd: 'transport.list', system, query: flags.query, maxResults: num(flags, 'max') };
        case 'find':
          return {
            cmd: 'transport.find',
            system,
            ref: ref(flags),
            package: requireStr(flags, 'package'),
            isCreation: bool(flags, 'creation') ?? false,
          };
        case 'check':
          return {
            cmd: 'transport.check',
            system,
            ref: ref(flags),
            operation: flags.operation as 'CREATE' | 'MODIFY' | 'DELETE' | undefined,
          };
        case 'read':
          return { cmd: 'transport.read', system, transport: requireStr(flags, 'transport') };
        case 'diff':
          return {
            cmd: 'transport.diff',
            system,
            transport: requireStr(flags, 'transport'),
            cursor: flags.cursor,
            pageSize: num(flags, 'page-size'),
          };
        case 'create':
          return {
            cmd: 'transport.create',
            system,
            ref: ref(flags),
            package: requireStr(flags, 'package'),
            transportDescription: requireStr(flags, 'description'),
            isCreation: bool(flags, 'creation') ?? false,
          };
        case 'assign':
          return { cmd: 'transport.assign', system, ref: ref(flags), transport: requireStr(flags, 'transport') };
        case 'release':
          return {
            cmd: 'transport.release',
            system,
            transport: requireStr(flags, 'transport'),
            confirm: bool(flags, 'confirm'),
          };
        default:
          throw new Error(`unknown transport action "${action}"`);
      }

    case 'object':
      switch (action) {
        case 'create':
          return {
            cmd: 'object.create',
            system,
            ref: ref(flags),
            package: requireStr(flags, 'package'),
            description: requireStr(flags, 'description'),
            transport: flags.transport,
            additionalFields: jsonObject(flags.fields, '--fields'),
            properties: jsonObject(flags.properties, '--properties'),
          };
        case 'validate':
          return {
            cmd: 'object.validate',
            system,
            ref: ref(flags),
            package: requireStr(flags, 'package'),
            description: requireStr(flags, 'description'),
            transport: flags.transport,
            properties: jsonObject(flags.properties, '--properties'),
          };
        case 'update':
          return {
            cmd: 'object.update',
            system,
            ref: ref(flags),
            source: flags.source,
            include: flags.include,
            properties: jsonObject(flags.properties, '--properties'),
            transport: flags.transport,
          };
        case 'delete-messages':
          return {
            cmd: 'object.deleteMessages',
            system,
            name: requireStr(flags, 'name'),
            numbers: requireStr(flags, 'numbers').split(',').map((n) => n.trim()),
            transport: flags.transport,
            confirm: bool(flags, 'confirm'),
          };
        case 'activate':
          return {
            cmd: 'object.activate',
            system,
            refs: flags.refs ? (JSON.parse(flags.refs) as { name: string; objectType: string }[]) : [ref(flags)],
            forceActivation: bool(flags, 'force'),
          };
        case 'list-inactive':
          return { cmd: 'object.listInactive', system };
        case 'delete':
          return { cmd: 'object.delete', system, ref: ref(flags), confirm: bool(flags, 'confirm'), transport: flags.transport };
        case 'lock-status':
          return { cmd: 'object.lockStatus', system, ref: ref(flags) };
        case 'read':
          if (bool(flags, 'active') && flags.version !== undefined) throw new Error('give --active or --version, not both');
          return {
            cmd: 'object.read',
            system,
            ref: ref(flags),
            include: flags.include,
            version: bool(flags, 'active') ? 'active' : flags.version,
            method: flags.method,
            grep: flags.grep,
            context: num(flags, 'context'),
            fromLine: num(flags, 'from'),
            toLine: num(flags, 'to'),
            maxLines: num(flags, 'max-lines'),
            language: flags.language,
            translationStatus: statuses(flags.status),
            maxResults: num(flags, 'max'),
            cursor: flags.cursor,
          };
        case 'translations':
          return {
            cmd: 'object.translations',
            system,
            ref: ref(flags),
            language: flags.language,
            translationStatus: statuses(flags.status),
            grep: flags.grep,
            maxResults: num(flags, 'max'),
            cursor: flags.cursor,
          };
        case 'diff':
          return {
            cmd: 'object.diff',
            system,
            ref: ref(flags),
            include: flags.include,
            version: flags.version,
            baseVersion: flags.base,
            context: num(flags, 'context'),
            maxLines: num(flags, 'max-lines'),
          };
        case 'versions':
          return { cmd: 'object.versions', system, ref: ref(flags), include: flags.include, maxResults: num(flags, 'max') };
        case 'resolve':
          return { cmd: 'object.resolve', system, ref: ref(flags) };
        case 'search':
          return {
            cmd: 'object.search',
            system,
            query: requireStr(flags, 'query'),
            objectType: flags.type,
            maxResults: num(flags, 'max'),
          };
        case 'list':
          return {
            cmd: 'object.list',
            system,
            package: requireStr(flags, 'package'),
            path: folderPath(flags.path),
            depth: num(flags, 'depth'),
            maxRequests: num(flags, 'max-requests'),
          };
        case 'publish':
        case 'unpublish': {
          // `--settle-timeout` is in seconds: a cloud un-publish is refused
          // instantly for the first minutes after a publish (see publishService).
          const settleSeconds = num(flags, 'settle-timeout');
          return {
            cmd: action === 'publish' ? 'object.publish' : 'object.unpublish',
            system,
            ref: ref(flags),
            confirm: bool(flags, 'confirm'),
            settleTimeoutMs: settleSeconds === undefined ? undefined : settleSeconds * 1000,
          };
        }
        case 'generators':
          return { cmd: 'object.generators', system };
        case 'generator-schema':
        case 'generate': {
          const referencedObject = flags.ref === undefined ? undefined : { name: flags.ref, objectType: requireStr(flags, 'ref-type') };
          const target = { system, generatorId: requireStr(flags, 'generator'), package: requireStr(flags, 'package'), referencedObject };
          if (action === 'generator-schema') return { cmd: 'object.generatorSchema', ...target };
          return { cmd: 'object.generate', ...target, content: jsonObject(flags.content, '--content'), transport: flags.transport };
        }
        case 'service-info':
          return { cmd: 'object.serviceInfo', system, ref: ref(flags), service: flags.service };
        case 'apply-quickfixes':
          return { cmd: 'object.applyQuickfixes', system, worklistId: requireStr(flags, 'worklist'), transport: flags.transport };
        default:
          throw new Error(`unknown object action "${action}"`);
      }

    case 'navigate': {
      const at = {
        symbol: flags.symbol,
        line: num(flags, 'line'),
        character: num(flags, 'character'),
      };
      switch (action) {
        case 'where-used':
          return {
            cmd: 'navigate.whereUsed',
            system,
            ref: ref(flags),
            ...at,
            timeoutMs: num(flags, 'timeout'),
            scanSource: flags['no-scan-source'] !== undefined ? false : undefined,
          };
        case 'definition':
          return { cmd: 'navigate.definition', system, ref: ref(flags), ...at };
        case 'declaration':
          return { cmd: 'navigate.declaration', system, ref: ref(flags), ...at };
        case 'hover':
          return { cmd: 'navigate.hover', system, ref: ref(flags), ...at };
        case 'outline':
          return { cmd: 'navigate.outline', system, ref: ref(flags) };
        case 'type-hierarchy':
          return {
            cmd: 'navigate.typeHierarchy',
            system,
            ref: ref(flags),
            ...at,
            direction: flags.direction as 'supertypes' | 'subtypes' | 'both' | undefined,
          };
        default:
          throw new Error(`unknown navigate action "${action}"`);
      }
    }

    case 'run':
      return { cmd: 'run.application', system, ref: ref(flags), confirm: bool(flags, 'confirm') };

    case 'test':
      return { cmd: 'test.unit', system, ref: ref(flags), coverage: bool(flags, 'coverage') };

    case 'data':
      return { cmd: 'data.query', system, statement: requireStr(flags, 'statement'), maxRows: num(flags, 'max-rows') };

    case 'system':
      if (action !== 'messages') throw new Error(`unknown system action "${action}"`);
      return { cmd: 'system.messages', system };

    case 'runtime':
      switch (action) {
        case 'dumps':
          return { cmd: 'runtime.dumps', system, user: flags.user, from: flags.from, to: flags.to, maxResults: num(flags, 'max') };
        case 'dump':
          return {
            cmd: 'runtime.dump',
            system,
            id: requireStr(flags, 'id'),
            chapters: flags.chapters?.split(',').map((c) => c.trim()).filter(Boolean),
          };
        case 'gateway-errors':
          return { cmd: 'runtime.gatewayErrors', system, user: flags.user, from: flags.from, to: flags.to, maxResults: num(flags, 'max') };
        case 'gateway-error':
          return {
            cmd: 'runtime.gatewayError',
            system,
            id: requireStr(flags, 'id'),
            sections: flags.sections?.split(',').map((s) => s.trim()).filter(Boolean),
          };
        default:
          throw new Error(`unknown runtime action "${action}"`);
      }

    case 'quality':
      switch (action) {
        case 'syntax':
          return { cmd: 'quality.syntax', system, ...checkTarget(flags), source: flags.source, include: flags.include };
        case 'format':
          return { cmd: 'quality.format', system, ref: ref(flags), source: flags.source };
        case 'atc-variants':
          return { cmd: 'quality.atcVariants', system, ref: ref(flags) };
        case 'atc':
          return {
            cmd: 'quality.atc',
            system,
            ...checkTarget(flags),
            checkVariant: flags.variant,
            timeoutMs: num(flags, 'timeout'),
            quickfixes: bool(flags, 'quickfixes'),
          };
        case 'abaplint':
          return { cmd: 'quality.abaplint', system, ...checkTarget(flags), rules: ruleSwitches(flags.rules) };
        default:
          throw new Error(`unknown quality action "${action}"`);
      }

    default:
      throw new Error(`unknown tool "${tool}"`);
  }
}

const USAGE = `usage:
  adtplus system status [--json]
  adtplus system connect --system <id> [--json]
  adtplus system messages --system <id>
      (the administrators' system messages, SM02)
  adtplus config show|validate [--dir <folder>] [--json]
      (local, no daemon: the user config plus each .adtplus/systems.json from --dir (default: here) up to $HOME;
       show prints the effective systems and where each value comes from; validate also checks Keychain items and CA files)
  adtplus config trust [--dir <folder>]
      (approve the project configs found there that aren't approved yet, each in a macOS dialog)
  adtplus config schema
      (JSON Schema of systems.json; save it next to the file and set "$schema": "./systems.schema.json")
  adtplus transport list --system <id> [--query <text>] [--max <n>]
  adtplus transport find|create --system <id> --name <n> --type <t> --package <pkg> [--creation] [--description <text>]
  adtplus transport check --system <id> --name <n> --type <t> [--operation CREATE|MODIFY|DELETE]
  adtplus transport assign --system <id> --name <n> --type <t> --transport <tr>
  adtplus transport release --system <id> --transport <tr> --confirm
      (your own modifiable request, its tasks first; or your own modifiable task, also in another's request)
  adtplus transport read --system <id> --transport <tr>
  adtplus transport diff --system <id> --transport <tr> [--cursor <c>] [--page-size <1-40>]
      (read: any owner's request or task, open or released: header, tasks, entries. diff: one page of
       adt-ls's diffs, the first page with adt+'s own for what they leave out; --cursor takes nextCursor)
  adtplus object create --system <id> --name <n> --type <t> --package <pkg> --description <text> [--transport <tr>] [--fields '<json>'] [--properties '<json>']
      (--fields: a source-based type's creation fields, e.g. SRVD --fields '{"sourceType":"S"}';
       --properties: a package's (DEVC/K, --package is its superpackage), domain's (DOMA/DD, at least
       '{"format":{"dataType":"CHAR","length":3}}'), data element's (DTEL/DE, at least
       '{"dataTypeInformation":{"category":"domain","typeName":"ZDOM"}}') or message class's (MSAG/N) AFF JSON,
       a translation project's (TRPR) '{"textSources":[{"objectType":"MSAG/N","name":"ZX"}],"languages":[{"source":"en","target":"de"}]}')
  adtplus object validate --system <id> --name <pkg> --type DEVC/K --package <super> --description <text> [--properties '<json>'] [--transport <tr>]
      (SAP's check of a package create, without creating it)
  adtplus object update --system <id> --name <n> --type <t> (--source '<text>' [--include <i>] | --properties '<json>') [--transport <tr>]
      (--properties: AFF JSON merged by key, e.g. MSAG/N '{"messages":[{"number":"001","text":"…"}]}' or
       DEVC/K '{"header":{"description":"…"}}'; a domain's fixedValues/fixedValueIntervals, when given, are
       the new lists; --transport records an object in no open request there;
       a translation project, --type TRPR: '{"translations":[{"language":"de","objectType":"MSAG/N","name":"ZX",
       "key":"SHORT_TEXT:001","target":"…"}]}' uploads and publishes them, needs allowTranslations: true;
       "header", "textSources", "languages" change the description and add sources and pairs)
  adtplus object activate|list-inactive|lock-status --system <id> [...]
  adtplus object delete --system <id> --name <n> --type <t> [--transport <tr>] --confirm
      (a package, --type DEVC/K, only when empty; a translation project, --type TRPR, with its pairs and sources)
  adtplus object delete-messages --system <id> --name <msag> --numbers 001,002 [--transport <tr>] --confirm
      (a message class has no inactive version: a write is live at once; every message needs its number)
  adtplus object resolve --system <id> --name <n> --type <t>
  adtplus object read --system <id> --name <n> --type <t> [--include <i>] [--active | --version <nnnnn>] [--method <m> | --grep <regex> [--context <n>] | --from <n> --to <n>] [--max-lines <n>]
      (the source by name: served says whether it is your inactive draft, --active reads the activated version,
       --version a released one from object versions; a package, domain, data element or message class reads as its AFF properties;
       any flag also takes --flag=value, for a value starting with --, e.g. --grep='-- TODO')
  adtplus object read --system <id> --name <project> --type TRPR [--language <bcp47>] [--status <s,…> [--grep <regex>] [--max <n, default 100, max 500; 0: counts>] [--cursor <c>]]
      (a translation project, only with allowTranslations: true: its text sources and language pairs;
       --status also reads its texts with those statuses (translated, missing, outdated, empty) and counts per pair)
  adtplus object translations --system <id> --name <n> --type <t> [--language <bcp47>] [--status <s,…>] [--grep <regex>] [--max <n>] [--cursor <c>]
      ("Maintain Translations", only with allowTranslations: true: the texts of an object, or a package as DEVC/K,
       in every translation project that covers it, per language pair, with status; next page: --cursor <nextCursor>)
  adtplus object versions --system <id> --name <n> --type <t> [--include <i>] [--max <n, default 50, max 500>]
      (the versions SAP keeps: released ones with request, author and time, the active one and your draft;
       a class without --include lists its main source and every include)
  adtplus object diff --system <id> --name <n> --type <t> [--include <i>] [--version <v>] [--base <v>] [--context <n>] [--max-lines <n>]
      (two versions of one source file as a unified diff; <v> is a number, active or inactive;
       default: inactive (your draft, else active) against the numbered version before it)
  adtplus object search --system <id> --query <pattern*> [--type <t>] [--max <n, default 25, max 100>]
  adtplus object list --system <id> --package <pkg> [--path '["Folder","Sub"]'] [--depth 3] [--max-requests 50]
  adtplus object publish|unpublish --system <id> --name <srvb> --type SRVB/SVB --confirm [--settle-timeout <s>]
      (refused when the binding already is; takes minutes. --settle-timeout keeps re-sending what the backend
       refuses instantly, which is what a cloud unpublish does for a while after a publish)
  adtplus object generators --system <id>
  adtplus object generator-schema|generate --system <id> --generator <id> --package <pkg> [--ref <name> --ref-type <t>] [--content '<json>'] [--transport <tr>]
      (RAP generators: generator-schema proposes the content, generate creates its objects, active; without --content the proposal)
  adtplus object service-info --system <id> --name <srvb> --type SRVB/SVB [--service <name>]
  adtplus object apply-quickfixes --system <id> --worklist <id> [--transport <tr>]
      (every deterministic ATC quick fix of a worklist from quality atc --quickfixes; the objects stay inactive)
  adtplus navigate where-used|definition|declaration|hover|type-hierarchy --system <id> --name <n> --type <t> [--symbol <s> | --line <n> --character <n>] [--timeout <ms>] [--direction supertypes|subtypes|both]
      (where-used also scans the object's own source, which the index misses; --no-scan-source turns that off)
  adtplus navigate outline --system <id> --name <n> --type <t>
  adtplus quality syntax --system <id> --name <n> --type <t> [--source '<text>' [--include <i>]]
      (with --source: checks the given text as the main source or class include instead of the stored one; nothing is saved)
  adtplus quality format --system <id> --name <n> --type <t> [--source '<text>']
      (the stored source, or the given text, formatted with the system's format.engine; layout only, nothing is saved)
  adtplus quality atc|atc-variants|abaplint --system <id> --name <n> --type <t> [...]
      (atc --quickfixes: through SAP's worklist, findings say which have a quick fix, no line numbers)
  adtplus quality syntax|atc|abaplint --system <id> (--refs '[{"name":"ZCL_X","objectType":"CLAS/OC"}]' | --package <pkg> [--subpackages])
      (several objects, at most 50, in one call: one summary with counts and findings, errors first)
  adtplus quality abaplint | mirror check ... [--rules '{"abapdoc":true,"check_subrc":false}']
      (abaplint rule switches on top of the default: syntax errors SAP would refuse, and likely bugs)
  adtplus test --system <id> --name <n> --type <t> [--coverage]
      (ABAP Unit; the object's package must be in the write allowlist)
  adtplus run --system <id> --name <n> --type <t> --confirm
  adtplus data --system <id> --statement '<SELECT …>' [--max-rows <n, default 100, max 1000>]
      (one ABAP SQL SELECT without INTO, through ADT's data preview; only on systems with allowDataPreview: true;
       a statement reading another client is refused. totalRows is SAP's full count, truncatedRows says rows were left out)
  adtplus runtime dumps --system <id> [--user <u>|'*'] [--from <time>] [--to <time>] [--max <n, default 20, max 100>]
  adtplus runtime dump --system <id> --id <id> [--chapters 'Selected Variables,kap9']
  adtplus runtime gateway-errors --system <id> [--user <u>|'*'] [--from <time>] [--to <time>] [--max <n>]
  adtplus runtime gateway-error --system <id> --id <id> [--sections 'STACK,Error Context']
      (runtime logs, only on systems with allowRuntimeLogs: true: ABAP runtime errors (short dumps, ST22) and the
       gateway error log; lists show your own by default, metadata only; dump returns the developer chapters,
       others by name or title; gateway-error its sections as text)
  adtplus mirror init --system <id> --package <pkg> [--no-subpackages] [--root <folder>]
  adtplus mirror pull --system <id> [--max-objects <n>] [--root <folder>]
  adtplus mirror status [--root <folder>]
      (a package as AFF files in <root>/src, default root: here; pull reads the system, writes only local
       files, keeps local changes and puts the system's version of a file changed on both sides in
       <file>.remote; run it again to finish a stopped pull. status is local: changes against the last pull)
  adtplus mirror check --system <id> [--root <folder>]
  adtplus mirror new --system <id> --type <CLAS|INTF|PROG|DDLS|DCLS|DDLX|BDEF|SRVD|SRVB|TABL|MSAG> --name <name> [--package <pkg>] [--description <text>] [--root <folder>]
      (local, no SAP call. check: abaplint, AFF schemas and .editorconfig over the files, exit code 1 on
       errors; new: skeleton files for an object a push will create, a BDEF named after its root entity)
  adtplus mirror push --system <id> [--dry-run] [--no-activate] [--transport <request>] [--max-objects <n>] [--root <folder>]
  adtplus mirror activate --system <id> [--root <folder>]
      (push writes the locally changed objects that exist on the system, each through the write
       allowlist and only if the system still has what was last pulled, creates new objects in the
       package their folder names (in --transport for a transportable package), then activates them;
       exit code 1 if anything is left undone. activate activates what a push wrote but didn't activate)`;

async function main(): Promise<void> {
  const [tool, action, ...rest] = process.argv.slice(2);

  if (!tool) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (tool === 'config') {
    await runConfig(action, parseFlags(rest));
    return;
  }

  if (tool === 'system' && (action === 'status' || action === 'connect')) {
    const flags = parseFlags(rest);
    const json = flags.json !== undefined;
    if (action === 'connect') {
      const system = requireStr(flags, 'system');
      const res = await sendCommand<ConnectResponse | ErrorResponse>({ cmd: 'system.connect', system }, { client: 'cli' });
      if (!res.ok) {
        // A failed logon has no `session`; print the error, not `undefined`.
        console.log(json ? JSON.stringify(res, null, 2) : `${system}: ${res.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(json ? JSON.stringify(res, null, 2) : JSON.stringify(res.session));
      if (!json) for (const warning of res.warnings ?? []) console.error(`⚠ ${warning}`);
      return;
    }
    const res = await sendCommand<StatusResponse>({ cmd: 'system.status' }, { client: 'cli' });
    printStatus(res, json);
    return;
  }

  // The tools without an action: `adtplus run|test|data --system …` (ADR-018).
  if (tool === 'run' || tool === 'test' || tool === 'data') {
    const flags = parseFlags([action, ...rest].filter((v): v is string => v !== undefined));
    const json = flags.json !== undefined;
    const req = buildRequest(tool, '', flags);
    const res = await sendCommand<DaemonResponse>(req, { client: 'cli' });
    console.log(json || !res.ok ? JSON.stringify(res, null, 2) : JSON.stringify((res as { result: unknown }).result));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (tool === 'mirror') {
    const flags = parseFlags(rest);
    const req = buildMirrorRequest(action, flags, process.cwd());
    const res = await sendCommand<DaemonResponse>(req, { client: 'cli' });
    const result = res.ok ? (res as { result: unknown }).result : undefined;
    console.log(JSON.stringify(res.ok ? result : res, null, 2));
    // A check that found errors, or a push that left something undone, fails like a command that failed.
    const failed =
      (req.cmd === 'mirror.check' && (result as { ok?: boolean }).ok === false) ||
      ((req.cmd === 'mirror.push' || req.cmd === 'mirror.activate') && (result as { complete?: boolean }).complete === false);
    if (!res.ok || failed) process.exitCode = 1;
    return;
  }

  if (!action) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const flags = parseFlags(rest);
  const json = flags.json !== undefined;
  const req = buildRequest(tool, action, flags);
  const res = await sendCommand<DaemonResponse>(req, { client: 'cli' });
  console.log(json || !res.ok ? JSON.stringify(res, null, 2) : JSON.stringify((res as { result: unknown }).result));
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
