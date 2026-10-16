import { lstat, writeFile } from 'node:fs/promises';
import { filesBelow } from './files.js';
import { SRC_DIR, affName, isMirrorablePackage, objectId, packageFolder, resolveRoot, safeTarget } from './layout.js';
import { loadManifest } from './manifest.js';
import { toLocal } from './normalize.js';
import type { MirrorLocation, MirrorPolicy } from './pull.js';

/**
 * `mirror new` (docs/decisions/007-mirror-mode.md): AFF skeleton files for an
 * object that doesn't exist yet, in its package folder. Local only. The manifest stays as it is, so `status` lists
 * the files as added until a push creates the object.
 */

export interface NewInput extends MirrorLocation {
  system: string;
  type: string;
  name: string;
  /** Default: the mirror's root package, when it has one. */
  package?: string;
  /** Default: the name. */
  description?: string;
  /** The system's `languageVersion` (systems.json), written into the header. */
  languageVersion?: string;
  /** The logon language, `EN`: a message class's original language. */
  language?: string;
}

export interface NewResult {
  root: string;
  object: string;
  package: string;
  files: string[];
  notes: string[];
}

interface Skeleton {
  /** Main source file's extension; none for SRVB. */
  ext?: string;
  maxName: number;
  /** Type-specific `.json` fields after the header, as adt-ls serves a fresh object (probe 3, P9). */
  fields?: Record<string, unknown>;
  source?: (s: { name: string; lower: string; label: string }) => string;
  notes?: (s: { name: string }) => string[];
  /** The header names the logon language and no language version (msag-v1). */
  logonLanguage?: true;
}

const PLACEHOLDERS = 'replace the placeholders (data_source_name, field_name, …) before a push';

const SKELETONS: Record<string, Skeleton> = {
  CLAS: {
    ext: 'clas.abap',
    maxName: 30,
    fields: { fixPointArithmetic: true },
    source: ({ lower }) => `CLASS ${lower} DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.



CLASS ${lower} IMPLEMENTATION.
ENDCLASS.`,
    notes: () => ['a behaviour pool needs "category": "behaviorClass" in the .json and FOR BEHAVIOR OF in the definition'],
  },
  INTF: {
    ext: 'intf.abap',
    maxName: 30,
    source: ({ lower }) => `INTERFACE ${lower}
  PUBLIC.
ENDINTERFACE.`,
  },
  PROG: {
    ext: 'prog.abap',
    maxName: 40,
    fields: { generalInformation: { fixPointArithmetic: true }, logicalDatabase: { name: 'D$S' } },
    source: ({ lower }) => `REPORT ${lower}.`,
  },
  DDLS: {
    ext: 'ddls.acds',
    maxName: 30,
    fields: { sourceOrigin: 'abapDevelopmentTools', sourceType: 'viewEntity' },
    source: ({ name, label }) => `@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: '${label}'
define view entity ${name}
  as select from data_source_name
{
  key field_name as FieldName
}`,
    notes: () => [PLACEHOLDERS],
  },
  DCLS: {
    ext: 'dcls.acds',
    maxName: 30,
    source: ({ name, label }) => `@EndUserText.label: '${label}'
@MappingRole: true
define role ${name} {
  grant
    select
      on
        entity_name
          where
            ( field_name ) = aspect pfcg_auth( authorization_object, authorization_field, ACTVT = '03' );
}`,
    notes: () => [PLACEHOLDERS],
  },
  DDLX: {
    ext: 'ddlx.acds',
    maxName: 30,
    source: () => `@Metadata.layer: #CORE
annotate entity entity_name with
{
  @UI.lineItem: [{ position: 10 }]
  field_name;
}`,
    notes: () => [PLACEHOLDERS],
  },
  BDEF: {
    ext: 'bdef.abdl',
    maxName: 30,
    source: ({ name }) => `managed implementation in class ${poolName(name).toLowerCase()} unique;
strict ( 2 );

define behavior for ${name}
persistent table table_name
lock master
authorization master ( instance )
{
  create;
  update;
  delete;
}`,
    notes: ({ name }) => [
      `a behaviour definition is named after its root entity (ADR-007): ${name} must be the root view entity`,
      `its behaviour pool ${poolName(name)} is a CLAS of its own (\`new --type CLAS\`)`,
      PLACEHOLDERS,
    ],
  },
  SRVD: {
    ext: 'srvd.acds',
    maxName: 30,
    fields: { generalInformation: { sourceOrigin: 'abapDevelopmentTools', sourceType: 'definition' } },
    source: ({ name, label }) => `@EndUserText.label: '${label}'
define service ${name} {
  expose entity_name;
}`,
    notes: () => [PLACEHOLDERS],
  },
  SRVB: {
    maxName: 30,
    fields: {
      bindingType: 'ODATA V4',
      bindingTypeCategory: 'ui',
      services: [{ name: '', versions: [{ serviceVersion: '1.0.0', serviceDefinition: '' }] }],
    },
    notes: () => ['fill in services[0].name and serviceDefinition with the service definition\'s name'],
  },
  // Over REST, not adt-ls (ADR-014): push creates it in the logon language, the file's original language.
  MSAG: {
    maxName: 20,
    fields: { messages: [] },
    logonLanguage: true,
    notes: () => ['add messages as {"number": "001", "text": "…"}: three digits, at most 73 characters'],
  },
  TABL: {
    ext: 'tabl.ddic',
    maxName: 16,
    source: ({ lower, label }) => `@EndUserText.label : '${label}'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table ${lower} {

  key client : abap.clnt not null;
  key id     : abap.numc(8) not null;

}`,
  },
};

