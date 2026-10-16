import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import { isTrusted, projectFolderOf, readTrustStore, sha256 } from './project-config.js';

/** A path that doesn't depend on the folder adt+ runs in: absolute, or under `~/` (resolved on load). */
const absolutePath = z.string().refine((p) => p.startsWith('~/') || path.isAbsolute(p), 'an absolute path or one starting with ~/');

/**
 * adt+'s own per-system policy fields, read from ~/.config/adtplus/systems.json
 * and the project configs above the working folder (ADR-006). Non-secret: it
 * names a Keychain service, never a secret value. The descriptions double as
 * the editor help in the JSON Schema (`adtplus config schema`).
 */
const systemFields = {
  kind: z.enum(['cloud', 'onprem']).describe('S/4HANA Cloud (cloud) or an on-premise system (onprem).'),
  auth: z
    .enum(['basic', 'interactive'])
    .describe('basic: user and Keychain password; interactive: browser SSO on first use.'),
  client: z.string().describe('SAP client, e.g. "300". 000 and 066 are SAP-reserved and refused.'),
  systemUrl: z
    .string()
    .url()
    .describe(
      "Direct HTTP URL. Required when the ~/.adtls destination for this system isn't HTTP (e.g. an RFC destination).",
    ),
  adtlsDestinationId: z
    .string()
    .describe('id in ~/.adtls/destinations.json to take systemUrl from, when its protocol is "http".'),
  ssoUrl: z
    .string()
    .url()
    .describe("Reentrance (SSO) host for interactive systems' REST logon. Defaults to systemUrl without `-api`."),
  user: z.string().describe('Logon user for basic auth.'),
  language: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'a two-letter language like "EN"')
    .describe('Logon language of the adt-ls and the REST session: messages, and the master language of what REST creates. Default EN.'),
  keychainService: z
    .string()
    .describe('macOS Keychain generic-password service holding the password (basic auth). Never the password itself.'),
  extraCaCerts: z
    .array(z.string())
    .describe(
      'PEM files to trust in addition to the system CAs. `~/` and relative paths resolve against the folder holding the file (for a project config, the folder holding `.adtplus/`). Replaces an inherited list.',
    ),
  defaultSoftwareComponent: z
    .string()
    .describe('Software component for new packages when the caller passes none and the superpackage has none.'),
  languageVersion: z
    .enum(['standard', 'keyUser', 'cloudDevelopment'])
    .describe('ABAP language version every new package on this system must get; enforced on package create.'),
  writeAllowlist: z
    .array(
      z.union([
        z.string(),
        z.object({ package: z.string(), subpackages: z.boolean().optional() }).strict(),
      ]),
    )
    .describe(
      'Packages adt+ may write to (ADR-003). A string covers that package only; {package, subpackages: true} covers its whole subtree. Replaces an inherited list.',
    ),
  allowPublishService: z
    .boolean()
    .describe('false turns off publishing/unpublishing service bindings on this system. Unset = allowed.'),
  allowRun: z
    .boolean()
    .describe('true enables adtplus_run (arbitrary ABAP execution) on this system (ADR-005). Off unless set.'),
  allowDataPreview: z
    .boolean()
    .describe('true enables adtplus_data (one SQL SELECT through ADT data preview) on this system (ADR-013). Off unless set.'),
  allowRuntimeLogs: z
    .boolean()
    .describe(
      'true enables adtplus_runtime (short dumps, gateway error log) on this system (ADR-015). Off unless set. System messages need no switch.',
    ),
  allowTranslations: z
    .boolean()
    .describe(
      'true enables translations through the unreleased OData UI service UI_SMTR_PROJECT on this system: object translations and the TRPR type (ADR-019). Off unless set.',
    ),
  rateLimit: z
    .object({
      concurrency: z.number().int().positive().optional().describe('Calls running at once. Default 4.'),
      perMinute: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Estimated backend requests per minute (ADR-008). Default 600.'),
    })
    .strict()
    .describe(
      "Per-system limit on adt+'s calls to SAP, in estimated backend requests (ADR-005, ADR-008). Merged key by key with an inherited one (ADR-006).",
    ),
  restTimeout: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .describe(
      "Seconds a REST request (the REST fallbacks, the OData UI service) has for SAP's whole answer before adt+ gives it up. Default 120.",
    ),
  mirror: z
    .object({
      concurrency: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Calls a mirror command or the git helper keeps in flight, outside the per-minute budget (ADR-008): REST in full, adt-ls at most 3. Default 3; more than 5 counts as 5.',
        ),
      maxObjects: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Most objects one mirror root may hold; more needs --max-objects on the call. Default 500.'),
      namespaces: z
        .array(z.string().regex(/^\/[^/]+\/$/, 'a namespace like "/NSPC/"'))
        .optional()
        .describe('Customer namespaces whose packages may be mirrored, besides Z, Y and $ (e.g. ["/NSPC/"]). Replaces an inherited list.'),
      git: z
        .object({
          enabled: z.boolean().optional().describe('true lets `git clone adtplus::<system>/…` use this system (ADR-011). Off unless set.'),
        })
        .strict()
        .optional()
        .describe('The git remote helper (ADR-011).'),
    })
    .strict()
    .describe('Mirror mode (ADR-007): pulling packages as AFF files into a local folder. Merged key by key with an inherited one (ADR-006).'),
  format: z
    .object({
      engine: z
        .enum(['sap', 'abap-cleaner'])
        .optional()
        .describe(
          "What `quality format` formats with (ADR-017): sap = SAP's pretty printer and CDS formatter, as ADT's Format, with the logon user's settings on the system; abap-cleaner = the abap-cleaner binary, locally. Default sap.",
        ),
      abapCleaner: z
        .object({
          path: absolutePath.optional().describe("The abap-cleaner binary (absolute or ~/). Default: the newest one of VS Code's abap-cleaner extension."),
          profile: absolutePath
            .optional()
            .describe("An abap-cleaner profile (.cfj, absolute or ~/). Default: adt+'s own, with abap-cleaner's layout rules only."),
          release: z
            .string()
            .regex(/^\d{3,4}$/, 'an ABAP release like "758"')
            .optional()
            .describe('The newest ABAP release whose syntax a rule may use (abap-cleaner --release), e.g. "758". Default: any.'),
        })
        .strict()
        .optional()
        .describe('Settings for format.engine "abap-cleaner".'),
    })
    .strict()
    .describe('Source formatting (ADR-017). Merged key by key with an inherited one (ADR-006).'),
  vfsMount: z
    .string()
    .describe(
      "Folder name ADT for VS Code mounts this system under (abap:/repotree-v1/<vfsMount>/...), so returned URIs open in the editor.",
    ),
};

