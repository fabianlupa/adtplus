import { SRC_DIR, abapName, objectId, packageFolder } from './layout.js';
import { msagFileName, parseMsag } from './msag.js';
import type { Manifest } from './manifest.js';

/**
 * New objects in a mirror push (docs/decisions/007-mirror-mode.md, "Push" 4: no
 * creation tiers). Local only: which local files form an
 * object the manifest doesn't know, which package its folder names, and the
 * creation fields adt-ls needs, read from the object's `.json` and source.
 */

/** AFF type → the creation type adt-ls takes (MSAG: the REST path, ADR-014); the types `mirror new` writes skeletons for. */
export const CREATION_TYPES: Record<string, string> = {
  TABL: 'TABL/DT',
  DDLS: 'DDLS/DF',
  DCLS: 'DCLS/DL',
  BDEF: 'BDEF/BDO',
  CLAS: 'CLAS/OC',
  INTF: 'INTF/OI',
  PROG: 'PROG/P',
  DDLX: 'DDLX/EX',
  SRVD: 'SRVD/SRV',
  SRVB: 'SRVB/SVB',
  MSAG: 'MSAG/N',
};

/** The order objects are created in. Any order works (probe 3, P8); this one reads like the stack. */
const ORDER = Object.keys(CREATION_TYPES);

export interface NewObject {
  /** Manifest key: `CLAS ZCL_X`. */
  id: string;
  type: string;
  name: string;
  /** Local folder relative to the mirror root. */
  dir: string;
  /** File name → local text. */
  files: Map<string, string>;
}

export interface CreationInput {
  objectType: string;
  description: string;
  additionalFields?: Record<string, unknown>;
}

/**
 * Files no manifest object owns, grouped into objects by folder and by the
 * `<name>.<type>.` their names start with (`zcl_x.clas.abap` → `CLAS ZCL_X`,
 * `(dmo)x.tabl.ddic` → `TABL /DMO/X`).
 */
