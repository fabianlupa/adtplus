# Object type support

Which ABAP object types each tool can work with, and what it can do with them.
The tools are SAP's **ADT MCP Server**, **adt-ls** (the language server under ADT
for VS Code, reached through `@arc-mcp/adt-ls` and the `abap://` VFS), **adt+**,
and **ADT for Eclipse**. Checked on **2026-09-24** against ADT for VS Code / adt-ls
**1.1.2** on **`onprem`** (S/4HANA 2023 on-prem) and **`cloud-erp`** (S/4HANA Cloud Public); both catalogs'
types probed live on 2026-10-13 (`cloud-erp`,
`onprem`).

For what each tool can do regardless of type, see [capabilities.md](capabilities.md).
For what SAP plans to add to the ADT MCP Server, see
[adt-mcp-server-gaps.md](adt-mcp-server-gaps.md).

## How the four relate

- **The ADT MCP Server is a front end to adt-ls.** Its 20 tools are adt-ls's
  federated tools, and `get_all_creatable_objects` returns exactly the list from
  LSP `getCreatableObjectTypes`. So it never supports a type that adt-ls doesn't.
  It has no read, edit or delete tools; in VS Code, Copilot reads and edits through
  the `abap://` VFS, which is adt-ls too.
- **adt+ calls adt-ls through the SDK**, adds REST for packages and transport
  release (ADR-002), and adds nothing type-specific except SRVB publish.
- **The type list is set by the backend**, not by the client: `onprem` and `cloud-erp` differ
  (below). A new backend or a new adt-ls release can add types without any change
  in adt+.
- **Eclipse** has its own client with form-based editors for classic DDIC and
  other types. On-prem, anything without an Eclipse editor opens in an embedded
  SAP GUI. Public Cloud has no SAP GUI, so there only the native editors exist.

## Legend

**C** create · **R** read · **E** edit source · **A** activate · **D** delete.
A letter alone was verified live; a letter with `*` is listed in a catalog or
schema but was not exercised live; a letter with **✗** was tried live and fails; **—** not
possible; **❓** unknown.
An ADT MCP Server **C** was verified either from Copilot in VS Code or by calling
the same federated `abap_creation-create_object` tool through adt-ls.