/** One system's entry in one file: any subset of the fields, since a project config may override just one. */
const SystemEntrySchema = z.object(systemFields).partial().strict();

/** A system after merging every file that defines it. */
const SystemPolicySchema = SystemEntrySchema.extend({
  kind: systemFields.kind,
  auth: systemFields.auth,
  client: systemFields.client,
  extraCaCerts: systemFields.extraCaCerts.default([]),
  writeAllowlist: systemFields.writeAllowlist.default([]),
});

/** System ids to entries. `$schema` is the one other key, for editors. */
const SystemsFileSchema = z
  .object({ $schema: z.string().optional().describe('JSON Schema for editor help; ignored by adt+.') })
  .catchall(SystemEntrySchema);

/** JSON Schema of systems.json, for `"$schema"` in the file. */
export function systemsConfigJsonSchema(): unknown {
  return z.toJSONSchema(SystemsFileSchema, { io: 'input' });
}

export type SystemPolicy = z.infer<typeof SystemPolicySchema>;
export type SystemEntry = z.infer<typeof SystemEntrySchema>;

export interface Destination extends SystemPolicy {
  /** The system key, e.g. "onprem", "cloud-erp" — used everywhere else in adt+. */
  id: string;
  /** Fully resolved HTTP(S) URL, after merging with ~/.adtls where applicable. */
  systemUrl: string;
}

interface AdtlsDestinationEntry {
  id: string;
  protocol: string;
  properties?: Record<string, string>;
}

interface AdtlsDestinationsFile {
  formatVersion?: string;
  destinations?: AdtlsDestinationEntry[];
}

