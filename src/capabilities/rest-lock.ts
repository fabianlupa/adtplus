import { decodeXml, type RawAdtClient } from '../backends/rawadt.js';
import { readPackageDefinition } from './package.js';

// --- REST fallback: the lock sequence of a form-based object ----------------------------------
//
// ADT's lock protocol, the same for every object it serves over REST (message classes, domains):
//   POST {uri}?_action=LOCK&accessMode=MODIFY&corrNr=   (answers the object's request in CORRNR)
//   PUT|DELETE {uri}?lockHandle=&corrNr=
//   POST {uri}?_action=UNLOCK&lockHandle=
// The lock handle lives in the server-side session, so the three run in one stateful context.

const LOCK_RESULT_MEDIA_TYPE = 'application/vnd.sap.as+xml;dataname=com.sap.adt.lock.Result';

/** What a locked write needs to know of its object; `kind` names it in messages (`message class`, `domain`). */
export interface LockedObject {
  kind: string;
  name: string;
  uri: string;
  package: string;
}

/** A package recording changes needs a request for every change of an object in it. */
export async function assertRecordable(rest: RawAdtClient, pkg: string, kind: string, what: string): Promise<void> {
  const definition = await readPackageDefinition(rest, pkg);
  if (definition?.recordChanges !== false) {
    throw new Error(
      `${what}: package ${pkg} records changes and no request holds the ${kind}; pass "transport" ` +
        `(CLI --transport), the request to record it in. Without one SAP would write it unrecorded`,
    );
  }
}

/**
 * Lock the object, `send`, unlock: one sequence in a stateful context of its own. Returns the
 * request the change went to: `transport`, else the one SAP's lock names. With neither, an object
 * in a package that records changes is refused before anything is sent.
 */
export async function writeLocked(
  rest: RawAdtClient,
  object: LockedObject,
  transport: string | undefined,
  send: (lockHandle: string, corrNr: string) => Promise<unknown>,
): Promise<string> {
  const { kind, name, uri } = object;
  return rest.stateful(async () => {
    const lock = await rest.expectOk('POST', uri, `lock ${kind} ${name}`, {
      stateful: true,
      changesNothing: true,
      query: { _action: 'LOCK', accessMode: 'MODIFY', corrNr: transport ?? '' },
      headers: { Accept: LOCK_RESULT_MEDIA_TYPE },
    });
    const handle = lock.body.match(/<LOCK_HANDLE>([\s\S]*?)<\/LOCK_HANDLE>/)?.[1]?.trim();
    if (!handle) throw new Error(`lock ${kind} ${name}: no LOCK_HANDLE in response`);
    const corrNr = transport ?? lock.body.match(/<CORRNR>([\s\S]*?)<\/CORRNR>/)?.[1]?.trim() ?? '';
    try {
      if (!corrNr) await assertRecordable(rest, object.package, kind, `${kind} ${name} not written`);
      await send(handle, corrNr);
    } finally {
      await rest.request('POST', uri, { stateful: true, changesNothing: true, query: { _action: 'UNLOCK', lockHandle: handle } }).catch(() => undefined);
    }
    return corrNr;
  });
}

/** SAP's text from a refused name check (`…/validation`, an `exc:exception`), else the start of the body. */
export function validationMessage(body: string): string {
  const message = body.match(/<localizedMessage[^>]*>([\s\S]*?)<\/localizedMessage>/)?.[1];
  return message === undefined ? body.slice(0, 300) : decodeXml(message.trim());
}
