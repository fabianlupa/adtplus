# Capabilities

What adt+ does today, through which backend, and what it doesn't do. One line per action here;
the details (behaviour, limits, cost, known issues) are in one file per area under
[tools/](tools/). Verified against adt-ls `1.1.2.202608131517` on **`onprem`** (S/4HANA 2023 on-prem)
and **`cloud-erp`** (SAP Cloud ERP, i.e. S/4HANA Cloud Public Edition).

## Legend

- Backend: **adt-ls** = typed SDK call · **adt-ls raw** = `raw.lsp` past the SDK · **REST** =
  fallback (ADR-002) · **OData UI** = fallback through SAP's unreleased UI service
  `UI_SMTR_PROJECT` (ADR-019) · **local** = no SAP call.
- Gate: **—** none · **A** write allowlist (ADR-003) · **C** `confirm: true` · **R** `allowRun:
  true` on the system (ADR-005) · **D** `allowDataPreview: true` on the system (ADR-013) · **U** `allowRuntimeLogs: true` on the
  system (ADR-015) · **T** `allowTranslations: true` on the system (ADR-019) · **M** not
  held by a mirror this MCP session used (ADR-009).
- Verified: live-verified on `onprem`, `cloud-erp` or both.
- **Experimental:** works and is tested, but has had far less live use than the rest; behaviour, file
  layout and settings may still change, and a problem is more likely. Today: the mirror
  (`adtplus_mirror`, `adtplus_mirror_write`), the git remote helper, and translations (`object translations`, translation projects `TRPR`: SAP's unreleased UI service, `cloud-erp` only).

## By tool

| Tool | Action | Backend | Gate | Verified | Details |
|---|---|---|---|---|---|
| `adtplus_system` | status / connect | — | — | both | [system](tools/system.md) |
| | messages | REST | — | both (empty on both) | [system](tools/system.md#messages) |
| `adtplus_transport` | list | adt-ls | — | both | [transports](tools/transports.md#list) |
| | find | adt-ls (federated tool) | — | `onprem` | [transports](tools/transports.md#find) |
| | check | adt-ls | — | both | [transports](tools/transports.md#check) |
| | read | REST | — | `onprem` | [transports](tools/transports.md#read) |
| | diff | adt-ls (+ REST) | — | `onprem` | [transports](tools/transports.md#diff) |
| `adtplus_transport_write` | create | adt-ls | A | `onprem` | [transports](tools/transports.md#create) |
| | assign | adt-ls (+ raw) | A | `onprem` | [transports](tools/transports.md#assign) |
| `adtplus_object` | resolve, search | adt-ls | — | both | [objects](tools/objects.md#resolve) |
| | read | adt-ls (MSAG, DEVC, DOMA, DTEL, `version` number: REST; TRPR: OData UI) | — (TRPR: T) | both (MSAG: `onprem`; TRPR: `cloud-erp`) | [objects](tools/objects.md#read) |
| | translations | OData UI | T | `cloud-erp` | [objects](tools/objects.md#translations) |
| | versions | REST | — | both | [objects](tools/objects.md#versions) |
| | diff | REST | — | both | [objects](tools/objects.md#diff) |
| | list, listInactive, lockStatus | adt-ls | — | both | [objects](tools/objects.md#list) |
| | validate (DEVC) | REST | — | both | [packages](tools/packages.md#validate) |
| | generators, generatorSchema | adt-ls (federated tool) | — | both | [objects](tools/objects.md#generators-generatorschema) |
| | serviceInfo | adt-ls | — | both | [objects](tools/objects.md#serviceinfo) |
| `adtplus_object_write` | create | adt-ls (MSAG, DEVC, DOMA, DTEL: REST; TRPR: OData UI) | A (DEVC: superpackage; TRPR: T, A) | both (MSAG: `onprem`; TRPR: `cloud-erp`) | [objects](tools/objects.md#create) |
| | update | adt-ls (MSAG, DEVC, DOMA, DTEL: REST; TRPR: OData UI) | A, M (TRPR: T, A) | both (MSAG: `onprem`; TRPR: `cloud-erp`) | [objects](tools/objects.md#update) |
| | activate | adt-ls (DOMA, DTEL: REST) | A (each ref) | both | [objects](tools/objects.md#activate) |
| | publish, unpublish | adt-ls | A, C | both | [objects](tools/objects.md#publish-unpublish) |
| | generate | adt-ls (federated tool) | A | both | [objects](tools/objects.md#generate) |
| | applyQuickfixes | adt-ls (federated tool) | A, M (each object) | both | [objects](tools/objects.md#applyquickfixes) |
| `adtplus_navigate` | whereUsed | adt-ls + source scan | — | both | [navigate](tools/navigate.md#whereused) |
| | definition, declaration, hover | adt-ls | — | both | [navigate](tools/navigate.md#definition-declaration-hover) |
| | outline, typeHierarchy | adt-ls | — | both | [navigate](tools/navigate.md#outline-typehierarchy) |
| `adtplus_quality` | syntax (`source`: text not saved) | adt-ls (`source`, JSON types: REST) | — | both | [quality](tools/quality.md#syntax) |
| | format (`source`: text not saved) | adt-ls (`source`: REST); `abap-cleaner` engine: local | — | both | [quality](tools/quality.md#format) |
| | atcVariants, atc (`quickfixes`: worklist) | adt-ls | — | both | [quality](tools/quality.md#atcvariants-atc) |
| | abaplint | local | — | both | [quality](tools/quality.md#abaplint) |
| `adtplus_mirror` | init, pull | adt-ls + local | — | both | [mirror](tools/mirror.md#init) |
| | status | local | — | — | [mirror](tools/mirror.md#status) |
| | check | local | — | both | [mirror](tools/mirror.md#check) |
| `adtplus_mirror_write` | push | adt-ls | A (each object) | both | [mirror](tools/mirror.md#push) |
| | activate | adt-ls | A (each object) | both | [mirror](tools/mirror.md#activate) |
| | new | local | — | both | [mirror](tools/mirror.md#new) |
| `adtplus_irreversible` | deleteObject | adt-ls raw (MSAG, DEVC, DOMA, DTEL: REST; TRPR: OData UI) | A (DEVC: superpackage; TRPR: T, A), C | both (MSAG: `onprem`; TRPR: `cloud-erp`) | [objects](tools/objects.md#deleteobject) |
| | deleteMessages | REST | A, C, M | `onprem` | [objects](tools/objects.md#deletemessages) |
| | releaseTransport | REST | C | both | [transports](tools/transports.md#releasetransport) |
| `adtplus_test` | — | adt-ls | A | both | [test and run](tools/test-and-run.md#adtplus_test) |
| `adtplus_run` | — | adt-ls | R, A, C | both | [test and run](tools/test-and-run.md#adtplus_run) |
| `adtplus_data` | — | REST | D | both | [data](tools/data.md) |
| `adtplus_runtime` | dumps, dump, gatewayErrors, gatewayError | REST | U | both | [runtime](tools/runtime.md) |

Names follow [ADR-018](decisions/018-names-and-grouping.md): a daemon command is `<area>.<action>`
(`object.update`, `quality.syntax`; the tools without an action: `test.unit`, `run.application`,
`data.query`), and the CLI is the same in kebab case, `adtplus <area> <action>` (`adtplus object
update`, `adtplus navigate where-used`; `adtplus test`, `adtplus run`, `adtplus data` without one);
`adtplus` without arguments lists them. A package (DEVC/K) and a message class (MSAG/N) are
form-based: `read`, `create` and `update` take their AFF JSON as `properties`
([objects](tools/objects.md#properties)); so are a domain (DOMA/DD), whose `fixedValues` and `fixedValueIntervals` lists replace when sent, and a data element (DTEL/DE). A translation project (TRPR) is form-based too: `read`,
`create`, `update` (its definition and its texts) and `deleteObject`; it and `translations` are
built and verified on `cloud-erp` only. The batch rules shared by `syntax`, `atc` and `abaplint`:
[quality.md](tools/quality.md#batch-checks).

## Git remote helper

**Experimental** (see the legend).

`git clone adtplus::<system>/package/<PKG>` (or `/swc/<SWC>`), fetch and push through the
`git-remote-adtplus` binary (ADR-011), opt-in per system; no MCP tool. Details:
[tools/git-remote-helper.md](tools/git-remote-helper.md).

## Not in adt+

| Missing | Closable on adt-ls? | Elsewhere today |
|---|---|---|
| ATC AI fixes | yes (needs a Joule license) | ADT MCP Server |
| TTYP create, package move | no (ADT for VS Code 1.2 planned for some) | — |
| Message long texts | no | SE91 (Eclipse ADT opens the GUI) |
| Transport delete/reassign/targets | no | SE09 |
| Source code search | no | ARC-1 (on-prem) |
| Traces (profiler, SQL, authorization) | no | ARC-1 |
| Database table adjustment (convert or delete data after an incompatible change) | no (REST quick fixes, backlog "Tables holding data") | Eclipse ADT quick fixes, SE14 (on-prem) |

Ranked by daily use, with the order to build them in: backlog, "Next: gap review 2026-10-10".

## Other channels

- **`abap://` VFS** (ADT for VS Code): reads and edits the source of existing CLAS
  (incl. test classes), INTF, TABL, DDLS, BDEF, DDLX, SRVD. It cannot create
  objects; writes to unsupported types (DEVC, MSAG) report success and change
  nothing; it serves the inactive draft and stale package metadata.
- **ADT MCP Server** (SAP, built into ABAP development tools for VS Code; 20 tools,
  needs VS Code with an ABAP folder open): object creation for 21+ catalog types,
  activation, unit, ATC, transport find/create/diff, RAP generators, quick fixes, service info;
  adt+ covers all of them but the ATC AI fixes (2026-10-11); switched off in the user's
  VS Code since 2026-10-12. No
  annotations, so each distinct tool prompts (one create ≈ 5 prompts). What it
  lacks, SAP's roadmap for it, and adt+'s alternative:
  [adt-mcp-server-gaps.md](adt-mcp-server-gaps.md).

## Copilot routing, last measured

- Not yet measured on the ADR-018 names (`whereUsed`, `syntax` in `adtplus_quality`, packages as
  objects); the numbers below are from the names before.
- Copilot CLI, 7 read prompts × 2 on the 12-tool surface: 14/14 route-green
  (2026-09-22, `gpt-5.6-luna`). Not yet re-run on the current pin `gpt-6-luna`.
- VS Code where-used ("who calls M in class X"): green twice in separate sessions
  (runs 2 and 3, 2026-09-20/22).
- VS Code write flows: a comment edit goes through the VFS and never touches adt+;
  `publishService` (now `publish`/`unpublish`) reaches `adtplus_object_write` and is allowlist-gated.
- Recurrent: Copilot asks which system on every first call (instruction rule 1).