/**
 * SAP-reserved clients. The SAP API Policy excludes APIs bound to them (§1.2,
 * FAQ Q55), so adt+ refuses to load a system configured with one
 * (docs/decisions/005-api-policy-scope.md).
 */
const RESERVED_CLIENTS = new Set(['000', '066']);

function assertClientAllowed(id: string, client: string): void {
  // "0" and "66" name the same clients as "000" and "066".
  const normalized = /^\d{1,3}$/.test(client.trim()) ? client.trim().padStart(3, '0') : client.trim();
  if (RESERVED_CLIENTS.has(normalized)) {
    throw new Error(
      `adt+ system "${id}": client ${normalized} is SAP-reserved and adt+ refuses to connect to it. ` +
        `Configure a development client in systems.json instead.`,
    );
  }
}

/** ~/.config/adtplus/systems.json, or `ADTPLUS_CONFIG` when set. */
export function defaultSystemsConfigPath(): string {
  const override = process.env.ADTPLUS_CONFIG?.trim();
  if (override) return path.resolve(override);
  return path.join(homedir(), '.config', 'adtplus', 'systems.json');
}

export function defaultAdtlsDestinationsPath(): string {
  return path.join(homedir(), '.adtls', 'destinations.json');
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function parseJson(filePath: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${filePath}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One line per zod issue, each with its field path (`onprem.writeAllowlist.0`), under a heading. */
function formatIssues(heading: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  ${field}: ${issue.message}`;
  });
  return `${heading}\n${lines.join('\n')}`;
}

/** `~/…` from the home folder, a relative path from `baseDir`, an absolute one as is. */
function resolveConfigPath(p: string, baseDir: string): string {
  if (p === '~' || p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return path.resolve(baseDir, p);
}

export interface LoadDestinationsOptions {
  systemsConfigPath?: string;
  adtlsDestinationsPath?: string;
}

export interface LoadConfigOptions extends LoadDestinationsOptions {
  /** Project configs, nearest first, as `findProjectConfigs` returns them. */
  projectConfigPaths?: string[];
  trustStorePath?: string;
}

/** One config file as read. */
export interface ConfigLayer {
  path: string;
  kind: 'user' | 'project';
  /** SHA-256 of the content read: what an approval records. */
  sha256: string;
  /** Always true for the user config; a project config only once approved. */
  trusted: boolean;
  systems: Record<string, SystemEntry>;
}

export interface LoadedConfig {
  destinations: Record<string, Destination>;
  /** Per system and field, where the value came from: a file path, or `~/.adtls <id>` for a looked-up systemUrl. */
  sources: Record<string, Record<string, string>>;
  /** The user config first, then the project configs from the farthest to the nearest. */
  layers: ConfigLayer[];
  /** Systems left out because a project config that sets them isn't approved, with the reason. */
  refused: Record<string, string>;
}

async function readLayer(filePath: string, kind: ConfigLayer['kind']): Promise<ConfigLayer | undefined> {
  const text = await readTextIfExists(filePath);
  if (text === undefined) return undefined;
  const parsed = SystemsFileSchema.safeParse(parseJson(filePath, text));
  if (!parsed.success) throw new Error(formatIssues(`${filePath}: invalid adt+ systems config`, parsed.error));
  const { $schema: _schema, ...systems } = parsed.data as Record<string, SystemEntry> & { $schema?: string };

  const baseDir = kind === 'project' ? projectFolderOf(filePath) : path.dirname(filePath);
  for (const entry of Object.values(systems)) {
    if (entry.extraCaCerts) entry.extraCaCerts = entry.extraCaCerts.map((f) => resolveConfigPath(f, baseDir));
    const cleaner = entry.format?.abapCleaner;
    if (cleaner?.path) cleaner.path = resolveConfigPath(cleaner.path, baseDir);
    if (cleaner?.profile) cleaner.profile = resolveConfigPath(cleaner.profile, baseDir);
  }
  return { path: filePath, kind, sha256: sha256(text), trusted: kind === 'user', systems };
}

/**
 * The config files as read: the user config, then the project configs from the
 * farthest to the nearest, each marked approved or not. Empty when none exists.
 */
export async function readConfigLayers(opts: LoadConfigOptions = {}): Promise<ConfigLayer[]> {
  const projectPaths = opts.projectConfigPaths ?? [];
  const layers: ConfigLayer[] = [];
  const user = await readLayer(opts.systemsConfigPath ?? defaultSystemsConfigPath(), 'user');
  if (user) layers.push(user);
  const trust = projectPaths.length > 0 ? await readTrustStore(opts.trustStorePath) : {};
  for (const projectPath of [...projectPaths].reverse()) {
    const layer = await readLayer(projectPath, 'project');
    if (!layer) continue;
    layer.trusted = isTrusted(trust, layer.path, layer.sha256, setsObjectField(layer));
    layers.push(layer);
  }
  return layers;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a layer sets an object field, whose meaning changed when objects began to merge key by key (ADR-006). */
function setsObjectField(layer: ConfigLayer): boolean {
  return Object.values(layer.systems).some((entry) => Object.values(entry).some(isPlainObject));
}

/**
 * `over`'s keys onto `target`, an object in both merged key by key, anything else (a list
 * included) replaced (ADR-006). Never changes a layer's own objects: a merged object is a copy.
 * `set` hears the dotted path of each value taken, `mirror.git.enabled`.
 */
function mergeKeys(target: Record<string, unknown>, over: Record<string, unknown>, set: (path: string) => void, prefix = ''): void {
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      const copy = isPlainObject(target[key]) ? { ...target[key] } : {};
      mergeKeys(copy, value, set, `${prefix}${key}.`);
      target[key] = copy;
      // An empty object sets nothing, but the file still names the field.
      if (Object.keys(value).length === 0) set(`${prefix}${key}`);
    } else {
      target[key] = value;
      set(`${prefix}${key}`);
    }
  }
}

/** `over` merged onto `base` as a config layer is onto the files before it (ADR-006). */
export function mergeConfigValue(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const merged = { ...base };
  mergeKeys(merged, over, () => undefined);
  return merged;
}

/**
 * Merge entries field by field, a later layer winning; an object field (`mirror`, `rateLimit`)
 * key by key, a list replaced (ADR-006). `sources` records the file of each value by
 * its dotted path (`writeAllowlist`, `mirror.maxObjects`).
 */
export function mergeLayers(layers: ConfigLayer[]): {
  entries: Record<string, SystemEntry>;
  sources: Record<string, Record<string, string>>;
} {
  const entries: Record<string, SystemEntry> = {};
  const sources: Record<string, Record<string, string>> = {};
  for (const layer of layers) {
    for (const [id, entry] of Object.entries(layer.systems)) {
      const from = (sources[id] ??= {});
      mergeKeys((entries[id] ??= {}) as Record<string, unknown>, entry as Record<string, unknown>, (path) => (from[path] = layer.path));
    }
  }
  return { entries, sources };
}

/**
 * Resolve adt+'s configured systems (docs/decisions/006-layered-config.md):
 * the user config, then each project config from the farthest to the nearest,
 * a nearer file's field winning; then the system URL from
 * ~/.adtls/destinations.json where the result points at one (and its protocol
 * is HTTP — RFC entries, like `onprem`'s, are not usable and the config must carry
 * `systemUrl` directly instead).
 *
 * A system that an unapproved project config sets is refused as a whole, never
 * resolved from the other files.
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const systemsPath = opts.systemsConfigPath ?? defaultSystemsConfigPath();
  const adtlsPath = opts.adtlsDestinationsPath ?? defaultAdtlsDestinationsPath();

  const layers = await readConfigLayers(opts);
  if (layers.length === 0) {
    throw new Error(`No adt+ systems config at ${systemsPath}. Create it before use.`);
  }

  const refused: Record<string, string> = {};
  for (const layer of layers) {
    if (layer.trusted) continue;
    for (const id of Object.keys(layer.systems)) {
      refused[id] ??= `${layer.path} is not approved; approve it with \`adtplus config trust\``;
    }
  }
  const { entries, sources } = mergeLayers(layers);

  const adtls = await readTextIfExists(adtlsPath);
  const adtlsFile = adtls === undefined ? undefined : (parseJson(adtlsPath, adtls) as AdtlsDestinationsFile);
  const adtlsById = new Map((adtlsFile?.destinations ?? []).map((d) => [d.id, d]));

  const destinations: Record<string, Destination> = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (refused[id]) continue;
    const parsed = SystemPolicySchema.safeParse(entry);
    if (!parsed.success) {
      const files = [...new Set(Object.values(sources[id] ?? {}))].join(', ');
      throw new Error(formatIssues(`adt+ system "${id}" (from ${files}): invalid`, parsed.error));
    }
    const policy = parsed.data;
    assertClientAllowed(id, policy.client);
    destinations[id] = { id, ...policy, systemUrl: resolveSystemUrl(id, policy, adtlsById) };
    if (!policy.systemUrl && policy.adtlsDestinationId) {
      sources[id]!.systemUrl = `~/.adtls ${policy.adtlsDestinationId}`;
    }
  }
  return { destinations, sources, layers, refused };
}

