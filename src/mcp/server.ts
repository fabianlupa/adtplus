import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import path from 'node:path';
import { sendCommand } from '../daemon/client.js';
import { isDenied, parseDenyList } from '../daemon/deny.js';
import { isReadOnlyEnv } from '../daemon/readonly.js';
import { gatedSystemsFor, projectConfigSetsFromRoots, workspaceFoldersFromRoots } from './roots.js';
import type {
  CheckTargets,
  ConnectResponse,
  DaemonRequest,
  DaemonResponse,
  StatusResponse,
} from '../daemon/protocol.js';

/** Models pass workspace folder names here and infer the system from the open editor. */
const SYSTEM_DESC =
  'adt+ system id as configured in systems.json or a project config — list them with adtplus_system. Never a workspace folder or destination label. If the user has not said which system, ask; do not infer it from the open editor.';

/** `actions` minus the ones `deny` refuses; `prefix` turns an action into its daemon command (`object` + `delete`). */
function allowedActions<A extends string>(deny: string[], prefix: string | undefined, actions: readonly A[]): A[] {
  return actions.filter((a) => !isDenied(prefix ? `${prefix}.${a}` : a, deny));
}

/** Like `allowedActions`, but each action maps to its own daemon command — `adtplus_irreversible`'s actions span three prefixes. */
function allowedActionsFromMap<A extends string>(deny: string[], map: Record<A, string>): A[] {
  return (Object.keys(map) as A[]).filter((a) => !isDenied(map[a], deny));
}

/** The `action` enum over the allowed actions, keeping `fallback` as default only while it is allowed. */
function actionSchema<A extends string>(actions: A[], fallback?: A) {
  const schema = z.enum(actions as [A, ...A[]]);
  return fallback !== undefined && actions.includes(fallback) ? schema.default(fallback) : schema;
}

