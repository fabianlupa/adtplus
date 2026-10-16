import { decodeXml, escapeXml, startTags, xmlAttr, type RawAdtClient } from '../backends/rawadt.js';
import type { ActivateBatchResult } from './object.js';

// --- REST fallback: activation -------------------------------------------------------------
//
// For the types adt-ls can't activate (a domain: "Internal error."), ADT's own activation:
//   POST /sap/bc/adt/activation?method=activate&preauditRequested=true
//        <adtcore:objectReferences><adtcore:objectReference adtcore:uri= adtcore:name=/>…
//   → chkl:messages: chkl:properties checkExecuted/activationExecuted/generationExecuted, then one
//     msg per finding: type E/W/I, objDescr ("DOMA ZADTPLUS_X"), href (the object's URI), shortText/txt.
// The result has activateUris' shape; a diagnostic names the object's ADT URI instead of a file.

/** An object to activate: its ADT URI and name, and how to read which version it has now. */
export interface RestActivationObject {
  uri: string;
  name: string;
  /** `DOMA ZADTPLUS_X`, as SAP's messages name it. */
  object: string;
  /** `active`, `inactive`, `new`; undefined when it is gone. */
  version: (rest: RawAdtClient) => Promise<string | undefined>;
}

/** LSP severities, as adt-ls's activation reports them. */
const SEVERITY: Record<string, number> = { E: 1, A: 1, X: 1, W: 2, I: 3, S: 3 };

export function buildActivationXml(objects: RestActivationObject[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    objects.map((o) => `<adtcore:objectReference adtcore:uri="${escapeXml(o.uri)}" adtcore:name="${escapeXml(o.name.toUpperCase())}"/>`).join('') +
    '</adtcore:objectReferences>'
  );
}

/** SAP's answer as `activateUris` gives it; one without `chkl:properties` (an inactive-objects list asking for a choice, say) activated nothing adt+ can tell, so it is an error. */
export function parseActivationXml(xml: string): ActivateBatchResult {
  const props = xml.match(startTags('chkl:properties'))?.[0];
  if (!props) throw new Error(`activate: SAP answered without an activation result, so nothing is known to be activated: ${xml.slice(0, 300)}`);
  const flag = (name: string) => xmlAttr(props, name) === 'true';
  const byObject = new Map<string, { uri: string | null; object: string; diagnostic: Array<{ severity: number; source: string; message: string }> }>();
  for (const [msg = ''] of xml.matchAll(/<msg\b[\s\S]*?<\/msg>/g)) {
    const head = msg.match(startTags('msg'))![0];
    const uri = xmlAttr(head, 'href') || null;
    const object = xmlAttr(head, 'objDescr') ?? '';
    const message = [...msg.matchAll(/<txt>([\s\S]*?)<\/txt>/g)].map(([, t]) => decodeXml(t!.trim())).join(' ');
    const key = `${uri ?? ''}|${object}`;
    const entry = byObject.get(key) ?? { uri, object, diagnostic: [] };
    entry.diagnostic.push({ severity: SEVERITY[xmlAttr(head, 'type') ?? ''] ?? 1, source: 'abapActivation', message });
    byObject.set(key, entry);
  }
  return {
    checkExecuted: flag('checkExecuted'),
    activationExecuted: flag('activationExecuted'),
    generationExecuted: flag('generationExecuted'),
    diagnostics: [...byObject.values()],
    refreshedUris: [],
  };
}

/**
 * Activate `objects` in one request; the caller has gated them. SAP's force flag on this route is
 * unknown, so there is none. SAP's `activationExecuted` doesn't say whether each object activated:
 * a cancelled data element answers "true", and an object that did activate can come with an error
 * ("became active despite inconsistent references"). So each object's version is read afterwards,
 * and one still inactive makes it false, with an error naming it.
 */
export async function activateRest(rest: RawAdtClient, objects: RestActivationObject[]): Promise<ActivateBatchResult> {
  const res = await rest.expectOk('POST', '/sap/bc/adt/activation', 'activate', {
    query: { method: 'activate', preauditRequested: 'true' },
    headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
    body: buildActivationXml(objects),
  });
  const result = parseActivationXml(res.body);
  // SAP has activated by now: a read that fails leaves the object's state unknown (a warning), never the call failed.
  const versions = await Promise.all(objects.map((o) => o.version(rest).then((v) => v ?? 'gone', () => undefined)));
  const diagnostics = result.diagnostics as Array<{ uri: string | null; object: string; diagnostic: unknown[] }>;
  const add = (o: RestActivationObject, severity: number, message: string) => {
    const entry = diagnostics.find((d) => d.uri === o.uri && d.object === o.object);
    const finding = { severity, source: 'abapActivation', message };
    if (entry) entry.diagnostic.push(finding);
    else diagnostics.push({ uri: o.uri, object: o.object, diagnostic: [finding] });
  };
  let inactive = false;
  objects.forEach((o, i) => {
    if (versions[i] === undefined) add(o, 2, `${o.object}: its version could not be read after the activation; read it to see whether it is active`);
    else if (versions[i] !== 'active') {
      inactive = true;
      add(o, 1, `${o.object} is not active after the activation`);
    }
  });
  return { ...result, activationExecuted: result.activationExecuted && !inactive, diagnostics };
}