/** The resolved systems of `loadConfig`, for callers that need nothing else. */
export async function loadDestinations(
  opts: LoadConfigOptions = {},
): Promise<Record<string, Destination>> {
  return (await loadConfig(opts)).destinations;
}

function resolveSystemUrl(
  id: string,
  policy: SystemPolicy,
  adtlsById: Map<string, AdtlsDestinationEntry>,
): string {
  if (policy.systemUrl) return policy.systemUrl;

  if (policy.adtlsDestinationId) {
    const entry = adtlsById.get(policy.adtlsDestinationId);
    if (!entry) {
      throw new Error(
        `adt+ system "${id}": adtlsDestinationId "${policy.adtlsDestinationId}" not found in ~/.adtls/destinations.json`,
      );
    }
    if (entry.protocol !== 'http') {
      throw new Error(
        `adt+ system "${id}": ~/.adtls destination "${policy.adtlsDestinationId}" is protocol "${entry.protocol}", not "http" — set "systemUrl" directly in systems.json instead`,
      );
    }
    const systemUrl = entry.properties?.systemUrl;
    if (!systemUrl) {
      throw new Error(
        `adt+ system "${id}": ~/.adtls destination "${policy.adtlsDestinationId}" has no properties.systemUrl`,
      );
    }
    return systemUrl;
  }

  throw new Error(`adt+ system "${id}": neither "systemUrl" nor "adtlsDestinationId" is set`);
}