/** The types `new` writes skeletons for. */
export const NEW_TYPES = Object.keys(SKELETONS);

/** The usual behaviour pool of a root entity: ZR_TRAVEL → ZBP_R_TRAVEL, /NS/R_X → /NS/BP_R_X. */
export function poolName(entity: string): string {
  const ns = entity.match(/^(\/[^/]+\/)(.+)$/);
  if (ns) return `${ns[1]}BP_${ns[2]}`;
  return `${entity[0]}BP_${entity.slice(1).replace(/^_/, '')}`;
}

/** The `.json` file as adt-ls serves a fresh object, with the system's language version when it isn't standard. */
function metadata(skeleton: Skeleton, description: string, languageVersion: string | undefined, language: string | undefined): string {
  if (skeleton.logonLanguage) {
    return JSON.stringify({ formatVersion: '1', header: { description, originalLanguage: (language ?? 'en').toLowerCase() }, ...skeleton.fields }, null, 2);
  }
  const header: Record<string, string> = { description, originalLanguage: 'en' };
  if (languageVersion === 'cloudDevelopment' || languageVersion === 'keyUser') header.abapLanguageVersion = languageVersion;
  return JSON.stringify({ formatVersion: '1', header, ...(skeleton.fields ?? {}) }, null, 2);
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function newObject(policy: MirrorPolicy, input: NewInput): Promise<NewResult> {
  const type = input.type.toUpperCase();
  const skeleton = SKELETONS[type];
  if (!skeleton) throw new Error(`mirror new can't make a ${type}; it makes ${NEW_TYPES.join(', ')}`);
  const name = input.name.toUpperCase();
  if (!/^(\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`"${input.name}" is not an ABAP object name`);
  if (name.length > skeleton.maxName) throw new Error(`a ${type} name has at most ${skeleton.maxName} characters; ${name} has ${name.length}`);
  if (!isMirrorablePackage(name, policy.namespaces)) {
    throw new Error(`${name} is not a customer name: it starts with Z or Y, or with a namespace in the system's mirror.namespaces`);
  }
  if (type === 'PROG' && input.languageVersion === 'cloudDevelopment') {
    throw new Error('a cloud system has no programs: use a class with if_oo_adt_classrun');
  }
  const description = input.description ?? name;
  if (description.length > 60) throw new Error('a description has at most 60 characters');

  const root = await resolveRoot(input.root, input.workspaceFolders);
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error(`no mirror at ${root}; run \`mirror init\` first`);
  if (manifest.system !== input.system) {
    throw new Error(`${root} mirrors system "${manifest.system}", not "${input.system}"`);
  }

  // The package folder: a root package's own, or where the manifest keeps a subpackage's objects.
  let pkg = input.package?.toUpperCase();
  if (pkg === undefined) {
    if (manifest.packages.length !== 1) throw new Error('the mirror has several root packages; pass --package');
    pkg = manifest.packages[0]!.name;
  }
  const known = Object.values(manifest.objects).find((o) => o.package === pkg);
  const dir = manifest.packages.some((p) => p.name === pkg)
    ? `${SRC_DIR}/${packageFolder(pkg)}`
    : known?.dir;
  if (!dir) {
    throw new Error(`package ${pkg} isn't in this mirror; create it with \`package create\` and pull, or pass one of its packages`);
  }

  const id = objectId(type, name);
  if (manifest.objects[id]) throw new Error(`${id} is already in the mirror (${manifest.objects[id]!.dir})`);
  const base = affName(name).toLowerCase();
  const stem = `${base}.${type.toLowerCase()}.`;
  const clash = (await filesBelow(root, SRC_DIR)).find((rel) => rel.split('/').pop()!.toLowerCase().startsWith(stem));
  if (clash) throw new Error(`${id} already has files in the mirror: ${clash}`);

  const label = description.replace(/'/g, "''");
  const files: Array<[string, string]> = [];
  if (skeleton.ext && skeleton.source) {
    files.push([`${dir}/${base}.${skeleton.ext}`, skeleton.source({ name, lower: name.toLowerCase(), label })]);
  }
  files.push([`${dir}/${base}.${type.toLowerCase()}.json`, metadata(skeleton, description, input.languageVersion, input.language)]);

  const targets: Array<[string, string, string]> = [];
  for (const [rel, text] of files) {
    const target = await safeTarget(root, rel, { mkdir: true });
    if (await exists(target)) throw new Error(`${rel} exists`);
    targets.push([rel, target, text]);
  }
  for (const [, target, text] of targets) await writeFile(target, toLocal(text), { flag: 'wx', mode: 0o644 });

  return { root, object: id, package: pkg, files: targets.map(([rel]) => rel), notes: skeleton.notes?.({ name }) ?? [] };
}
