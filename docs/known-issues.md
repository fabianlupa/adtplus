# Known issues

Quirks and workarounds that are live today and concern more than one area: the
SDK workarounds, the REST fallbacks, cross-cutting backend behaviour and
operations. Behaviour of one area is in its file under [tools/](tools/) ("Per
area" below). Each entry says where it lives in the code and when it can go.
When one is fixed, delete it; the commit message records the fix.

## SDK workarounds (`@arc-mcp/adt-ls` 0.7.0, npm)

0.6.1 (2026-09-23) shipped adt-ls#10–#15 and 0.7.0 (2026-10-01) #23–#29; the
rows they covered are gone.

| Issue | Workaround | Where | Retire when |
|---|---|---|---|
| `lifecycle.delete` always deletes the metadata URI | delete the URI `resolveForWrite` found; DDLX takes the source URI | `deleteObject` in `capabilities/object.ts` | the SDK handles DDLX (still unverified live, below) |
| The creation form marks SRVD `sourceType` and SRVB `bindingType` optional though a create fails without them (0.7.0 documents it, doesn't change it) | create checks `additionalFields` against `getObjectTypeDetails` and treats those two as required | `NEEDED_ANYWAY` in `capabilities/object.ts` | the backend's form marks them required |
| The SDK's active read serializes only the SDK's own calls on the object; `raw`, quality and services calls see the temporary switch to active | the daemon holds the object exclusively around the active read, so other commands on it wait | `daemon/objectlock.ts` | the SDK queues every call on the object |
| `basic` retries the ticket GET on every logon request and only logs a failure | `onprem` uses its own `custom` handler: one attempt, a reported failure, and `sap-client` appended by hand | `AdtLsBasicProvider` in `core/session.ts` | `basic` gets a one-attempt guard and reports failures (backlog) |
| `create_transport` refuses a bare object type (`CLAS`: "Failed to read object type info from registry for type CLAS") | `withSubtype` maps the main type to its subtype (`CREATION_TYPES`), refuses one it can't map | `capabilities/transport.ts` | adt-ls takes the main type |
| `onprem` `CLAS/OC` create can return HTTP 500 after succeeding | none (a retry says "already exists") | — | upstream (seen once, not filed) |
| `transport.assign` checks the CTS lock after assigning, and a check before the next write cancels the assignment, so it fails for every object in no open request | `assignForNextWrite`: `raw.lsp` `adtLs/cts/transport/assignTransportToObject` without a read-back; the next write records the object | `capabilities/transport.ts` (`writeAssigning`), `mirror/push.ts`, `capabilities/object.ts` | the SDK offers an assign without the read-back (backlog, upstream) |
| `getGeneratorSchema` returns the tool's refusal ("Error: referencedObjectType is not valid…") as its result; `generateObjects` returns a run that created nothing (`validationMessages`, no objects) as success | the generator calls go through `raw.tool` and `parseFederated`; an "Error:" text and a run with no objects are errors | `capabilities/rap.ts` | the SDK throws on both (upstream) |
| No SDK wrapper for the ATC worklist (`abap_atc_run`, `abap_atc_get_result`) or `abap_atc_execute_deterministic_quickfixes` | `raw.tool` with `parseFederated`, polling the result | `runAtcWorklist`, `applyQuickfixes` in `capabilities/quality.ts` | the SDK wraps them (upstream) |

## REST fallbacks

All tagged `via: "rest-fallback"` (ADR-002). Probed at runtime (`nativeAvailable`,
`src/core/capabilities.ts`) except the git helper's `swc.packages`, `history.versions` and
`history.released`, `transport diff`'s supplement and `object versions`/`diff`, which have no probe yet
and report `nativeAvailable: null`.

Every REST request, the OData UI calls included, has 120 s for SAP's whole answer, its CSRF
fetch and a retry after a CSRF rejection included (`restTimeout`,
[configuration](configuration.md#rest-timeout); `src/backends/rawadt.ts`). A request that runs
out is given up with "got no answer from SAP within 120 s". A write that
timed out after it was sent counts as written, so it is never sent again after a logon; its
message says SAP may or may not have done it, and the translation writes report an unknown
outcome. A CSRF fetch that timed out sent nothing, and they say so. A command counts its
timeouts (`withTimeout`): one while no REST request of the command got an answer is "quiet", and
a quiet one that follows another (during its wait, or within 5 s before it began) ends a loop
over objects as a throttle does, since SAP answered nothing for two waits in a row (`object versions` keeps the includes it read; the git helper's stamps, history,
component lookup and a pull's message classes end the call). Any answer starts the count again,
so objects that hang while others are answered cost only themselves.

| Action | Retire when |
|---|---|
| packages (`DEVC/K`: object read, validate, create, update, delete) | adt-ls lists `DEVC/*` as creatable (ADT for VS Code 1.2; `cloud-erp` needs Cloud 2702) |
| transport release | adt-ls offers a release request (ADT for VS Code 1.2, Q4/2026, "Transport Organizer View"; `cloud-erp` needs 2702) |
| change stamps for the git helper's fetch (`mirror.changes`: info-system search per package, object metadata `adtcore:changedAt`; ADR-011) | adt-ls gives change dates or ETags |
| software component → root packages for the git helper's `swc/` addresses (`swc.packages`: package read, info-system search `comp=`, one package read per package; ADR-011) | adt-ls searches by software component |
| transport history for the git helper (`history.versions`: the version feed per source file, `…/versions`, each released version's content, one request read per request for its owner; ADR-011) | adt-ls exposes version history (ADT for VS Code 1.2 "Timeline View", if it does) |
| object version history (`object versions`, `object diff`, `object read` with a version number: the source file's version feed, `…/versions`, and a version's content; `capabilities/versions.ts`) | adt-ls exposes version history (ADT for VS Code 1.2 "Timeline View", if it does) |
| transport read (`cts/transportrequests/<id>`: header, tasks, entries of any owner's request, open or released) | adt-ls reads a request's objects (its LSP search lists modifiable requests only, without objects) |
| transport diff's supplement (the version feed of each source file the request names, the versions it compares; see "transport.getDiff" below) | adt-ls's `getDiff` diffs every include of a whole-object entry and the objects deleted since (no runtime signal: the tool is the same; a live check) |
| syntax check of text not saved (`quality syntax` with `source`: `POST /sap/bc/adt/checkruns`, the text as artifact) | adt-ls checks other text than the stored source (1.1.2 checks the stored source only, `didOpen`/`didChange` with other text included), or offers a syntax tool (SAP's "MCP Tool for ABAP Syntax Check", 2702/2027; `nativeAvailable` checks the tool list) |
| syntax check of the JSON types CHDO, NROB, RONT, NONT, DESD (`quality syntax`, stored or `source`: the same check run, `application/json`; the stored check without artifact, `active` when there is no inactive version; `checksThroughCheckRun` in `capabilities/checkrun.ts`) | adt-ls checks them: 1.1.2 answers "Json factory must be set as load option" and checks nothing. No runtime probe (`nativeAvailable: null`): after an adt-ls update, `quality syntax` with `--refs` of the probe objects in `ZADTPLUS_OBJTYPES` (`cloud-erp`), the native route switched back on in a scratch build |
| formatting text not saved, engine `sap` (`quality format` with `source`: `POST /sap/bc/adt/abapsource/prettyprinter`, ABAP only; ADR-017) | the SDK's `format` takes text: adt-ls formats the text `didOpen` sends (1.1.2, `onprem` and `cloud-erp`), but the SDK sends only the stored source and `raw.lsp` sends no notifications. No runtime probe (`nativeAvailable: null`): the `adtls-upgrade.md` checklist checks the SDK |
| data preview (`adtplus_data`, `data.query`: `POST /sap/bc/adt/datapreview/freestyle`; ADR-013) | adt-ls bundles a data preview plug-in or offers an SQL tool (1.1.2 has neither; `nativeAvailable` checks the tool list; ADT for VS Code 1.2 plans an "SQL Notebook", `onprem` included, `cloud-erp` needs 2702) |
| runtime logs (`adtplus_runtime`: short dumps `GET /sap/bc/adt/runtime/dumps`, `…/runtime/dump/<id>` and its `/formatted` text, ADR-015; gateway errors `…/gw/errorlog` and `…/gw/errorlog/<id>`, system messages `…/runtime/systemmessages`, ADR-015) | adt-ls reads the runtime feeds (SAP's "MCP Tool for Reading ABAP Feeds" reads them "via the ADT Language Server": `cloud-erp` from 2702, `onprem` with S/4HANA 2027; `nativeAvailable` checks the tool list) |
| message classes (`/sap/bc/adt/messageclass`: read, create, change and delete messages, delete; `object read`/`create`/`update`/`deleteMessages`/`delete` for `MSAG/N`; in a mirror as `.msag.json`, pulled and pushed, ADR-014) | adt-ls lists `MSAG/*` as creatable (ADT for VS Code 1.2 plans "Create and Manage Message Classes", without long texts; `cloud-erp` needs 2702) |
| domains (`/sap/bc/adt/ddic/domains`: read, create, update, delete; `object read`/`create`/`update`/`delete` for `DOMA/DD`; their activation through `POST /sap/bc/adt/activation`, since adt-ls's answers "Internal error."; `capabilities/domain.ts`, `rest-form-object.ts`, `rest-activation.ts`) | adt-ls lists `DOMA/*` as creatable and activates a domain (SAP plans neither for ADT for VS Code 1.2) |
| data elements (`/sap/bc/adt/ddic/dataelements`: read, create, update, delete; `object read`/`create`/`update`/`delete` for `DTEL/DE`; their activation in the domains' REST request; `capabilities/dataelement.ts`, `rest-form-object.ts`) | adt-ls lists `DTEL/*` as creatable (`NativeSupport.dataElement`; SAP plans DTEL for ADT for VS Code 1.2) |
| requests released since the last fetch (`history.released`: `cts/transportrequests?user=*&targets=false`, the last two weeks, all owners; ADR-011) | adt-ls lists released requests (ADT for VS Code 1.2 "Transport Organizer View"; its LSP search lists modifiable requests only) |

## OData UI fallback

Tagged `via: "odata-ui"` (ADR-019): calls to `UI_SMTR_PROJECT`, the unreleased OData V2 UI service
behind SAP's Fiori app "Maintain Translations" (F4950), on the REST fallback's session (cookies,
CSRF token, `sap-language`, rate limit), with adt+'s own user agent. Off unless the system sets
`allowTranslations` ([configuration](configuration.md#translations-off-by-default)).
`src/backends/odata-ui.ts`, `src/capabilities/translations.ts`.

| Action | Retire when |
|---|---|
| translations and translation projects (`object translations`; `object read` and `update` on `TRPR`) | SAP releases an API for translations (a released OData service, or ADT support adt-ls can reach), or adt-ls serves AFF translation files (`.i18n.<lang>.properties`) that tell outdated from current |

- **No `nativeAvailable` probe:** there is nothing to look for. The service check takes its
  place: `$metadata` once per REST session, checked against the entity sets, properties, function
  imports and parameters adt+ calls, with their types (a new parameter that isn't nullable counts
  too). On a mismatch every translation call refuses with "`UI_SMTR_PROJECT` changed on
  <system>: …"; `system status` shows the last check. adt+ never switches to other calls.
- **App versions seen:** F4950 100.39.2 on `onprem`, 2608.0.0 on `cloud-erp`, with the same entity types,
  complex types and function imports. Adapting to a change is a code change after a live probe,
  recorded here with the version.
- An answer SAP hasn't given before (another status, a body that isn't OData JSON, a redirect) is
  an error with the raw text, never a success. A 401 re-logs on like any REST call.

## adt-ls / backend behaviour (cross-cutting)

### System clock

ADR-016, `core/clock.ts`. SAP's times come in two scales that name no zone: the system clock (CTS:
a request's `lastchanged_timestamp`) and ADT's feed times, labelled UTC (version feeds, dumps and
their filter, system messages: local date and time converted with SAP's configured zone). `onprem`
(2026-10-12): the clock 60 minutes ahead of UTC, the feeds 60 minutes behind (converted with two
hours); `cloud-erp`: both UTC. The gateway error log keeps real UTC and is left as it is. System message
entries are corrected like the feed's own time, unverified with an entry (none on either system). adt+
measures both per system (2 requests, each scale on its own, kept an hour) and reports UTC; a
scale that didn't measure leaves its times as sent, with a note. Today's offsets go for every past time, so a time from the other
side of a daylight-saving change can be an hour off; recheck `onprem`'s offsets after 2026-10-25.
Retire a scale's correction when SAP reports it in UTC (its offset then measures 0).

- **adt-ls's subtyped search filter finds nothing for `SRVD/SRV`, `BDEF/BDO`,
  `DDLX/EX` and `NROB/NRO`.** The SDK searches these four by their main type
  since 0.7.0 (each is the only subtype of it), so `object search --type
  SRVD/SRV` works. `cloud-erp`'s `SIA6/SIA` also came back empty, but that subtype id is
  unconfirmed and not in the SDK's list: search by the main type there. On `onprem`
  (2026-10-13) `DRTY/STY`, `DTEB/DF`, `CHDO/CHD`, `RONT/ROT` and `DRAS/RAS` find
  nothing too: adt+ searches these five by their main type, each its only
  subtype (`core/search-type.ts`, `object search` and `quality syntax`'s check
  run). Retire with the SDK's list once it takes them (backlog).
- **An adt-ls session that dies holding a lock leaves the object locked for
  other sessions** (`onprem`, 2026-10-01).
  The lock came from `fileSystem/lockFile` followed by dispose. Afterwards the
  daemon's writes and deletes were refused for 25+ minutes with "User … is
  currently editing …", and `object lockStatus` showed no lock. The user's
  VS Code editor could still enter edit mode; after that the daemon's delete
  went through. adt+ itself never calls `lockFile`. Its writes lock and unlock
  inside one adt-ls call, so this matters for a future push that holds a lock
  across calls. Workaround: open the object in edit mode in VS Code (or SM12
  on-prem), then retry.
- **adt-ls passes on no change date or ETag.** The system sends
  `ETag`/`Last-Modified` and has `adtcore:changedAt`, but no LSP method returns
  them; `fileSystem/stat`'s `mtime` is the fetch time (probe 1, probe 3).
  Mirror mode therefore detects changes by content hash: a fresh read per
  file before a push writes it, and a read per file for a re-pull (ADR-007).
  **When adt-ls exposes either, reconsider that design** (cheaper re-pull,
  conflict check without a content read).
- **`abapStat` has no version for `.jsonc` stubs** ("abapStat returned no
  version for …", `onprem`, every stub type in `ZADTPLUS_OPENSAP_RAP`). A mirror pull
  doesn't ask for stubs and leaves the draft flag unset when `abapStat` fails
  (`mirror/pull.ts`). Retire when adt-ls answers for stubs.
- **An object in no open request can't be confirmed in a request before its next
  write** (`onprem`):
  `assignTransportToObject` takes effect only with the next write, and a
  `checkTransportForObjectLock` before that write cancels it (SDK workarounds
  above). `transport assign` therefore answers `assigned: "onNextWrite"` for such
  an object, and a wrong request (missing, not modifiable) shows only at that
  write. The assignment holds for the one file its URI names, and only for that
  file's next write: adt-ls 1.1.2 keeps it in that file's lock result and
  `writeFile` reads it from the file it writes, so an assignment on a class's
  main source doesn't reach an include or the `.json`. A write SAP records
  nothing for (an unchanged `.clas.abap`) leaves the object in no request.
  `mirror push --transport <TR>`, `object update` and `object delete` with a
  transport therefore assign on the written file's 1001, naming that file, and
  write again, per file (a delete also assigns the main source, as the probe
  did); `transport assign` assigns every
  file adt+ writes (not `.properties`: adt-ls refuses one nothing has read yet). A
  file's assignment stays in the adt-ls session until that file's next write, also
  after another file's write recorded the object: a file written much later, even
  without a transport, goes to that request, or fails with SAP's error if it was
  released meanwhile (not push's "pass a transport"). A daemon restart clears it. `onprem`'s
  CTS check answers `isRecordingRequired: false` for an object already locked in an
  open request, so `transport assign` takes "records no changes" only with no lock.
  Deletes the same way, plus code 1003 ("deletion of the enclosing object
  needs to be confirmed") answered with `force`: the SDK's `repository.delete`
  always sends `force: true`, so adt+ never sees a 1003. The 1001 path of
  `object delete` is unit-tested only, not run live yet.
- **adt-ls takes one lock attempt per session at a time**: a write while another
  write of the same session is locking fails with "Object cannot be locked: Another
  lock attempt is still in progress" (`onprem`, M3 live, a `.ddls.json` write next to a
  class write). Mirror push writes one object at a time and tries such a write up to
  three more times (0.5, 1, 1.5 s apart), since another client's write on the shared
  session can still collide (`mirror/push.ts`). Other writes (`object update`
  and the rest) get no retry: the fix belongs in the SDK (backlog, upstream). Retire
  when the SDK or adt-ls queues lock attempts itself.

## Per area

Behaviour that concerns one area is in that area's file under [tools/](tools/), section "Known
issues": [objects](tools/objects.md#known-issues) (message classes, activation, class frame
comments, publishing), [packages](tools/packages.md#known-issues),
[transports](tools/transports.md#known-issues) (`getDiff`), [navigate](tools/navigate.md#known-issues),
[quality](tools/quality.md#known-issues), [mirror](tools/mirror.md#known-issues) (and
[abaplint on AFF files](tools/mirror.md#abaplint-on-aff-files)),
[git remote helper](tools/git-remote-helper.md#known-issues).

## Operations

- **The restart handshake covers build and config, not the environment or
  adt-ls.** A running daemon is replaced after a rebuild or a config save, but not
  when the client's environment changes (next entry) or adt-ls updates (below).
  The VS Code MCP server process itself keeps its old code until restarted there.
- **The daemon inherits the first client's environment.** `ADTPLUS_DENY` or
  `ADTPLUS_READONLY` set in VS Code's `mcp.json` would then apply to every client
  until the daemon idles out. Latent: neither is set in `mcp.json` today.
- **VS Code caches tool schemas.** After a surface change, restart the MCP server
  in VS Code, or calls fail its client-side validation ("must NOT have additional
  properties").
- **The rate limit counts estimated backend requests, not real ones**
  (ADR-008). adt-ls reports no request count, so each SDK method weighs what the
  probes traced for it; untraced methods (ATC, ABAP Unit, navigation, delete,
  the active-version read) weigh 3 and may cost more. The native-support probe
  (once per session) and the logon aren't counted (`daemon/ratelimit.ts`).
- **A 429/503 from adt-ls is detected from the error text only** (`HTTP/1.1
  429`, `Too Many Requests`, `Service Unavailable`). This hasn't been seen
  live. A REST 429/503 is read from the status and `Retry-After`.
- **The MCP server reads `allowRun` at its start and when the workspace folders
  change, not when a file changes.** The daemon enforces a new value in
  `systems.json` or a project config (or a new approval) at once, but the MCP
  server's tool list (whether `adtplus_run` is there, and for which systems) stays
  as it was until the MCP server restarts or the workspace folders change.
- **adt-ls updates silently.** The SDK uses the newest installed `sapse.adt-vscode`
  and checks only a minimum version; several calls rely on request shapes read from
  the 1.1.2 jars. An extension update (1.2 is due Q4/2026) changes adt-ls under adt+.
  adt+ now notices: `system status`/`connect` and the daemon's startup log warn when adt-ls
  isn't `VERIFIED_ADT_LS` (1.1.2, `core/adtls-version.ts`). Nothing is blocked; go
  through [adtls-upgrade.md](adtls-upgrade.md) (smoke run on both systems, then the
  behaviour adt+ relies on), then bump the constant.
- **No VPN reads as a logon failure.** Without the VPN, `connect` on `onprem` fails
  with "Logon to adtplus_onprem did not reach 'connected' (no logon result)" — nothing
  says the host is unreachable. Check the VPN first. The SDK's logon drops the network
  cause; an upstream item (backlog), no adt+ host probe.
- **Cold start** can occasionally exceed the spawn wait (seen once after a network
  drop; a measured cold start is ~1.3 s).