/** JSON with object keys sorted, so two equal destinations compare equal whatever order their fields were merged in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * Combine the configs of several workspace folders (one project config chain
 * each, ADR-006): a system resolved the same way in every folder that has it is
 * used; one refused in any folder stays refused; one that resolves differently
 * between folders is refused, naming the files.
 */
export function combineConfigs(configs: LoadedConfig[]): LoadedConfig {
  if (configs.length === 1) return configs[0]!;
  const combined: LoadedConfig = { destinations: {}, sources: {}, layers: [], refused: {} };
  const seen = new Set<string>();
  for (const config of configs) {
    for (const layer of config.layers) {
      if (seen.has(layer.path)) continue;
      seen.add(layer.path);
      combined.layers.push(layer);
    }
  }
  const ids = new Set(configs.flatMap((c) => [...Object.keys(c.destinations), ...Object.keys(c.refused)]));
  for (const id of ids) {
    const refusedIn = configs.find((c) => c.refused[id]);
    if (refusedIn) {
      combined.refused[id] = refusedIn.refused[id]!;
      continue;
    }
    const defining = configs.filter((c) => c.destinations[id]);
    if (new Set(defining.map((c) => canonical(c.destinations[id]))).size > 1) {
      const variants = defining.map((c) => {
        const files = [...new Set(Object.values(c.sources[id] ?? {}))].filter((f) => c.layers.some((l) => l.kind === 'project' && l.path === f));
        return files.length > 0 ? files.join(' + ') : 'the user config alone';
      });
      combined.refused[id] = `it differs between the workspace folders (${[...new Set(variants)].join(' vs. ')})`;
      continue;
    }
    combined.destinations[id] = defining[0]!.destinations[id]!;
    combined.sources[id] = defining[0]!.sources[id] ?? {};
  }
  return combined;
}