function errorResult(text: string): { isError: true; content: [{ type: 'text'; text: string }] } {
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * Which project configs a request carries: one list per workspace folder, or
 * undefined for the client default. Rejects while the folders of a client that
 * offers roots are unknown, so no call runs on the user config by accident.
 */
type ProjectScope = () => Promise<string[][] | undefined>;

async function callDaemonIn(
  scope: ProjectScope,
  req: DaemonRequest,
): Promise<{ content: [{ type: 'text'; text: string }] } | ReturnType<typeof errorResult>> {
  let projectConfigSets: string[][] | undefined;
  try {
    projectConfigSets = await scope();
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
  const res = await sendCommand<DaemonResponse>(req, { client: 'mcp', projectConfigSets });
  return { content: [{ type: 'text', text: JSON.stringify(res) }] };
}

/** `adtplus_run`'s input schema: `system` offers only the systems that allow run. */
function runInputSchema(runSystems: string[]) {
  return {
    system: z
      .enum(runSystems as [string, ...string[]])
      .describe('adt+ system id; only systems with allowRun: true (systems.json or a project config) are listed.'),
    ...refSchema,
    confirm: z.boolean().optional(),
  };
}

/** How each server's `adtplus_run` follows a change of its run systems (see `setRunSystems`). */
const runSystemUpdaters = new WeakMap<McpServer, (systems: string[]) => void>();

/**
 * Point `adtplus_run` at these systems: hidden when there are none, else
 * offering exactly them. The SDK tells the client (tools/list_changed).
 */
export function setRunSystems(server: McpServer, systems: string[]): void {
  runSystemUpdaters.get(server)?.(systems);
}

/** How each server's `adtplus_runtime` follows a change of its dump systems (see `setRuntimeSystems`). */
const runtimeSystemUpdaters = new WeakMap<McpServer, (systems: string[]) => void>();

/** Point `adtplus_runtime` at these systems: hidden when there are none, else offering exactly them. */
export function setRuntimeSystems(server: McpServer, systems: string[]): void {
  runtimeSystemUpdaters.get(server)?.(systems);
}

const RUNTIME_ACTION_NAMES = ['dumps', 'dump', 'gatewayErrors', 'gatewayError'] as const;
type RuntimeAction = (typeof RUNTIME_ACTION_NAMES)[number];

/** `adtplus_runtime`'s input schema: `system` offers only the systems that allow runtime logs (ADR-015). */
function runtimeInputSchema(actions: RuntimeAction[], runtimeSystems: string[]) {
  return {
    action: actionSchema(actions, 'dumps'),
    system: z
      .enum(runtimeSystems as [string, ...string[]])
      .describe('adt+ system id; only systems with allowRuntimeLogs: true (systems.json or a project config) are listed.'),
    user: z
      .string()
      .optional()
      .describe('dumps, gatewayErrors: whose. Default: the logged-on user\'s own. An SAP user name, or "*" for everyone\'s.'),
    from: z.string().optional().describe('dumps, gatewayErrors: oldest entry time, e.g. "2026-10-12T08:00:00Z" or "2026-10-12" (UTC).'),
    to: z
      .string()
      .optional()
      .describe(
        'dumps, gatewayErrors: newest entry time, same forms. To reach older entries set it to the oldest time seen: ' +
          'that second is included, so its entries come again; if a whole page shares one second, raise maxResults.',
      ),
    maxResults: z.number().int().min(1).max(100).optional().describe('dumps, gatewayErrors: entries to return, default 20, at most 100.'),
    id: z.string().optional().describe('dump, gatewayError: the `id` of an entry from `dumps` or `gatewayErrors`.'),
    sections: z
      .array(z.string())
      .optional()
      .describe('gatewayError: sections to return instead of all, by name or title from `otherSections`, e.g. ["STACK"].'),
    chapters: z
      .array(z.string())
      .optional()
      .describe(
        'dump: chapters to return instead of the developer chapters, by name or title from `otherChapters`, ' +
          'e.g. ["Selected Variables"]. Only when the default chapters don\'t explain the error: variables hold program data.',
      ),
  };
}

/** `adtplus_data`'s input schema: `system` offers only the systems that allow data preview. */
function dataInputSchema(dataSystems: string[]) {
  return {
    system: z
      .enum(dataSystems as [string, ...string[]])
      .describe('adt+ system id; only systems with allowDataPreview: true (systems.json or a project config) are listed.'),
    statement: z
      .string()
      .describe(
        "One ABAP SQL SELECT without INTO, strict syntax: SELECT carrid, connid FROM spfli WHERE carrid = 'LH' ORDER BY connid. " +
          'Tables, DDIC and CDS views (with parameters: FROM zview( p_x = \'A\' )), joins, aggregates, UNION. Nothing else runs.',
      ),
    maxRows: z.number().int().min(1).max(1000).optional().describe('Rows to return, default 100, at most 1000.'),
  };
}

/** How each server's `adtplus_data` follows a change of its data systems (see `setDataSystems`). */
const dataSystemUpdaters = new WeakMap<McpServer, (systems: string[]) => void>();

/** Point `adtplus_data` at these systems: hidden when there are none, else offering exactly them. */
export function setDataSystems(server: McpServer, systems: string[]): void {
  dataSystemUpdaters.get(server)?.(systems);
}

const refSchema = {
  name: z.string().describe('Object name, e.g. ZCL_ORDER'),
  objectType: z.string().describe('ADT type code, e.g. CLAS/OC, DDLS/DF'),
};

// Not every action needs a ref (adtplus_transport "list", adtplus_object
// "listInactive"), so those tools take it optional and validate presence per
// action instead of via the schema.
const optionalRefSchema = {
  name: z.string().optional().describe('Object name, e.g. ZCL_ORDER. Required by most actions.'),
  objectType: z.string().optional().describe('ADT type code, e.g. CLAS/OC. Required by most actions.'),
};

/** A check over several objects (`CheckTargets`): `refs` or a `package` instead of `name` + `objectType`. */
const batchSchema = (actions: string) => ({
  refs: z
    .array(z.object(refSchema))
    .optional()
    .describe(
      `${actions}: several objects in one call, at most 50, instead of name + objectType. The answer is one ` +
        'summary: counts per severity, findings (errors first, at most 100) with object, file and line, and the ' +
        'objects whose check failed.',
    ),
  package: z
    .string()
    .optional()
    .describe(`${actions}: check the package's objects (at most 50) instead of name + objectType or refs.`),
  subpackages: z.boolean().optional().describe('With package: include its subpackages. Default false.'),
});

/**
 * A check's target, as the daemon expects it, or why there is none. Every target given is passed
 * on, so the daemon refuses more than one; half a ref is refused here rather than dropped.
 */
function checkTarget(
  name: string | undefined,
  objectType: string | undefined,
  refs: Array<{ name: string; objectType: string }> | undefined,
  pkg: string | undefined,
  subpackages: boolean | undefined,
): CheckTargets | string {
  if (!name !== !objectType) return 'give "name" and "objectType" together';
  return {
    ref: name && objectType ? { name, objectType } : undefined,
    refs: refs?.length ? refs : undefined,
    package: pkg || undefined,
    subpackages,
  };
}

/** read-only annotations: the six `adtplus_*` read tools. */
const READ_ANNOTATIONS = (openWorldHint: boolean): ToolAnnotations => ({ readOnlyHint: true, openWorldHint });

/**
 * Builds the 14-tool adt+ surface (docs/decisions/018-names-and-grouping.md): one risk tier per tool, so
 * a client's per-tool approval ("always allow") grants exactly one tier.
 *
 * `deny`, `readOnly` and `runSystems` are explicit (not read from `process.env`
 * or systems.json here) so tests can build several servers with different
 * policies in one process; `main()` below is the only caller that reads them.
 * `runSystems` are the systems with `allowRun: true` (ADR-005): `adtplus_run`
 * is registered only when there is one, and takes only those.
 */
export function createMcpServer(
  opts: {
    deny?: string[];
    readOnly?: boolean;
    runSystems?: string[];
    dataSystems?: string[];
    runtimeSystems?: string[];
    scope?: ProjectScope;
    /** The client's local workspace folders (MCP roots); undefined: ADTPLUS_PROJECT, else the working folder. */
    folders?: () => Promise<string[] | undefined>;
  } = {},
): McpServer {
  const deny = opts.deny ?? [];
  const readOnlyEnv = opts.readOnly ?? false;
  const runSystems = opts.runSystems ?? [];
  const dataSystems = opts.dataSystems ?? [];
  const runtimeSystems = opts.runtimeSystems ?? [];
  const scope = opts.scope ?? (async () => undefined);
  const folders = opts.folders ?? (async () => undefined);
  const callDaemon = (req: DaemonRequest) => callDaemonIn(scope, req);
  /**
   * Every mirror root this session's mirror calls named, for the process lifetime: the daemon
   * refuses an in-system `update` on an object one of them holds (ADR-009).
   */
  const mirrorRoots = new Set<string>();
  const scopeOrError = async (): Promise<{ value: string[][] | undefined } | { error: string }> => {
    try {
      return { value: await scope() };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  const server = new McpServer({ name: 'adtplus', version: '0.1.0' });

  /**
   * A call the daemon checks against the mirrors this session used (ADR-009: a write it refuses, a read
   * it notes): sent with the mirror roots and the folders they were resolved against.
   */
  async function callWithMirrorRoots(
    req: Extract<
      DaemonRequest,
      { cmd: 'object.read' | 'object.update' | 'object.deleteMessages' | 'object.applyQuickfixes' }
    >,
  ) {
    if (mirrorRoots.size === 0) return callDaemon(req);
    try {
      // The folders the mirror calls were resolved against, so the daemon finds the same roots inside them.
      const workspaceFolders = (await folders()) ?? [process.env.ADTPLUS_PROJECT?.trim() || process.cwd()];
      return callDaemon({ ...req, mirrorRoots: [...mirrorRoots], workspaceFolders });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  /** A write/execute tier's actions: none of them while ADTPLUS_READONLY is on, else the usual deny filter. */
  function writeActions<A extends string>(prefix: string | undefined, actions: readonly A[]): A[] {
    return readOnlyEnv ? [] : allowedActions(deny, prefix, actions);
  }

  const SYSTEM_ACTIONS = allowedActions(deny, 'system', ['status', 'connect', 'messages'] as const);
  const TRANSPORT_ACTIONS = allowedActions(deny, 'transport', ['list', 'find', 'check', 'read', 'diff'] as const);
  const TRANSPORT_WRITE_ACTIONS = writeActions('transport', ['create', 'assign'] as const);
  const OBJECT_ACTIONS = allowedActions(deny, 'object', [
    'search',
    'resolve',
    'read',
    'translations',
    'versions',
    'diff',
    'list',
    'listInactive',
    'lockStatus',
    'validate',
    'generators',
    'generatorSchema',
    'serviceInfo',
  ] as const);
  const OBJECT_WRITE_ACTIONS = writeActions('object', [
    'create',
    'update',
    'activate',
    'publish',
    'unpublish',
    'generate',
    'applyQuickfixes',
  ] as const);
  const NAVIGATE_ACTIONS = allowedActions(deny, 'navigate', [
    'whereUsed',
    'definition',
    'declaration',
    'hover',
    'outline',
    'typeHierarchy',
  ] as const);
  const QUALITY_ACTIONS = allowedActions(deny, 'quality', ['syntax', 'format', 'atc', 'atcVariants', 'abaplint'] as const);
  // Reads the system and writes only local files: offered in read-only mode too (ADR-007).
  const MIRROR_ACTIONS = allowedActions(deny, 'mirror', ['init', 'pull', 'status', 'check', 'new'] as const);
  const MIRROR_WRITE_ACTIONS = writeActions('mirror', ['push', 'activate'] as const);

  const IRREVERSIBLE_CMD = {
    deleteObject: 'object.delete',
    deleteMessages: 'object.deleteMessages',
    releaseTransport: 'transport.release',
  } as const satisfies Record<string, DaemonRequest['cmd']>;
  const IRREVERSIBLE_ACTIONS = readOnlyEnv ? [] : allowedActionsFromMap(deny, IRREVERSIBLE_CMD);

  const TEST_ALLOWED = !readOnlyEnv && !isDenied('test.unit', deny);
  /** Whether `adtplus_run` can exist at all; it is shown only while some system allows run. */
  const RUN_POSSIBLE = !readOnlyEnv && !isDenied('run.application', deny);
  /** Whether `adtplus_data` can exist at all; it only reads, so read-only mode keeps it (ADR-013). */
  const DATA_POSSIBLE = !isDenied('data.query', deny);
  /** `adtplus_runtime`'s actions; it only reads, so read-only mode keeps it (ADR-015). */
  const RUNTIME_ACTIONS = allowedActions(deny, 'runtime', RUNTIME_ACTION_NAMES);

  if (SYSTEM_ACTIONS.length > 0) server.registerTool(
    'adtplus_system',
    {
      title: 'adt+ system',
      description:
        'The SAP systems adt+ knows and their sessions. `status` (default) is a cheap read of ' +
        'cached session state and never opens a new SAP session. `connect` establishes or ' +
        'reuses one session for `system`, which may open a browser SSO window (interactive ' +
        'systems) — pass it only when you actually need a live session. `messages`: the system messages ' +
        'administrators broadcast (SM02), e.g. a maintenance window; check them before long work. A `warnings` entry ' +
        '(e.g. an unverified adt-ls version) is for the user: tell them before writing.',
      inputSchema: {
        action: actionSchema(SYSTEM_ACTIONS, 'status'),
        system: z.string().optional().describe('Required for "connect" and "messages".'),
      },
      annotations: READ_ANNOTATIONS(true),
    },
    async ({ action, system }) => {
      if (action === 'connect' || action === 'messages') {
        if (!system) return errorResult(`action "${action}" requires "system"`);
        if (action === 'messages') return callDaemon({ cmd: 'system.messages', system });
        const sets = await scopeOrError();
        if ('error' in sets) return errorResult(sets.error);
        const res = await sendCommand<ConnectResponse>({ cmd: 'system.connect', system }, { client: 'mcp', projectConfigSets: sets.value });
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      }
      const sets = await scopeOrError();
      if ('error' in sets) return errorResult(sets.error);
      const res = await sendCommand<StatusResponse>({ cmd: 'system.status' }, { client: 'mcp', projectConfigSets: sets.value });
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    },
  );

  if (TRANSPORT_ACTIONS.length > 0) server.registerTool(
    'adtplus_transport',
    {
      title: 'adt+ transport',
      description:
        'CTS transport requests: list your modifiable transports, or find/check candidates for an ' +
        'object; read any request or task (header, tasks, objects) or diff what it changes. Creating a ' +
        'request or assigning one to an object is `adtplus_transport_write`; releasing one is ' +
        '`adtplus_irreversible`.',
      inputSchema: {
        action: actionSchema(TRANSPORT_ACTIONS),
        system: z.string().describe(SYSTEM_DESC),
        query: z.string().optional().describe('list: filter text.'),
        maxResults: z.number().optional().describe('list: max results.'),
        ...optionalRefSchema,
        package: z.string().optional().describe('find: the object\'s package.'),
        isCreation: z.boolean().optional().describe('find: true if the object doesn\'t exist yet; default false.'),
        operation: z.enum(['CREATE', 'MODIFY', 'DELETE']).optional().describe('check: default MODIFY.'),
        transport: z.string().optional().describe('read, diff: the request or task number, any owner, open or released.'),
        cursor: z
          .string()
          .optional()
          .describe(
            'diff: `nextCursor` of the previous page. Each page has up to 40 objects of adt-ls\'s diff (the draft ' +
              'for an open request); the first also has `supplement`: diffs of what adt-ls leaves out (a whole ' +
              'class\'s other includes, a function group\'s other parts, objects that no longer exist).',
          ),
      },
      annotations: READ_ANNOTATIONS(false),
    },
    async ({ action, system, query, maxResults, name, objectType, package: pkg, isCreation, operation, transport, cursor }) => {
      switch (action) {
        case 'list':
          return callDaemon({ cmd: 'transport.list', system, query, maxResults });
        case 'find':
          if (!name || !objectType || !pkg) {
            return errorResult('action "find" requires "name", "objectType", "package"');
          }
          return callDaemon({ cmd: 'transport.find', system, ref: { name, objectType }, package: pkg, isCreation: isCreation ?? false });
        case 'check':
          if (!name || !objectType) return errorResult('action "check" requires "name", "objectType"');
          return callDaemon({ cmd: 'transport.check', system, ref: { name, objectType }, operation });
        case 'read':
          if (!transport) return errorResult('action "read" requires "transport"');
          return callDaemon({ cmd: 'transport.read', system, transport });
        case 'diff':
          if (!transport) return errorResult('action "diff" requires "transport"');
          return callDaemon({ cmd: 'transport.diff', system, transport, cursor });
      }
    },
  );

  if (TRANSPORT_WRITE_ACTIONS.length > 0) server.registerTool(
    'adtplus_transport_write',
    {
      title: 'adt+ transport (write)',
      description:
        'Create a CTS transport request, or assign an existing one to an object. To find/check a ' +
        'candidate first, or to list your transports, use `adtplus_transport`. Releasing a transport ' +
        'is `adtplus_irreversible`.',
      inputSchema: {
        action: actionSchema(TRANSPORT_WRITE_ACTIONS),
        system: z.string().describe(SYSTEM_DESC),
        ...refSchema,
        package: z.string().optional().describe('create: the object\'s package.'),
        isCreation: z.boolean().optional().describe('create: true if the object doesn\'t exist yet.'),
        transportDescription: z.string().optional().describe('create: description for the new request.'),
        transport: z
          .string()
          .optional()
          .describe(
            'assign: the request or task number. For an object already in a request, success is read back from ' +
              'SAP\'s lock and `lockedIn` names the request. For an object in no open request the result is ' +
              '`assigned: "onNextWrite"`: its next write through adt+ records it there (a transport check before ' +
              'that write cancels it).',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ action, system, name, objectType, package: pkg, isCreation, transportDescription, transport }) => {
      switch (action) {
        case 'create':
          if (!pkg || isCreation === undefined || !transportDescription) {
            return errorResult('action "create" requires "name", "objectType", "package", "isCreation", "transportDescription"');
          }
          return callDaemon({ cmd: 'transport.create', system, ref: { name, objectType }, package: pkg, transportDescription, isCreation });
        case 'assign':
          if (!transport) return errorResult('action "assign" requires "transport"');
          return callDaemon({ cmd: 'transport.assign', system, ref: { name, objectType }, transport });
      }
    },
  );

  if (OBJECT_ACTIONS.length > 0) server.registerTool(
    'adtplus_object',
    {
      title: 'adt+ object',
      description:
        'Find and open ABAP objects on a SAP system by name — no local file or workspace path ' +
        'needed. Use `search` to "find the object named ZCL_*" or "find classes matching X" ' +
        '(pattern with * wildcards, capped at `maxResults`, default 25, max 100; result has ' +
        '`truncated`); every hit carries the `abap:` URI to open. Use `resolve` to "open class ' +
        'ZCL_ORDER by name" — it returns the `abap:` URI for one exact name + type. Use `list` for ' +
        '"what\'s in package X" — package contents; pass `depth` 3 to get the whole package in ONE call ' +
        'instead of one call per folder. Use `read` for an object\'s source by name + type, without any ' +
        '`abap:` file system: the whole text (verbatim, ready for `adtplus_object_write update`), or only ' +
        '`method`, `grep` hits with line numbers, or `fromLine`/`toLine`; a class\'s main source also lists its ' +
        'other `includes`. `served` says whether the text is your inactive draft; `version: "active"` reads ' +
        'what is active. Use `versions` for "who changed this / what did it look like before": the released versions ' +
        '(number, request, author, time; a class\'s includes each have their own), then `read` with `version` set to a ' +
        'number to read that state, or `diff` for what changed between two of them (default: the current state against ' +
        'the last released version; `version` and `baseVersion` take a number, "active" or "inactive"). A package (DEVC/K), ' +
        'a domain (DOMA/DD), a data element (DTEL/DE) or a message class (MSAG/N) has no source: `read` returns its ' +
        '`properties`, its AFF JSON (a domain\'s or data element\'s inactive version when it has one, `version` says which; a message class\'s ' +
        'messages filtered by `grep`), the shape `adtplus_object_write update` takes. Translations (experimental), as in SAP\'s app ' +
        '"Maintain Translations" (only on systems with allowTranslations: true): `translations` gives the texts of an object ' +
        'or a package (DEVC/K) in every translation project that covers it, per language pair, each with its `status` ' +
        '(translated, missing, outdated, empty); narrow with `language` (target, BCP 47 such as "de"), `translationStatus`, ' +
        '`grep`, page with `maxResults` and `cursor` (= the `nextCursor` of the page before). `read` on a translation ' +
        'project (TRPR) gives its text sources and language pairs; add `translationStatus` for its texts and the counts ' +
        'per status (`maxResults: 0`: the counts only). `validate` is SAP\'s check of a ' +
        'package create (`name`, `package` = the superpackage, `description`, `properties`) without creating anything. ' +
        'IMPORTANT: glob, file search and ' +
        'workspace text search CANNOT reach `abap:` URIs and will find nothing — use `search`/`resolve` ' +
        'instead, then read or edit the returned URI, or use `read`. Also: `listInactive`, `lockStatus`. ' +
        'RAP generators (a full RAP service from a table: CDS views, BDEF, behaviour pool, draft table, service ' +
        'definition and binding): `generators` lists them (use the `title` with the user), `generatorSchema` gives ' +
        'one generator\'s input schema and its proposed `content` for `package` and `referencedObject`; ' +
        'show the proposed names to the user, then run it with `adtplus_object_write generate`. `serviceInfo` reads a ' +
        'service binding (SRVB): its OData services, and once published its URL and entity sets. Creating, ' +
        'editing, activating or publishing an object is `adtplus_object_write`; deleting one is ' +
        '`adtplus_irreversible`.',
      inputSchema: {
        action: actionSchema(OBJECT_ACTIONS),
        system: z.string().describe(SYSTEM_DESC),
        ...optionalRefSchema,
        query: z.string().optional().describe('search: name pattern with * wildcards, e.g. ZCL_ORDER*.'),
        maxResults: z
          .number()
          .optional()
          .describe(
            'search: cap on hits, default 25, max 100. versions: cap on versions, default 50, max 500. translations, read of a TRPR: ' +
              'cap on texts, default 100, max 500. Check `truncated` in the result.',
          ),
        language: z.string().optional().describe('translations, read of a TRPR: only the language pairs with this target language, a BCP 47 tag such as "de", "fr", "zh-Hant".'),
        translationStatus: z
          .array(z.enum(['translated', 'missing', 'outdated', 'empty']))
          .optional()
          .describe('translations: only texts with these statuses (default: all). read of a TRPR: read its texts too, those with these statuses.'),
        cursor: z.string().optional().describe('translations, read of a TRPR: the `nextCursor` of the page before, for the next page.'),
        path: z
          .array(z.string())
          .optional()
          .describe('list: localized folder names below the package, from a previous list. Omit for the top level.'),
        depth: z
          .number()
          .optional()
          .describe(
            'list: directory levels to read, default 1, max 10. SAP nests objects under localized ' +
              'category folders (package → category → type → object), so depth 1 shows only folder ' +
              'names; use 3 to list a package\'s objects in one call, 4 to also get their source files. ' +
              'Each entry then carries `path`; `truncated` says directories were left unread, which is ' +
              'normal at depth 3 because an object is itself a folder.',
          ),
        maxRequests: z
          .number()
          .optional()
          .describe('list: cap on directory reads, default 50, max 200. Stops a deep package running away.'),
        package: z
          .string()
          .optional()
          .describe('list: the package to list. generatorSchema: the package to generate into. validate: the superpackage (must be allowlisted).'),
        description: z.string().optional().describe('validate: required, the package description.'),
        properties: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('validate: the package\'s other fields as AFF devc-v1, e.g. {"generalInformation": {"softwareComponent": "HOME"}}.'),
        transport: z.string().optional().describe('validate: only to preview a package that would record changes.'),
        generatorId: z.string().optional().describe('generatorSchema: the `id` from `generators`.'),
        referencedObject: z
          .object(refSchema)
          .optional()
          .describe('generatorSchema: the object the generator starts from, as `generators` names its type, e.g. a table (TABL/DT).'),
        service: z.string().optional().describe('serviceInfo: which of the binding\'s services; default its first.'),
        include: z
          .string()
          .optional()
          .describe(
            'read, classes only: "definitions" (local types), "implementations" (local classes), "macros", ' +
              '"testclasses". Omit for the main source. versions: only that include\'s; omit for all of the class\'s. diff: the include to compare.',
          ),
        version: z
          .string()
          .regex(/^(inactive|active|\d{5})$/, 'version: "inactive", "active" or a version number such as "00003"')
          .optional()
          .describe(
            'read: "inactive" (default) is what the system serves you, your draft if you have one; "active" is the activated ' +
              'version; a number from `versions` (e.g. "00003") is that released version. diff: the newer side, default "inactive".',
          ),
        baseVersion: z
          .string()
          .regex(/^(inactive|active|\d{5})$/, 'baseVersion: "inactive", "active" or a version number such as "00003"')
          .optional()
          .describe('diff: the older side; default the numbered version before `version`.'),
        method: z
          .string()
          .optional()
          .describe('read: only METHOD <method> … ENDMETHOD, e.g. "calc_price" or "zif_x~calc_price"; local classes\' methods are in include "implementations".'),
        grep: z
          .string()
          .optional()
          .describe(
            'read: only lines matching this regex (case-insensitive), with `context` lines around each; a message class: only the messages whose "<number> <text>" matches. ' +
              'translations, read of a TRPR: only texts whose "<objectType> <name> <key> <source> <target>" matches.',
          ),
        context: z.number().optional().describe('read with grep: lines of context, default 2. diff: unchanged lines around each change, default 3.'),
        fromLine: z.number().optional().describe('read: first line, 1-based.'),
        toLine: z.number().optional().describe('read: last line, inclusive.'),
        maxLines: z.number().optional().describe('read, diff: cap on the lines returned (no cap by default); `truncated` says it cut.'),
      },
      annotations: READ_ANNOTATIONS(false),
    },
    async ({ action, system, name, objectType, query, maxResults, language, translationStatus, cursor, path, depth, maxRequests, package: pkg, description, properties, transport, generatorId, referencedObject, service, include, version, baseVersion, method, grep, context, fromLine, toLine, maxLines }) => {
      switch (action) {
        case 'validate':
          if (!name || !objectType || !pkg || description === undefined) {
            return errorResult('action "validate" requires "name", "objectType", "package" (the superpackage), "description"');
          }
          return callDaemon({ cmd: 'object.validate', system, ref: { name, objectType }, package: pkg, description, properties, transport });
        case 'generators':
          return callDaemon({ cmd: 'object.generators', system });
        case 'generatorSchema':
          if (!generatorId || !pkg) return errorResult('action "generatorSchema" requires "generatorId", "package"');
          return callDaemon({ cmd: 'object.generatorSchema', system, generatorId, package: pkg, referencedObject });
        case 'serviceInfo':
          if (!name || !objectType) return errorResult('action "serviceInfo" requires "name", "objectType" (a service binding, SRVB/SVB)');
          return callDaemon({ cmd: 'object.serviceInfo', system, ref: { name, objectType }, service });
        case 'read': {
          if (!name || !objectType) return errorResult('action "read" requires "name", "objectType"');
          return callWithMirrorRoots({
            cmd: 'object.read',
            system,
            ref: { name, objectType },
            include,
            version,
            method,
            grep,
            context,
            fromLine,
            toLine,
            maxLines,
            language,
            translationStatus,
            cursor,
            // `maxResults` caps a translation project's texts only; a source read has `maxLines`.
            ...(objectType.toUpperCase().startsWith('TRPR') ? { maxResults } : {}),
          });
        }
        case 'translations':
          if (!name || !objectType) return errorResult('action "translations" requires "name", "objectType" (an object, or a package as DEVC/K)');
          return callDaemon({ cmd: 'object.translations', system, ref: { name, objectType }, language, translationStatus, grep, maxResults, cursor });
        case 'versions':
          if (!name || !objectType) return errorResult('action "versions" requires "name", "objectType"');
          return callDaemon({ cmd: 'object.versions', system, ref: { name, objectType }, include, maxResults });
        case 'diff':
          if (!name || !objectType) return errorResult('action "diff" requires "name", "objectType"');
          return callDaemon({ cmd: 'object.diff', system, ref: { name, objectType }, include, version, baseVersion, context, maxLines });
        case 'listInactive':
          return callDaemon({ cmd: 'object.listInactive', system });
        case 'lockStatus':
          if (!name || !objectType) return errorResult('action "lockStatus" requires "name", "objectType"');
          return callDaemon({ cmd: 'object.lockStatus', system, ref: { name, objectType } });
        case 'resolve':
          if (!name || !objectType) return errorResult('action "resolve" requires "name", "objectType"');
          return callDaemon({ cmd: 'object.resolve', system, ref: { name, objectType } });
        case 'search':
          if (!query) return errorResult('action "search" requires "query"');
          return callDaemon({ cmd: 'object.search', system, query, objectType, maxResults });
        case 'list':
          if (!pkg) return errorResult('action "list" requires "package"');
          return callDaemon({ cmd: 'object.list', system, package: pkg, path, depth, maxRequests });
      }
    },
  );

  if (OBJECT_WRITE_ACTIONS.length > 0) server.registerTool(
    'adtplus_object_write',
    {
      title: 'adt+ object (write)',
      description:
        'Create, change, activate or publish an ABAP object — no local file or workspace path needed; ' +
        'find it first with `adtplus_object search`/`resolve`. Batch `activate` with diagnostics. Every write is ' +
        'refused unless the object\'s package is in the system\'s write allowlist (a package: its superpackage); ' +
        'the refusal names the package — report it, do not retry. `update` takes `source` for a source-based object, ' +
        'or `properties` for a package (DEVC/K), a domain (DOMA/DD), a data element (DTEL/DE) or a message class (MSAG/N): ' +
        'their AFF JSON as ' +
        '`adtplus_object read` returns it, merged by key, so send only what changes; leaving something out keeps it, never ' +
        'deletes it, except a domain\'s `fixedValues` and `fixedValueIntervals`: a list sent is the new list. A domain: ' +
        '`create` takes `properties` with at least `format` (`dataType`, `length`), writes the inactive version (also ' +
        '`update`), and `activate` activates it; its texts are in its original language. A data element likewise: ' +
        '`create` takes `properties` with at least `dataTypeInformation` (`category`, and `typeName` or, for a predefined ' +
        'type, `predefinedType`); a `fieldLabels` length not given is the label\'s maximum. ' +
        '`update` with `source` is refused on an object a mirror this session used holds (`adtplus_mirror`): edit its ' +
        'files there and push. A message class: `create` makes one (`properties.messages` adds messages at once), ' +
        '`update` adds or changes `messages` (each with its number: adt+ picks none); a changed description is ' +
        'refused (SAP records it wrongly), the self-explanatory flag and long texts stay as they are, and there is no ' +
        'inactive version: a write is live at once. A package: `create` makes a development package directly under ' +
        '`package` with the system\'s ABAP language version (preview it with `adtplus_object validate`); `update` ' +
        'changes `header.description` and `generalInformation.applicationComponent`. A translation project (TRPR, SAP\'s ' +
        '"Maintain Translations", only with allowTranslations: true): `update` with `properties.translations` writes texts ' +
        '(uploads and publishes them per language pair, into the project\'s request): entries as `adtplus_object read` ' +
        'of the TRPR with `translationStatus` (or `translations`) returns them, `target` filled in; `source` and `status` sent ' +
        'along must still be current, else the entry is refused. Every translated object\'s package must be allowlisted too. ' +
        '`create` makes one in `package` (`properties.textSources`, e.g. {"objectType": "MSAG/N", "name": "ZX"} or a package ' +
        'DEVC/K, and `properties.languages`, e.g. {"source": "en", "target": "de"}); `update` also adds sources and pairs and ' +
        'changes `header.description` (a new pair\'s texts go in a second update). `publish`/`unpublish` publish or ' +
        'unpublish a service binding (SRVB): refused, with nothing sent, when it already is; otherwise sent, then ' +
        'polled until the read-back shows it, which can take MINUTES (measured on cloud: ~132 s each way; a cloud ' +
        'unpublish is refused for a few minutes after a publish). Requires confirm: true, ' +
        'and a system whose policy does not set allowPublishService: false. `generate` runs a RAP generator ' +
        '(`adtplus_object generators`/`generatorSchema` first) into `package`: it creates every object in `content` at ' +
        'once, active, and fails with nothing created when a name exists. `applyQuickfixes` applies every deterministic ATC ' +
        'quick fix of a worklist (`adtplus_quality atc` with quickfixes: true gives the `worklistId`) to all its objects, ' +
        'which it leaves inactive: activate them afterwards. Deleting an object or a package is `adtplus_irreversible`.',
      inputSchema: {
        action: actionSchema(OBJECT_WRITE_ACTIONS),
        system: z.string().describe(SYSTEM_DESC),
        ...refSchema,
        refs: z
          .array(z.object(refSchema))
          .optional()
          .describe(
            'activate: objects to activate together in one call, at most 50; name/objectType are ignored then. ' +
              'Without refs, activate activates the one object name/objectType give. ' +
              'Activate objects that need each other ' +
              'together, e.g. a BDEF with its behaviour pool class: checked apart, the pool is not yet recognised as one. ' +
              'Activates only what is stored: with no inactive version (a change still in an unsaved editor) it fails "nothing activated".',
          ),
        forceActivation: z.boolean().optional(),
        package: z.string().optional().describe('create: the target package (a package: its superpackage). generate: the target package.'),
        generatorId: z.string().optional().describe('generate: the `id` from `adtplus_object generators`.'),
        referencedObject: z
          .object(refSchema)
          .optional()
          .describe('generate: the object the generator starts from, as given to `generatorSchema`.'),
        content: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('generate: the `content` `generatorSchema` proposed, names changed where wanted. Omit to take the proposal unchanged.'),
        worklistId: z.string().optional().describe('applyQuickfixes: from `adtplus_quality atc` with quickfixes: true.'),
        description: z.string().optional().describe('create: required, the object description.'),
        properties: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'update, create: a package\'s, domain\'s, data element\'s or message class\'s fields as AFF JSON (devc-v1, ' +
              'doma-v1, dtel-v1, msag-v1); a data element create needs dataTypeInformation, e.g. {"dataTypeInformation": ' +
              '{"category": "domain", "typeName": "ZDOM"}}; a message class, e.g. ' +
              '{"messages": [{"number": "001", "text": "Order &1 locked"}]} (text at most 73 characters, placeholders &1–&4) or ' +
              '{"header": {"description": "Orders"}}. Merged by key; a key AFF does not know is refused with the type\'s fields. ' +
              'update of a TRPR: {"translations": [{"language": "de", "objectType": "MSAG/N", "name": "ZX", "key": "SHORT_TEXT:001", ' +
              '"target": "…"}]}, at most 500 texts; an empty target is refused. create or update of a TRPR: {"textSources": ' +
              '[{"objectType": "MSAG/N", "name": "ZX"}], "languages": [{"source": "en", "target": "de"}]}.',
          ),
        transport: z
          .string()
          .optional()
          .describe(
            'create: the request to create the object in. update: the request to record the change in when ' +
              'the object is in no open request ("Object not assigned to a transport"); not needed otherwise. ' +
              'A message class: default the one SAP names; a package: default the one already locking it. ' +
              'generate: the request for the new objects (not for a local package). applyQuickfixes: the request for the changes; ' +
              'without one, a change that needs one fails.',
          ),
        additionalFields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'create, source-based types: type-specific fields; values are case-sensitive. BDEF/BDO: behaviorDefinitionType "definition", ' +
              'rootEntity (the root CDS entity), implementationType "Managed" | "Unmanaged" | "Projection" | "Abstract" | "Interface". ' +
              'SRVD/SRV: sourceType "S" (needed). SRVB/SVB: serviceDefinition, bindingType "OData V4 - UI" | "OData V4 - Web API" | ' +
              '"OData V2 - UI" | "OData V2 - Web API" (needed). Optional: DDLS/DF referencedObject, DDLX/EX extendedEntity, ' +
              'DCLS/DL protectedEntity, CLAS/OC superclass/interfaces. A wrong or missing field is refused with the full list for the type.',
          ),
        source: z
          .string()
          .optional()
          .describe(
            'update: full source text. Not taken by create, which makes an empty object. A class\'s main ' +
              'source holds only the global class: its DEFINITION and IMPLEMENTATION (for a behaviour pool ' +
              '`... DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF <root>.` with an empty IMPLEMENTATION). Local ' +
              'classes, e.g. RAP handlers, go in include "implementations". A comment outside the sections and methods ' +
              '(between DEFINITION and IMPLEMENTATION, between methods, after or on the line of an ENDCLASS) is refused: SAP has no include for it.',
          ),
        include: z
          .string()
          .optional()
          .describe(
            'update with source, classes only: "definitions" (local types), "implementations" (local classes), "macros", ' +
              '"testclasses". Omit for the main source.',
          ),
        confirm: z.boolean().optional().describe('Required (true) for "publish" and "unpublish".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ action, system, name, objectType, refs, forceActivation, package: pkg, generatorId, referencedObject, content, worklistId, description, properties, transport, additionalFields, source, include, confirm }) => {
      switch (action) {
        case 'generate':
          if (!generatorId || !pkg) return errorResult('action "generate" requires "generatorId", "package"');
          return callDaemon({ cmd: 'object.generate', system, generatorId, package: pkg, referencedObject, content, transport });
        case 'applyQuickfixes':
          if (!worklistId) return errorResult('action "applyQuickfixes" requires "worklistId" (adtplus_quality atc with quickfixes: true)');
          return callWithMirrorRoots({ cmd: 'object.applyQuickfixes', system, worklistId, transport });
        case 'create':
          if (!name || !objectType || !pkg || !description) {
            return errorResult('action "create" requires "name", "objectType", "package", "description"');
          }
          // Found live (mirror baseline): an agent passed a behaviour pool's source to create, which
          // made an empty ordinary class and reported success. Refuse instead of dropping it.
          if (source !== undefined || include !== undefined) {
            return errorResult(
              'action "create" makes an empty object and takes no "source"/"include"; nothing was created. ' +
                'Create it, then write the source with action "update" (main source first, then includes).',
            );
          }
          return callDaemon({ cmd: 'object.create', system, ref: { name, objectType }, package: pkg, description, transport, additionalFields, properties });
        case 'update':
          if (!name || !objectType) return errorResult('action "update" requires "name", "objectType"');
          if ((source === undefined) === (properties === undefined)) {
            return errorResult('action "update" takes "source" (a source-based object) or "properties" (a package, domain, data element or message class), one of them');
          }
          return callWithMirrorRoots({ cmd: 'object.update', system, ref: { name, objectType }, source, include, properties, transport });
        case 'activate':
          // Without refs, the one object name/objectType give, like the CLI.
          return callDaemon({ cmd: 'object.activate', system, refs: refs?.length ? refs : [{ name, objectType }], forceActivation });
        case 'publish':
        case 'unpublish':
          if (!name || !objectType) return errorResult(`action "${action}" requires "name", "objectType"`);
          if (!confirm) return errorResult(`action "${action}" requires confirm: true`);
          if (action === 'publish') return callDaemon({ cmd: 'object.publish', system, ref: { name, objectType }, confirm });
          return callDaemon({ cmd: 'object.unpublish', system, ref: { name, objectType }, confirm });
      }
    },
  );

  if (NAVIGATE_ACTIONS.length > 0) server.registerTool(
    'adtplus_navigate',
    {
      title: 'adt+ navigate',
      description:
        'Code navigation on ABAP and CDS objects living on the SAP system — works on `abap:` objects ' +
        'WITHOUT a local file or open editor; give it the object name and type, not a workspace path. ' +
        'Use `whereUsed` (SAP\'s where-used list) for "find all users of", "where-used", "who calls", "callers of", "what uses ' +
        'this class/method/CDS view" (for the class or view itself just give name+type; for a method or attribute pass its `symbol` name, or 1-based `line`+`character`). ' +
        'The editor\'s own reference lookup and workspace text search cannot resolve `abap:` URIs, so ' +
        'use this instead. An empty `whereUsed` result is NOT proof of "no users": the index under-reports ' +
        'shortly after activation, and the result `notes` say so — read `notes` and pass them on verbatim. ' +
        '`definition` is "go to definition" (the implementation); `declaration` is "go to declaration" ' +
        '(the signature). `hover` gives the ' +
        'signature and ABAP-Doc (CDS: element info). `outline` is the object outline ("what methods does ' +
        'this class have"). `typeHierarchy` is the inheritance tree ("superclasses / subclasses of", ' +
        '`direction` supertypes|subtypes|both). ' +
        'On CDS only hover, definition and declaration return anything; outline/typeHierarchy come ' +
        'back empty. Every result is `{result, notes}`. For `whereUsed` adt+ also reads the object\'s ' +
        'OWN source and scans it for the symbol, because the index misses callers inside it — that is ' +
        '`sourceScan`, and the answer is the UNION: every caller in `result` (tests included, marked as ' +
        'tests) plus every `kind: "call"` line in `sourceScan.matches`. Do not drop either set. The scan ' +
        'reads BOTH the active and the draft version of the source (`version` on each match, `both` where ' +
        'they agree; `sourceScan.diverged` names includes where they differ), so when a caller exists in ' +
        'only one, say which — activating the draft would change the answer. A syntax check or formatting is ' +
        '`adtplus_quality`.',
      inputSchema: {
        action: actionSchema(NAVIGATE_ACTIONS),
        system: z.string().describe(SYSTEM_DESC),
        ...refSchema,
        symbol: z
          .string()
          .optional()
          .describe(
            'A declared symbol in the object: the BARE method or attribute name, e.g. ' +
              '"GET_CUSTOMER_COUNTS". A qualified "ZCL_X=>METH" or "lo_x->meth" is accepted and ' +
              'normalised, but an interface method keeps its tilde ("IF_OO_ADT_CLASSRUN~MAIN"). Case ' +
              'does not matter. Omit it to ask about the object as a whole. If a symbol is not found, ' +
              'the error lists the declared symbols — pick one from it and retry rather than giving up ' +
              'on symbol lookup. On CDS, use the view name.',
          ),
        line: z.number().optional().describe('1-based line; use with `character` instead of `symbol`.'),
        character: z.number().optional().describe('1-based column; use with `line`.'),
        direction: z
          .enum(['supertypes', 'subtypes', 'both'])
          .optional()
          .describe('typeHierarchy: default is the server\'s default.'),
        timeoutMs: z
          .number()
          .optional()
          .describe('whereUsed: give up after this long; heavily used symbols can hang, so narrow the symbol.'),
        scanSource: z
          .boolean()
          .optional()
          .describe(
            'whereUsed: set false to skip adt+\'s scan of the object\'s own source. Leave it alone — ' +
              'the scan is the half the index leaves out.',
          ),
      },
      annotations: READ_ANNOTATIONS(false),
    },
    async ({ action, system, name, objectType, symbol, line, character, direction, timeoutMs, scanSource }) => {
      const ref = { name, objectType };
      const at = { symbol, line, character };
      switch (action) {
        case 'outline':
          return callDaemon({ cmd: 'navigate.outline', system, ref });
        case 'whereUsed':
          return callDaemon({ cmd: 'navigate.whereUsed', system, ref, ...at, timeoutMs, scanSource });
        case 'definition':
          return callDaemon({ cmd: 'navigate.definition', system, ref, ...at });
        case 'declaration':
          return callDaemon({ cmd: 'navigate.declaration', system, ref, ...at });
        case 'hover':
          return callDaemon({ cmd: 'navigate.hover', system, ref, ...at });
        case 'typeHierarchy':
          return callDaemon({ cmd: 'navigate.typeHierarchy', system, ref, ...at, direction });
      }
    },
  );

  if (QUALITY_ACTIONS.length > 0) server.registerTool(
    'adtplus_quality',
    {
      title: 'adt+ quality',
      description:
        'Checks and layout for ABAP and CDS objects on the system. `syntax` is SAP\'s syntax check without activating — it ' +
        'checks the STORED source as last saved (including unactivated changes); to check text before writing it, pass ' +
        'that text as `source` (the whole main source, or with `include` a class include) and nothing is saved. ' +
        '`format` returns the object\'s source formatted (`formatted`, `changed`); with `source` it formats that text ' +
        'instead, e.g. before `adtplus_object_write update`. It never saves: write the result with `update` if ' +
        'wanted. Layout only (case, indentation, alignment); a result that changed code is refused. `atc` runs ATC static ' +
        'analysis, `abaplint` a local abaplint pass (cloud/on-prem rule preset from system policy). `syntax`, `atc` and ' +
        '`abaplint` take one object, or several (`refs`, or a `package`) with one summary: check a batch of ' +
        'changed objects in one call, not one call per object. abaplint lints a batch together, so ' +
        'references between its objects resolve. `atc` with quickfixes: true runs ATC through SAP\'s worklist ' +
        'instead: each finding says whether a quick fix exists (no line numbers), and the `worklistId` goes to ' +
        '`adtplus_object_write applyQuickfixes`. Running ABAP Unit tests is `adtplus_test`.',
      inputSchema: {
        action: actionSchema(QUALITY_ACTIONS),
        system: z.string().describe(SYSTEM_DESC),
        ...optionalRefSchema,
        ...batchSchema('syntax, atc, abaplint'),
        source: z
          .string()
          .optional()
          .describe(
            'syntax, one object: check this text instead of the stored source, e.g. before `update`. ' +
              'The whole text of the main source (or of `include`), as it would be saved. Nothing is saved. ' +
              'format: format this text as the object\'s source instead of the stored one.',
          ),
        include: z
          .string()
          .optional()
          .describe('syntax with `source`, classes only: "definitions", "implementations", "macros", "testclasses". Omit for the main source.'),
        checkVariant: z.string().optional().describe('atc: empty = system default.'),
        quickfixes: z
          .boolean()
          .optional()
          .describe(
            'atc: run through SAP\'s ATC worklist, whose findings say which have a quick fix; the result\'s `worklistId` ' +
              'feeds adtplus_object_write applyQuickfixes. Which variant offers quick fixes depends on the system.',
          ),
        timeoutMs: z
          .number()
          .optional()
          .describe(
            'atc: per object, default 180000. A system\'s default variant can take minutes on one object; ' +
              'a faster variant (`atcVariants`) is the other way out.',
          ),
        rules: z
          .record(z.string(), z.boolean())
          .optional()
          .describe(
            'abaplint: abaplint rule switches on top of the default, e.g. {"abapdoc": true, "check_subrc": false}. The ' +
              "default reports what SAP's syntax check would refuse (errors) and likely bugs (warnings); style, naming " +
              "and the rules that need the system's objects (check_syntax) are off. An unknown rule name is refused.",
          ),
      },
      annotations: READ_ANNOTATIONS(false),
    },
    async ({ action, system, name, objectType, refs, package: pkg, subpackages, source, include, checkVariant, quickfixes, timeoutMs, rules }) => {
      const target = checkTarget(name, objectType, refs, pkg, subpackages);
      switch (action) {
        case 'syntax':
          if (typeof target === 'string') return errorResult(target);
          if (source === undefined && include !== undefined) return errorResult('"include" goes with "source"');
          if (source !== undefined && !target.ref) return errorResult('"source" checks one object: give "name" and "objectType", not "refs" or "package"');
          return callDaemon({ cmd: 'quality.syntax', system, ...target, source, include });
        case 'format':
          if (!name || !objectType) return errorResult('action "format" requires "name" and "objectType"');
          if (include !== undefined) return errorResult('"include" goes with "syntax"; "format" formats the main source or `source`');
          return callDaemon({ cmd: 'quality.format', system, ref: { name, objectType }, source });
        case 'atcVariants':
          if (!name || !objectType) return errorResult('action "atcVariants" requires "name" and "objectType"');
          return callDaemon({ cmd: 'quality.atcVariants', system, ref: { name, objectType } });
        case 'atc':
          if (typeof target === 'string') return errorResult(target);
          return callDaemon({ cmd: 'quality.atc', system, ...target, checkVariant, timeoutMs, quickfixes });
        case 'abaplint':
          if (typeof target === 'string') return errorResult(target);
          return callDaemon({ cmd: 'quality.abaplint', system, ...target, rules });
      }
    },
  );

  if (MIRROR_ACTIONS.length > 0) server.registerTool(
    'adtplus_mirror',
    {
      title: 'adt+ mirror',
      description:
        'Experimental. Mirror ABAP packages as AFF files in a local folder, for changes across many objects with local ' +
        'tools (grep, edits, git diff). `init` makes a mirror root for one system and adds a root package ' +
        '(Z*, Y*, $*). `pull` reads every object of its packages into `<root>/src/<package>/` (LF ' +
        'line endings): files changed only on the system are updated, local changes are kept, and a file ' +
        'changed on both sides gets the system\'s version in `<file>.remote`. A pull takes about a second ' +
        'per object; if it stops (throttled, timeout), call it again and it carries on. `status` lists ' +
        'local changes against the last pull without calling SAP; `git diff` shows the content. `check` ' +
        'lints the files locally (abaplint syntax and style, unknown references allowed; `.json` against ' +
        "AFF's schemas; AFF's .editorconfig) and reports file:line findings, errors first; `ok` means no " +
        'errors (parse or schema), warnings are style. It is no server check: the activation is. `new` ' +
        'writes skeleton files for an object that does not exist yet (CLAS, INTF, PROG, DDLS, DCLS, DDLX, ' +
        'BDEF, SRVD, SRVB, TABL, MSAG) into its package folder; a BDEF is named after its root entity. A message class ' +
        'is `<name>.msag.json` (AFF: description, original language, messages with number and text). Results ' +
        'are summaries (counts, at most 50 paths or findings), never source. Every action reads the files ' +
        'as they are on disk when it runs: call it after a file edit or delete has finished, never in the ' +
        'same parallel tool round. Writing back to the system: `adtplus_mirror_write`.',
      inputSchema: {
        action: actionSchema(MIRROR_ACTIONS),
        system: z.string().optional().describe(`init, pull, check, new: required. ${SYSTEM_DESC}`),
        root: z
          .string()
          .optional()
          .describe('The mirror folder: absolute, or relative to the first workspace folder (default: that folder). It must lie inside a workspace folder.'),
        package: z
          .string()
          .optional()
          .describe("init: required, the root package, e.g. ZADTPLUS_ORDERS. new: the object's package (default: the mirror's root package)."),
        type: z.string().optional().describe('new: required, CLAS, INTF, PROG, DDLS, DCLS, DDLX, BDEF, SRVD, SRVB, TABL or MSAG.'),
        name: z.string().optional().describe('new: required, the object name; for a BDEF its root entity.'),
        description: z.string().optional().describe('new: the description (default: the name), at most 60 characters.'),
        subpackages: z.boolean().optional().describe('init: pull subpackages too. Default true.'),
        maxObjects: z.number().int().positive().optional().describe('pull: allow more objects than the system\'s mirror.maxObjects (default 500).'),
        rules: z
          .record(z.string(), z.boolean())
          .optional()
          .describe(
            'check: abaplint rule switches on top of the default, e.g. {"abapdoc": true, "check_subrc": false}. The ' +
              "default reports what SAP's syntax check would refuse (errors) and likely bugs (warnings); style, naming " +
              "and the rules that need the system's objects (check_syntax) are off. An unknown rule name is refused.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, system, root, package: pkg, subpackages, maxObjects, type, name, description, rules }) => {
      let workspaceFolders: string[];
      try {
        workspaceFolders = (await folders()) ?? [process.env.ADTPLUS_PROJECT?.trim() || process.cwd()];
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      if (workspaceFolders.length === 0) return errorResult('no local workspace folder to hold a mirror');
      const location = { root: path.resolve(workspaceFolders[0]!, root ?? '.'), workspaceFolders };
      mirrorRoots.add(location.root);
      switch (action) {
        case 'init':
          if (!system || !pkg) return errorResult('action "init" requires "system" and "package"');
          return callDaemon({ cmd: 'mirror.init', system, package: pkg, subpackages, ...location });
        case 'pull':
          if (!system) return errorResult('action "pull" requires "system"');
          return callDaemon({ cmd: 'mirror.pull', system, maxObjects, ...location });
        case 'status':
          return callDaemon({ cmd: 'mirror.status', ...location });
        case 'check':
          if (!system) return errorResult('action "check" requires "system"');
          return callDaemon({ cmd: 'mirror.check', system, ...location, rules });
        case 'new':
          if (!system || !type || !name) return errorResult('action "new" requires "system", "type" and "name"');
          return callDaemon({ cmd: 'mirror.new', system, type, name, package: pkg, description, ...location });
      }
    },
  );

  if (MIRROR_WRITE_ACTIONS.length > 0) server.registerTool(
    'adtplus_mirror_write',
    {
      title: 'adt+ mirror write',
      description:
        'Experimental. Write a mirror (see `adtplus_mirror`) back to the system. `push` writes every locally changed ' +
        'object that exists on the system: each one only if its package is in the write allowlist (read ' +
        'from the system, never from the manifest) and only if the system still has what was last pulled ' +
        'or pushed; otherwise it is a conflict and nothing of it is written (pull, merge, push again). ' +
        'It creates new objects (files `adtplus_mirror` `new` wrote, or any CLAS, INTF, PROG, DDLS, DCLS, ' +
        'DDLX, BDEF, SRVD, SRVB, TABL with its `.json`, or MSAG) in the package their folder names, in any order, ' +
        "and replaces a created object's local files with the system's version where it keeps them " +
        'differently (`rewritten`). Then it activates everything it wrote or created, and what an earlier ' +
        'push left inactive, in one call and returns the diagnostics as file:line (one error keeps most of ' +
        'the call inactive). A created object is read back after its activation, which adds and changes ' +
        'files (class includes, a view\'s `.json`): `activation.readBack` lists what it took; a local change ' +
        'there is kept and the system\'s version goes to `<file>.remote`. ' +
        '`dryRun: true` lists what would be written and created without calling SAP. `.jsonc`/`.properties` ' +
        'changes and local deletes are reported, never sent. A message class (`.msag.json`) is written at once, ' +
        'without activation: changed and new messages. A message removed from the file, and a changed description, are ' +
        'reported in `leftOut`, never sent (`adtplus_irreversible deleteMessages` deletes a message). ' +
        "`activate` activates what a push wrote but didn't activate. Results are summaries, never source; " +
        '`complete: false` means something was left undone. Like a pull it can take minutes; if it stops, ' +
        'call it again. `push` plans from the files on disk when it runs: call it after your edits have ' +
        'finished, never in the same parallel tool round as an edit.',
      inputSchema: {
        action: actionSchema(MIRROR_WRITE_ACTIONS),
        system: z.string().describe(SYSTEM_DESC),
        root: z
          .string()
          .optional()
          .describe('The mirror folder: absolute, or relative to the first workspace folder (default: that folder).'),
        dryRun: z.boolean().optional().describe('push: only list what would be written; no SAP call.'),
        activate: z.boolean().optional().describe('push: activate what was written (default true).'),
        transport: z
          .string()
          .optional()
          .describe(
            'push: the transport request new objects are created in (needed in a transportable package), and that ' +
              'objects in no open request are recorded in (SAP answers "Object not assigned to a transport" without it).',
          ),
        maxObjects: z.number().int().positive().optional().describe("push: allow more objects than the system's mirror.maxObjects (default 500)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, system, root, dryRun, activate, transport, maxObjects }) => {
      let workspaceFolders: string[];
      try {
        workspaceFolders = (await folders()) ?? [process.env.ADTPLUS_PROJECT?.trim() || process.cwd()];
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      if (workspaceFolders.length === 0) return errorResult('no local workspace folder holds a mirror');
      const location = { root: path.resolve(workspaceFolders[0]!, root ?? '.'), workspaceFolders };
      mirrorRoots.add(location.root);
      switch (action) {
        case 'push':
          return callDaemon({ cmd: 'mirror.push', system, dryRun, activate, transport, maxObjects, ...location });
        case 'activate':
          return callDaemon({ cmd: 'mirror.activate', system, ...location });
      }
    },
  );

  if (IRREVERSIBLE_ACTIONS.length > 0) server.registerTool(
    'adtplus_irreversible',
    {
      title: 'adt+ irreversible actions',
      description:
        'Permanently delete an object or package, messages of a message class, or release a transport request. Every action here ' +
        'is irreversible and requires confirm: true. `deleteObject` is refused ' +
        'unless the target\'s package is in the system\'s write allowlist — see `adtplus_object_write`; a package ' +
        '(objectType DEVC/K) counts as in its superpackage and is deleted only when empty; a translation project (TRPR, ' +
        'only with allowTranslations: true) goes with its language pairs and text sources, the translations it published stay. ' +
        '`deleteMessages` deletes the ' +
        'message `numbers` of the message class `name`, all or none: a number the class lacks refuses the call. `releaseTransport` ' +
        'releases one of your own modifiable requests, tasks first (a task that fails stops it, with SAP\'s ' +
        'messages for that task), or one of your own modifiable tasks, also in someone else\'s request, which ' +
        'stays open; via SAP REST (`via: "rest-fallback"`, no release request in adt-ls 1.1.2); the result ' +
        'names the target.',
      inputSchema: {
        action: actionSchema(IRREVERSIBLE_ACTIONS),
        system: z.string().describe(SYSTEM_DESC),
        name: z.string().optional().describe('deleteObject/deleteMessages: the object (a package too) or message class name.'),
        numbers: z
          .array(z.union([z.string(), z.number()]))
          .optional()
          .describe('deleteMessages: the message numbers to delete.'),
        objectType: z.string().optional().describe('deleteObject: ADT type code, e.g. CLAS/OC; DEVC/K for a package.'),
        transport: z
          .string()
          .optional()
          .describe(
            'releaseTransport: required, the request or task number. deleteMessages: optional, the request to record the ' +
              'deletion in. deleteObject: optional, the request to record the deletion in when the object is in no ' +
              'open request ("Object not assigned to a transport"); a package: default the one already locking it.',
          ),
        confirm: z.boolean().optional().describe('Required (true) for every action here.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ action, system, name, objectType, numbers, transport, confirm }) => {
      if (!confirm) return errorResult(`action "${action}" requires confirm: true`);
      switch (action) {
        case 'deleteObject':
          if (!name || !objectType) return errorResult('action "deleteObject" requires "name", "objectType"');
          return callDaemon({ cmd: 'object.delete', system, ref: { name, objectType }, confirm, transport });
        case 'deleteMessages':
          if (!name || !numbers?.length) return errorResult('action "deleteMessages" requires "name", "numbers"');
          return callWithMirrorRoots({ cmd: 'object.deleteMessages', system, name, numbers, transport, confirm });
        case 'releaseTransport':
          if (!transport) return errorResult('action "releaseTransport" requires "transport"');
          return callDaemon({ cmd: 'transport.release', system, transport, confirm });
      }
    },
  );

  if (TEST_ALLOWED) server.registerTool(
    'adtplus_test',
    {
      title: 'adt+ test',
      description:
        'Run an object\'s ABAP Unit tests (optionally with coverage). This runs test code, so it is ' +
        'refused unless the object\'s package is in the system\'s write allowlist, like ' +
        '`adtplus_object_write`.',
      inputSchema: {
        system: z.string().describe(SYSTEM_DESC),
        ...refSchema,
        coverage: z.boolean().optional().describe('Include code coverage.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ system, name, objectType, coverage }) => {
      return callDaemon({ cmd: 'test.unit', system, ref: { name, objectType }, coverage });
    },
  );

  let runTool: RegisteredTool | undefined;
  if (RUN_POSSIBLE) runTool = server.registerTool(
    'adtplus_run',
    {
      title: 'adt+ run',
      description:
        'Run an if_oo_adt_classrun object and return its console output. Destructive (arbitrary ' +
        'ABAP execution) — requires confirm: true, and only runs classes whose package is in the ' +
        'system\'s write allowlist. Only on systems whose policy sets allowRun: true.',
      // A placeholder system while none allows run: the tool is disabled then, and z.enum needs a value.
      inputSchema: runInputSchema(runSystems.length > 0 ? runSystems : ['-']),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ system, name, objectType, confirm }) => {
      if (!confirm) return errorResult('adtplus_run requires confirm: true');
      return callDaemon({ cmd: 'run.application', system, ref: { name, objectType }, confirm });
    },
  );
  if (runTool && runSystems.length === 0) runTool.disable();
  runSystemUpdaters.set(server, (systems) => {
    if (!runTool) return;
    if (systems.length === 0) runTool.disable();
    else runTool.update({ paramsSchema: runInputSchema(systems), enabled: true });
  });

  let dataTool: RegisteredTool | undefined;
  if (DATA_POSSIBLE) dataTool = server.registerTool(
    'adtplus_data',
    {
      title: 'adt+ data',
      description:
        'Run one ABAP SQL SELECT on an SAP system through ADT\'s data preview and return the rows: to look ' +
        'into a table or CDS view while developing it. Reads whatever the SAP user may read there; keep ' +
        'statements narrow (WHERE, field list, maxRows) and don\'t page through a table. SAP runs a SELECT ' +
        'only; adt+ refuses one that reads another client. totalRows is SAP\'s full count, truncatedRows says ' +
        'rows were left out. Only on systems whose policy sets allowDataPreview: true.',
      // A placeholder system while none allows data preview: the tool is disabled then, and z.enum needs a value.
      inputSchema: dataInputSchema(dataSystems.length > 0 ? dataSystems : ['-']),
      annotations: READ_ANNOTATIONS(true),
    },
    async ({ system, statement, maxRows }) => callDaemon({ cmd: 'data.query', system, statement, maxRows }),
  );
  if (dataTool && dataSystems.length === 0) dataTool.disable();
  dataSystemUpdaters.set(server, (systems) => {
    if (!dataTool) return;
    if (systems.length === 0) dataTool.disable();
    else dataTool.update({ paramsSchema: dataInputSchema(systems), enabled: true });
  });

  let runtimeTool: RegisteredTool | undefined;
  if (RUNTIME_ACTIONS.length > 0) runtimeTool = server.registerTool(
    'adtplus_runtime',
    {
      title: 'adt+ runtime',
      description:
        'Runtime logs of an SAP system. ABAP runtime errors (short dumps, ST22): why a program, an `adtplus_run` or an `adtplus_test` ' +
        'aborted. `dumps` lists them, newest first, metadata only (id, time, runtime error, program, user); by ' +
        'default only the logged-on user\'s own, at most 100, narrowed by `from`/`to`. `dump` reads one by its ' +
        '`id`: the header and the developer chapters (short text, what happened, error analysis, how to correct, ' +
        'exception chain, where terminated, source extract, active calls); `otherChapters` lists the rest, ' +
        'readable through `chapters`. Gateway error log (/IWFND/ERROR_LOG): why an OData/Fiori request failed. ' +
        '`gatewayErrors` lists them the same way (id, time, type, short text, user); `gatewayError` reads one: ' +
        'header, service, error context with the exception chain, source extract, call stack (`otherSections` ' +
        'names any the size limit left out, readable through `sections`). Logs can hold program data: read the entry you need, ' +
        'not a series. Only on systems whose policy sets allowRuntimeLogs: true.',
      // A placeholder system while none allows dumps: the tool is disabled then, and z.enum needs a value.
      inputSchema: runtimeInputSchema(RUNTIME_ACTIONS, runtimeSystems.length > 0 ? runtimeSystems : ['-']),
      annotations: READ_ANNOTATIONS(true),
    },
    async ({ action, system, user, from, to, maxResults, id, chapters, sections }) => {
      switch (action) {
        case 'dump':
          if (!id) return errorResult('action "dump" requires "id" (from action "dumps")');
          return callDaemon({ cmd: 'runtime.dump', system, id, chapters });
        case 'gatewayErrors':
          return callDaemon({ cmd: 'runtime.gatewayErrors', system, user, from, to, maxResults });
        case 'gatewayError':
          if (!id) return errorResult('action "gatewayError" requires "id" (from action "gatewayErrors")');
          return callDaemon({ cmd: 'runtime.gatewayError', system, id, sections });
        default:
          return callDaemon({ cmd: 'runtime.dumps', system, user, from, to, maxResults });
      }
    },
  );
  if (runtimeTool && runtimeSystems.length === 0) runtimeTool.disable();
  runtimeSystemUpdaters.set(server, (systems) => {
    if (!runtimeTool) return;
    if (systems.length === 0) runtimeTool.disable();
    else runtimeTool.update({ paramsSchema: runtimeInputSchema(RUNTIME_ACTIONS, systems), enabled: true });
  });

  return server;
}

/** How long a call waits for the client to name its workspace folders. */
const ROOTS_WAIT_MS = 5000;

/**
 * `roots/list` as the client sends it. The SDK's own `listRoots()` refuses the
 * whole list when one root isn't `file://`, and VS Code sends its ADT system
 * folders as roots too; `projectConfigSetsFromRoots` keeps the local ones.
 */
const ANY_ROOTS = z.object({ roots: z.array(z.object({ uri: z.string() }).passthrough()) }).passthrough();

/**
 * Follow the client's workspace folders (MCP roots, ADR-006): each request
 * carries the project configs of every folder, and `adtplus_run` offers the
 * systems those allow run on. Without roots support, or with no local folder
 * among them, requests fall back to ADTPLUS_PROJECT, else the working folder.
 *
 * Returns the wait every request goes through: it resolves once the folders
 * are known, and rejects when a client that offers roots hasn't named them in
 * time or failed to (the next request asks again). A request never runs on the
 * user config just because the folders arrived late.
 */
export function followRoots(
  server: McpServer,
  setScope: (sets: string[][] | undefined, folders: string[] | undefined) => void,
  home?: string,
  waitMs = ROOTS_WAIT_MS,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let failure: string | undefined;
  const refresh = (): Promise<void> => {
    failure = undefined;
    pending = (async () => {
      if (!server.server.getClientCapabilities()?.roots) return;
      try {
        const { roots } = await server.server.request({ method: 'roots/list' }, ANY_ROOTS);
        const uris = roots.map((r) => r.uri);
        const sets = projectConfigSetsFromRoots(uris, home);
        setScope(sets, workspaceFoldersFromRoots(uris));
        const gated = await gatedSystemsFor(sets);
        setRunSystems(server, gated.run);
        setDataSystems(server, gated.data);
        setRuntimeSystems(server, gated.runtime);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        console.error(`adt+: could not read the workspace folders: ${failure}`);
      }
    })();
    return pending;
  };
  server.server.oninitialized = () => void refresh();
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => void refresh());
  return async () => {
    if (!server.server.getClientCapabilities()?.roots) return;
    if (failure !== undefined) await refresh();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), waitMs);
    });
    const late = await Promise.race([pending, timedOut]);
    clearTimeout(timer);
    if (late === true) throw new Error(`adt+: the client has not named its workspace folders within ${waitMs / 1000} s; try again`);
    if (failure !== undefined) throw new Error(`adt+: could not read the workspace folders (${failure}); try again`);
  };
}

async function main(): Promise<void> {
  let sets: string[][] | undefined;
  let folders: string[] | undefined;
  const gated = await gatedSystemsFor();
  const server = createMcpServer({
    deny: parseDenyList(process.env.ADTPLUS_DENY),
    readOnly: isReadOnlyEnv(process.env.ADTPLUS_READONLY),
    runSystems: gated.run,
    dataSystems: gated.data,
    runtimeSystems: gated.runtime,
    scope: async () => {
      await rootsReady();
      return sets;
    },
    folders: async () => {
      await rootsReady();
      return folders;
    },
  });
  const rootsReady = followRoots(server, (next, nextFolders) => {
    sets = next;
    folders = nextFolders;
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