**Eclipse** cells are not probed by us. They come from SAP's
[list of development objects with an Eclipse-based editor](https://help.sap.com/docs/abap-cloud/abap-development-tools-user-guide/list-of-development-objects-with-eclipse-based-editor)
(read 2026-09-24): **✓ &lt;release&gt;** is the
first backend release with a native editor (7.xx = NetWeaver/AS ABAP, 18xx–20xx =
S/4HANA). `onprem` is 2023, so a 2025 editor is not there yet. **GUI** means Eclipse
opens the object in an embedded SAP GUI (on-prem only), which is also what happens
to every type the list doesn't name.

**Mirror / git** cells say what a [mirror](tools/mirror.md) does with the type, and
the [git remote helper](tools/git-remote-helper.md) does the same, since it reuses the
mirror's pull and push: **R** pull reads it, **E** push writes its source, **A** push
activates it, **C** push creates a new object of it. **—** not supported, **❓** unknown.
The cells come from those two docs, not from per-type probes; `*` marks what the docs
name but no live run covered for the mirror.

## Source-based and catalog types

These types are in adt-ls's creatable catalog. adt-ls reads and edits them as
files through `fileSystem/readFile` / `writeFile`.

| Type | Systems | ADT MCP Server | adt-ls | adt+ | Mirror / git | Eclipse | Notes |
|---|---|---|---|---|---|---|---|
| CLAS/OC class | both | C A* | C R E A D | C R E A D | R E A C | ✓ 7.4 SP02 | test-class include editable; adt+ also navigate, unit (+coverage), run, ATC. One `onprem` create returned HTTP 500 after succeeding |
| INTF/OI interface | both | C A* | C R E A D | C R E A D | R E A C | ✓ 7.4 SP02 | |
| PROG/P program, PROG/I include | `onprem` only | C* A* | C R E A D | C R E A D | R E A C | ✓ 7.4 SP02 | verified on `onprem` 2026-10-13; not creatable on Public Cloud; an include's syntax check says to pick a master program (information) |
| FUGR/F function group, FUGR/FF function module | both | C* A* | C R E A D | C R E A D | R, push writes but leaves a function module inactive | ✓ 7.4 SP02 | verified on `cloud-erp` and `onprem` 2026-10-13: function module edit, group delete (both fixed in adt+ that day); `mirror check` flags adt-ls's `.func.json`/`.reps.json` (AFF fields missing) |
| FUGR/I function group include | `onprem` only | C* | C R E A D | C R E A D | R, push writes but leaves it inactive | ✓ 7.4 SP02 | verified on `onprem` 2026-10-13; create needs `functionGroup` and `suffix` (`F01`, name `L<group>F01`) and adds the `INCLUDE` to the main program |
| TYPE/DG type group | `onprem` only | C* | C R E A D | C R E A D | R E A | ✓ 7.4 SP08 | verified on `onprem` 2026-10-13; name at most 5 characters |
| TABL/DT database table | both | C A* | C R E A D | C R E A D | R E A C | ✓ 7.52 | verified on both 2026-10-14, with data; the server reformats saved TABL source; an incompatible field change to a table holding data isn't activated (an empty table converts); SAP's database adjustment is reachable as quick fixes, which adt+ doesn't offer yet; a delete drops its data without asking ([objects](tools/objects.md#known-issues)) |
| TABL/DS structure | both | C* A* | C R E A D | C R E A D | R E A | ✓ 7.50 | verified on both 2026-10-13; listed under "Database Tables"; the server reformats saved source |
| DDLS/DF CDS data definition | both | C A* | C R E A D | C R E A D | R E A C | ✓ 7.4 SP02 | CDS navigation: hover and definition only |
| DCLS/DL access control | both | C* A* | C R E A D | C R E A D | R E A C | ✓ 7.4 SP10 | verified on both 2026-10-13 (mirror: R); `protectedEntity` fills the template, whose placeholder conditions don't compile |
| DDLX/EX metadata extension | both | C A* | C R E A D❓ | C E A D❓ | R E A C | ✓ 7.51 | delete needs the source URI; not verified live |
| BDEF/BDO behavior definition | both | C A* | C R E A D* | C R E A D* | R E A C | ✓ 1809 | create needs `behaviorDefinitionType` (`definition`), `rootEntity`; `implementationType` `Managed`/`Projection`/… is case-sensitive |
| SRVD/SRV service definition | both | C A* | C R E A D | C E A D | R E A C | ✓ 1909 | create needs `sourceType: 'S'` (the form says optional) |
| SRVB/SVB service binding | both | C* A*, service info read | C R A D, publish | C A D, **publish/unpublish** | R E A C | ✓ 1909, publish | create needs `serviceDefinition` + exact `bindingType` (`OData V4 - UI`, …); R is the binding's JSON; no MCP publish tool exists, only the LSP request (journal, M6.0) |
| DRAS/RAS CDS aspect | both | C* | C R E A D | C R E A D | R | ✓ **2025** | verified on `cloud-erp` 2026-10-13; a create failed now and then in adt-ls ("`creationAdapter` is null"), cause unknown. `onprem` (2023, ABAP 7.58) predates aspects: adt-ls lists the type and creates an empty shell, but a save fails with a misleading "Insufficient authorization for saving of CDS Aspect" |
| DRTY/STY CDS type | both | C* | C R E A D | C R E A D | R | ✓ 2023 | verified on both 2026-10-13; a create failed now and then in adt-ls ("`creationAdapter` is null"), cause unknown |
| DTEB/DF entity buffer | both | C* | C R E A D | C R E A D | R | ✓ 2022 | verified on both 2026-10-13; named after its entity, `bufferedEntity` fills it in; the entity needs `@AbapCatalog.entityBuffer.definitionAllowed: true` |
| ENQU/DL lock object | both | C* | C R E A D | C R E A D | R E A | ✓ 1809 | verified on both 2026-10-13; AFF JSON; create needs `primaryTable` |
| CHDO/CHD change document object | both | C* | C R E A D | C R E A D | R | ✓ 2022 | verified on both 2026-10-13; AFF JSON; activation generates `ZCL_<name>_CHDO`, the delete removes it |
| NROB/NRO number range object | both | C* | C R E A D | C R E A D | R | ✓ 2020 | verified on both 2026-10-13; the number length domain must be released for the object's ABAP language version: `NUMC10` isn't for ABAP for Cloud Development (`cloud-erp`, or an `onprem` package with that version; `CHAR10` is), standard ABAP takes it |
| NONT/NOT SAP object node type | both | C* | C R E A D | C R E A D | R E A | ✓ 2023 | verified on `cloud-erp` 2026-10-13; a root node carries its object type's name. `onprem`: create ✗, "Unsupported Media Type" from the backend (also 2026-10-02) |
| RONT/ROT SAP object type | both | C* | C R E A D | C R E A D | R | ✓ 2023 | verified on both 2026-10-13; `typeCategory` takes the form's label (`Business Object`) |
| DESD/TYP logical external schema | `cloud-erp` only | C* | C R E A D | C R E A D | R E A | not listed | verified on `cloud-erp` 2026-10-13 |

`*` rows mean the type is in the catalog but we haven't created, read or deleted
one. Expect the per-type creation fields to be the hard part, as with SRVD and
SRVB. `getObjectTypeDetails` lists each type's fields and choice values
(`getCreationForm` has them too since 0.7.0), and `create` checks against it.

## Types outside the catalog

| Type | ADT MCP Server | adt-ls | adt+ | Mirror / git | Eclipse | SAP plan for VS Code |
|---|---|---|---|---|---|---|
| DEVC package | — | R (VFS `*.devck.jsonc`, often stale) | R, validate, C, update, D (REST; AFF `devc-v1` properties, ADR-018) | R (root and subpackages) | ✓ 7.52 | 1.2 (Q4/2026); `cloud-erp` needs 2702 |
| DTEL data element | — | R placeholder only | C, R, update, A, D (REST; AFF `dtel-v1` properties; both verified 2026-10-14) | — (stub) | ✓ 7.50 (form editor) | 1.2 |
| DOMA domain | — | R placeholder only; activate fails ("Internal error.") | C, R, update, A, D (REST; AFF `doma-v1` properties; both verified 2026-10-14) | — (stub) | ✓ 7.51 (form editor) | — |
| MSAG message class | — | R placeholder only; writes rejected | C, R, edit and delete messages, D (REST; `onprem` verified, `cloud-erp` open); no long texts | R E C (REST, ADR-014) | ✓ 7.4 SP04 | 1.2 |
| TTYP table type | — | R placeholder only | — | — (stub) | ✓ 1909 | — |
| XSLT transformation | — | ❓ | — | ❓ | ✓ 7.50 for simple transformations (ST); XSLT programs not listed | 1.2 |
| VIEW (DDIC views), SHLP, TRAN, screens, GUI status, other classic types | — | — | — | — | GUI (external views ✓ 7.4 SP02) | — |

Eclipse also has native editors for types no VS Code tool touches: BAdI
definitions and implementations (ENHS/ENHO, 2022), HTTP services (1909), service
consumption models, event bindings, ATC checks and variants (2022), KTD (2020),
application jobs and logs, IAM objects (AUTH, SUSO, business catalogs), indexes
(2023) and Web Dynpro.

A **placeholder** is a stub file that says "not supported in ABAP development tools
for VS Code", with the object's name, type, description and `adt://` link, but no
content. Writing to one fails or, for DEVC through the VFS, reports success and
changes nothing (seen in the M1 Copilot run).

## Type-independent operations

What works on any object a tool can address:

| Operation | ADT MCP Server | adt-ls | adt+ | Eclipse |
|---|---|---|---|---|
| Activate (batch) | ✓ | ✓ | ✓ with per-phase diagnostics | ✓ |
| Syntax check | — | ✓ stored source | ✓ stored source; unsaved text through REST | ✓ incl. unsaved |
| ATC | ✓ async + quick fixes, AI fix | ✓ sync | ✓ sync, variants | ✓ |
| ABAP Unit | ✓ | ✓ + coverage | ✓ + coverage | ✓ |
| Where-used, definition, hover | — | ✓ ABAP; CDS hover/definition | ✓ same + own-source scan | ✓ |
| Lock status, inactive objects | — | ✓ | ✓ | ✓ |
| Transport find / create / assign | find, create | all three | all three | ✓ |
| Transport release | — | — | ✓ (REST) | ✓ |
| Transport diff | ✓ | ✓ (SDK, unused by adt+) | — | ✓ |
| RAP generators | ✓ (UI service, Web API; `cloud-erp` also `x-ui-service`) | ✓ | — | ✓ |
| Version history | — | active/inactive only | ✓ (REST) | ✓ |

## Keeping this current

- When adt-ls updates (`VERIFIED_ADT_LS` in `core/adtls-version.ts`), diff
  `getCreatableObjectTypes` on both systems against the catalog table.
- A `*` becomes a plain letter only after a live probe on a throwaway object;
  note the probe in the commit message.
- When ADT for VS Code 1.2 ships DTEL, MSAG, XSLT or DEVC, move the row into the
  catalog table and check the REST fallbacks in [known-issues.md](known-issues.md).
