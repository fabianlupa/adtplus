# Checking a new adt-ls

adt-ls comes with ADT for VS Code (`sapse.adt-vscode`) and updates silently: the SDK runs the
newest installed one. `system status`/`connect` and the daemon's startup log warn when it isn't
`VERIFIED_ADT_LS` (`src/core/adtls-version.ts`, 1.1.2). Before bumping that constant, go through
this list on `onprem` (and `cloud-erp` where a row says so), put the results in the PR that bumps it, and update
the rows that changed.

Add a row whenever adt+ starts relying on adt-ls behaviour that SAP doesn't document: something
read from the jars, a request shape built by hand, an error code or text matched, a workaround in
`known-issues.md` that names adt-ls.

## 1. Smoke run

`npm run smoke -- --system onprem` and `-- --system cloud-erp` (read-only, `docs/testing.md`). It must pass
before the rows below are worth checking.

## 2. Behaviour adt+ relies on

| Behaviour (1.1.2) | Relied on in | How to check | Evidence |
|---|---|---|---|
| `assignTransportToObject` keeps the request on the **one file** its URI names; `writeFile` reads it from the file it writes, and that write uses it up | `mirror/push.ts` (`send` assigns the written file), `transport assign` (assigns each file) | On a throwaway package's objects in no request: assign each file, then write it; the include and `.json` cases need the file's own URI, a second assignment on the main URI doesn't take | — |
| An assignment on a `.properties` nothing has read yet fails ("The Semantic file store doesn't exist") | `transport assign` skips `.properties` | — | same |
| A `checkTransportForObjectLock` between assign and write cancels the assignment | `assignForNextWrite` instead of the SDK's `transport.assign` for objects in no request | — | — |
| A write of an object in no open request fails with code **1001** (thrown by adt-ls, not SAP); a delete of an enclosing object asks with **1003** | `NOT_IN_TRANSPORT` in `capabilities/transport.ts`, push, delete | the probes above show the 1001; a delete of a throwaway class shows the 1003 | same |
| Hand-built requests decoded from the jars: `assignTransportToObject`, `publishServiceBinding` (publish/unpublish), `writeFile` by URI | `capabilities/transport.ts`, `capabilities/object.ts` | smoke (assign), one manual `update` and `publish`/`unpublish` on a throwaway on the jar if a call fails | `src/core/adtls-version.ts` |
| One lock attempt per session at a time ("Another lock attempt is still in progress") | push's lock-busy retry | known-issues entry | [known-issues](known-issues.md) |
| The subtyped search filter finds nothing for `SRVD/SRV`, `BDEF/BDO`, `DDLX/EX`, `NROB/NRO` (the SDK searches the main type) | object search, resolve | `object search --type SRVD/SRV` on `onprem` and `cloud-erp` | [known-issues](known-issues.md) |
| `abapStat` has no version for `.jsonc` stubs | pull's draft flag | pull of `ZADTPLUS_OPENSAP_RAP` on `onprem`: the stubs' draft flag stays unset, no error | [known-issues](known-issues.md) |
| `listInactive` names every object with a draft, for CLAS, PROG, INTF, DDLS, BDEF, TABL, SRVD | pull stats only listed objects of those types (`LISTED_DRAFT_TYPES`) | — | — |
| No change date or ETag passed on | the git helper's stamps over REST (ADR-011) | read an object's metadata through adt-ls: still no `changedAt`/ETag. If there is one now, reconsider the design | [known-issues](known-issues.md) |
| After `abap_atc_execute_deterministic_quickfixes`, `abapStat` still says active while `readFile` serves the fixed, inactive text (`onprem` and `cloud-erp`) | nothing yet: `read`'s `served` is wrong after `applyQuickfixes`; activating clears it | Apply the `ABAP_CLOUD_READINESS` quick fix to a throwaway class with a `MOVE` (writes): `abapStat` says `inactive` once fixed. Then drop the known issue | [objects](tools/objects.md#known-issues) |
| Federated tool answers: `get_schema` refuses with an "Error: …" **result**; `generate_objects` reports a name clash as OK with `validationMessages` and no objects; `abap_atc_get_result` ends a cancelled run with a text; an unknown ATC object gives "Error executing tool: null"; `affectedObjects` names class includes (`ZCL_X====…CS`) | `core/federated.ts`, `capabilities/rap.ts`, `runAtcWorklist`/`applyQuickfixes` in `capabilities/quality.ts` | `ONLY=gen` and `ONLY=atc` runs of  (read-only), the variant run of  (`ABAP_CLOUD_DEVELOPMENT_DEFAULT` on `onprem` was the cancelled one); a clash: `generate` twice on a throwaway table | — |
| An on-prem generator proposal leaves `metadata.package` empty, and `generate_objects` then fails "Package does not exist" | `withPackage` in `capabilities/rap.ts` sets it (it also guards the allowlist, so it stays) | — | same |
| Formatting: adt-ls registers `textDocument/formatting` per document on `didOpen` although its capabilities say `documentFormattingProvider: false`, and formats the text `didOpen` sent; ADT's REST pretty printer formats ABAP, not CDS | `capabilities/format.ts` (engine `sap`) | — | — |

## 3. Upgrade-only reading

- Diff the `adtLs/…` methods of the old jar against the new one's. New methods may retire a REST fallback (`known-issues.md`, "REST
  fallbacks") or a workaround.
- Look up whether the SDK workarounds in `known-issues.md` still apply after an SDK bump; that
  section lists its own "retire when".
