import type { AdtLsClient, ObjectRef, ServiceBindingServices, ServiceInfo } from '@arc-mcp/adt-ls';
import type { Destination } from '../core/destinations.js';
import { federatedResult as federated } from '../core/federated.js';
import { lookupPackageChain } from '../core/placement.js';
import { resolveObject } from '../core/resolve.js';
import { assertPackageWritable } from './policy.js';

/**
 * RAP generators and OData service information, through adt-ls's own (federated) tools
 * `abap_generators-*` and `abap_business_services-*`: the same requests SAP's ADT MCP Server
 * offers.
 */

export interface GeneratorSummary {
  id: string;
  title: string;
  /** What the generator starts from, e.g. ["TABL"]; empty when it needs no object. */
  referencedObjectTypes: string[];
  description: string;
}

interface RawGenerator {
  id?: string;
  title?: string;
  description?: string;
  referencedObjectTypes?: string;
}

/** The description is HTML (`<li>`, `<p>`); the agent gets plain text. */
function plainText(html: string): string {
  return html
    .replace(/<li>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export async function listGenerators(adt: AdtLsClient): Promise<{ generators: GeneratorSummary[] }> {
  const dest = adt.health().destination;
  const data = federated(await adt.raw.tool('abap_generators-list_generators', { destination: dest }), 'list generators') as {
    generators?: RawGenerator[];
  };
  return {
    generators: (data?.generators ?? []).map((g) => ({
      id: g.id ?? '',
      title: g.title ?? '',
      referencedObjectTypes: (g.referencedObjectTypes ?? '').split(';').map((t) => t.trim()).filter(Boolean),
      description: plainText(g.description ?? ''),
    })),
  };
}

export interface GeneratorTarget {
  generatorId: string;
  packageName: string;
  /** The object the generator starts from (a table for the OData service generators). */
  referencedObject?: ObjectRef;
}

/** The generator tools take the main type only ("TABL"), an adt+ ref carries "TABL/DT". */
function generatorArgs(adt: AdtLsClient, target: GeneratorTarget): Record<string, string> {
  return {
    destination: adt.health().destination,
    generatorId: target.generatorId,
    packageName: target.packageName.toUpperCase(),
    referencedObjectType: target.referencedObject ? target.referencedObject.objectType.split('/')[0]!.toUpperCase() : '',
    referencedObjectName: target.referencedObject ? target.referencedObject.name.toUpperCase() : '',
  };
}

export interface GeneratorSchemaResult {
  /** JSON schema `content` of `generate` must satisfy. */
  schema: unknown;
  /** The generator's proposal for `content`, names derived from the referenced object, the package set. */
  content: Record<string, unknown>;
}

/**
 * The generator's input schema and its proposed content. An on-prem proposal leaves
 * `metadata.package` empty, and `generate` with it fails "Package does not exist", so adt+
 * fills in the target package.
 */
export async function generatorSchema(adt: AdtLsClient, target: GeneratorTarget): Promise<GeneratorSchemaResult> {
  const data = federated(await adt.raw.tool('abap_generators-get_schema', generatorArgs(adt, target)), 'generator schema') as {
    schema?: unknown;
    referenceContent?: Record<string, unknown>;
  };
  return { schema: data?.schema ?? null, content: withPackage(data?.referenceContent ?? {}, target.packageName) };
}

/**
 * `content` with `metadata.package` set to `packageName`. The generator creates its objects in
 * `metadata.package`, and the allowlist checks `packageName`, so a different one is refused.
 */
function withPackage(content: Record<string, unknown>, packageName: string): Record<string, unknown> {
  const metadata = content.metadata && typeof content.metadata === 'object' ? (content.metadata as Record<string, unknown>) : {};
  const pkg = packageName.toUpperCase();
  const given = typeof metadata.package === 'string' ? metadata.package.trim().toUpperCase() : '';
  if (given && given !== pkg) {
    throw new Error(`content.metadata.package "${given}" differs from package "${pkg}"; the objects would land in the former. Give one package`);
  }
  return { ...content, metadata: { ...metadata, package: pkg } };
}

export interface GenerateInput extends GeneratorTarget {
  /** As `generatorSchema` proposes it, changed where wanted. Omitted: the proposal as it is. */
  content?: Record<string, unknown>;
  transport?: string;
}

export interface GenerateResult {
  generatedObjects: Array<{ name: string; objectType: string }>;
  notes: string[];
}

/**
 * Run a RAP generator into `packageName` (ADR-003: the package must be in the write
 * allowlist). The objects come out active. A name that already exists fails the whole run
 * with nothing created: the tool reports it as `validationMessages`, not as an error.
 */
export async function generate(adt: AdtLsClient, destination: Destination, input: GenerateInput): Promise<GenerateResult> {
  await assertPackageWritable(destination, input.packageName, { lookupChain: lookupPackageChain(adt) });
  const content = withPackage(input.content ?? (await generatorSchema(adt, input)).content, input.packageName);
  const data = federated(
    await adt.raw.tool('abap_generators-generate_objects', {
      ...generatorArgs(adt, input),
      content: JSON.stringify(content),
      transportRequestNumber: input.transport ?? '',
    }),
    'generate',
  ) as {
    validationMessages?: Array<Record<string, unknown>>;
    generatedObjects?: Array<{ objectType?: string; objectName?: string }>;
  };
  const messages = (data?.validationMessages ?? []).flatMap((m) => Object.values(m).map(String));
  const generated = (data?.generatedObjects ?? []).map((o) => ({ name: o.objectName ?? '', objectType: o.objectType ?? '' }));
  if (generated.length === 0) {
    throw new Error(`generate created nothing: ${messages.join('; ') || 'the generator gave no reason'}`);
  }
  return { generatedObjects: generated, notes: messages };
}

export interface ServiceInfoResult extends ServiceBindingServices {
  /** The service URL and entity sets; null while the binding is unpublished. */
  serviceInfo: ServiceInfo | null;
  notes: string[];
}

/**
 * A service binding's OData services, and for a published one its URL and entity sets.
 * The backend reports the publish state for OData V4 only; on V2 an unpublished binding
 * shows as a failed `serviceInfo` read, which goes into the notes.
 */
export async function serviceInfo(adt: AdtLsClient, ref: ObjectRef, service?: string): Promise<ServiceInfoResult> {
  const resolved = await resolveObject(adt, ref);
  const services = await adt.services.listServices(resolved);
  if (services.isPublished === false) {
    return { ...services, serviceInfo: null, notes: [`${ref.name} is not published: publish it (adtplus_object_write publish) for its URL and entity sets`] };
  }
  try {
    return { ...services, serviceInfo: await adt.services.getServiceInfo(resolved, { service }), notes: [] };
  } catch (err) {
    return { ...services, serviceInfo: null, notes: [err instanceof Error ? err.message : String(err)] };
  }
}