export function groupNew(files: Array<{ rel: string; text: string }>): NewObject[] {
  const objects = new Map<string, NewObject>();
  for (const { rel, text } of files) {
    const at = rel.lastIndexOf('/');
    const dir = rel.slice(0, at);
    const file = rel.slice(at + 1);
    const [stem, type] = file.split('.');
    if (!stem || !type) continue;
    const name = abapName(stem);
    const id = objectId(type.toUpperCase(), name);
    const key = `${dir}\0${id}`;
    let object = objects.get(key);
    if (!object) objects.set(key, (object = { id, type: type.toUpperCase(), name, dir, files: new Map() }));
    object.files.set(file, text);
  }
  const rank = (type: string) => (ORDER.includes(type) ? ORDER.indexOf(type) : ORDER.length);
  return [...objects.values()].sort((a, b) => rank(a.type) - rank(b.type) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The source with ABAP/CDS comments removed, for reading the few keywords creation needs. */
function uncommented(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, '')
    .replace(/^\*.*$/gm, '')
    .replace(/".*$/gm, '');
}

const IMPLEMENTATION_TYPES: Record<string, string> = {
  managed: 'Managed',
  unmanaged: 'Unmanaged',
  projection: 'Projection',
  abstract: 'Abstract',
  interface: 'Interface',
};

/** SRVB `.json` `bindingType` + `bindingTypeCategory` → the creation form's value. */
function bindingType(json: Record<string, unknown>): string | undefined {
  const version = String(json.bindingType ?? '').match(/^ODATA (V[24])$/i)?.[1]?.toUpperCase();
  const category = json.bindingTypeCategory === 'ui' ? 'UI' : json.bindingTypeCategory === 'webApi' ? 'Web API' : undefined;
  return version && category ? `OData ${version} - ${category}` : undefined;
}

/**
 * What adt-ls's create takes for a new object, or why it can't be created: the
 * description from the `.json` header, and the fields the creation form needs
 * that only the object's own files say.
 * Everything else comes with the writes after the create.
 */
export function creationInput(object: NewObject): CreationInput | string {
  const objectType = CREATION_TYPES[object.type];
  if (!objectType) {
    return `push can't create a ${object.type}; it creates ${Object.keys(CREATION_TYPES).join(', ')} (others in Eclipse or SAP GUI)`;
  }
  const jsonName = [...object.files.keys()].find((f) => f.toLowerCase().endsWith(`.${object.type.toLowerCase()}.json`));
  if (!jsonName) return `no ${object.type.toLowerCase()}.json: a new object needs its metadata file (\`mirror new\` writes one)`;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(object.files.get(jsonName)!) as Record<string, unknown>;
  } catch (err) {
    return `${jsonName} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  const description = (json.header as { description?: unknown } | undefined)?.description;
  if (typeof description !== 'string' || description.trim() === '') return `${jsonName} has no header.description`;
  if (description.length > 60) return `${jsonName}: header.description has more than 60 characters`;

  const source = [...object.files].find(([f]) => f !== jsonName && !f.endsWith('.json'))?.[1];
  switch (object.type) {
    case 'BDEF': {
      const text = uncommented(source ?? '');
      const kind = text.match(/^\s*(\w+)/)?.[1]?.toLowerCase() ?? '';
      const implementationType = IMPLEMENTATION_TYPES[kind];
      if (!implementationType) {
        return `the behaviour definition starts with "${kind}", not one of ${Object.keys(IMPLEMENTATION_TYPES).join(', ')}`;
      }
      const root = text.match(/define\s+behavior\s+for\s+([\w/]+)/i)?.[1]?.toUpperCase();
      if (!root) return 'no "define behavior for <entity>" in the behaviour definition';
      // SAP names a behaviour definition after its root entity, whatever is asked for (ADR-007).
      if (root !== object.name) return `a behaviour definition is named after its root entity: ${root}, not ${object.name}`;
      return { objectType, description, additionalFields: { behaviorDefinitionType: 'definition', rootEntity: root, implementationType } };
    }
    case 'SRVD':
      return { objectType, description, additionalFields: { sourceType: 'S' } };
    case 'MSAG': {
      // The whole file is checked before the create: its messages are written right after it.
      const file = msagFileName(object.name);
      if (jsonName !== file) return `a message class's file is named ${file}, not ${jsonName}`;
      const parsed = parseMsag(object.files.get(jsonName)!);
      return typeof parsed === 'string' ? `${jsonName}: ${parsed}` : { objectType, description };
    }
    case 'SRVB': {
      const type = bindingType(json);
      if (!type) return `${jsonName}: bindingType "${String(json.bindingType)}" with category "${String(json.bindingTypeCategory)}" is no OData V2/V4 UI or Web API binding`;
      const services = json.services as Array<{ versions?: Array<{ serviceDefinition?: string }> }> | undefined;
      const serviceDefinition = services?.[0]?.versions?.[0]?.serviceDefinition;
      if (!serviceDefinition) return `${jsonName}: services[0].versions[0].serviceDefinition is empty`;
      return { objectType, description, additionalFields: { bindingType: type, serviceDefinition: serviceDefinition.toUpperCase() } };
    }
    default:
      return { objectType, description };
  }
}

/**
 * The package a local folder holds, as far as the mirror knows it: a root
 * package's folder, or a folder the manifest keeps a package's objects in.
 */
export function knownPackage(manifest: Manifest, dir: string): string | undefined {
  const root = manifest.packages.find((p) => `${SRC_DIR}/${packageFolder(p.name)}` === dir);
  if (root) return root.name.toUpperCase();
  return Object.values(manifest.objects).find((o) => o.dir === dir)?.package.toUpperCase();
}

/**
 * The package a folder the manifest doesn't know names, checked against the
 * package's chain on the system: the folders below `src/` must be the end of
 * that chain and start at a root package that mirrors its subpackages, so the
 * next pull puts the object in the same place.
 */
export function folderPackage(manifest: Manifest, dir: string, chain: string[] | undefined): { package: string } | { problem: string } {
  const segments = dir.split('/').slice(1).map(abapName);
  const pkg = segments.at(-1);
  if (dir.split('/')[0] !== SRC_DIR || !pkg) return { problem: `${dir} is no package folder under ${SRC_DIR}/` };
  const root = manifest.packages.find((p) => p.name.toUpperCase() === segments[0]);
  if (!root) return { problem: `${dir}: ${segments[0]} is not a root package of this mirror` };
  if (segments.length > 1 && !root.subpackages) return { problem: `${dir}: the mirror doesn't take ${root.name}'s subpackages` };
  if (!chain) return { problem: `package ${pkg} not found on the system; create it with \`package create\`` };
  const tail = chain.slice(-segments.length).map((c) => c.toUpperCase());
  if (tail.length !== segments.length || tail.some((c, i) => c !== segments[i])) {
    return { problem: `${dir} doesn't match package ${pkg}'s place on the system (${chain.join(' > ')})` };
  }
  return { package: pkg };
}
