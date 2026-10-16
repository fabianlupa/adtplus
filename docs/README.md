# adt+ docs

Three kinds of document, each with its own rule:

| Kind | Files | Rule |
|---|---|---|
| **Current state** | [architecture.md](architecture.md), [capabilities.md](capabilities.md) (index) with one file per area in [tools/](tools/), [clients.md](clients.md), [configuration.md](configuration.md), [adt-mcp-server-gaps.md](adt-mcp-server-gaps.md), [object-types.md](object-types.md), [known-issues.md](known-issues.md), [testing.md](testing.md), [adtls-upgrade.md](adtls-upgrade.md) | Short, rewritten freely, must match the code. Update in the same commit as the change. |
| **Backlog** | [backlog.md](backlog.md) | Open work only. Delete an item when it's done. |
| **Decisions** | [decisions/](decisions/) | One file per decision, stating what holds today and why. Edited in place with a dated `## Changes` line; a reversed decision gets a new ADR (see "Decisions" below). |

The git remote helper (`git clone adtplus::…`, [ADR-011](decisions/011-git-remote-helper.md)):
install and a first example in the [README](../README.md#with-git), what it does in
[tools/git-remote-helper.md](tools/git-remote-helper.md), its settings in
[configuration.md](configuration.md#mirror), its REST fallbacks in
[known-issues.md](known-issues.md#rest-fallbacks).

## Writing current-state docs

- A table cell holds a few words: a name, a backend, a gate, a link. Anything that needs a sentence
  goes in a section below the table, as bullets.
- A tool action is one line in [capabilities.md](capabilities.md) and a section in its area's file
  under [tools/](tools/) (behaviour, limits, cost, known issues). The area files: system, packages,
  transports, objects, navigate, quality, test-and-run, data, mirror, git-remote-helper.
- A known issue of one area goes in that area's file, "Known issues"; SDK workarounds, REST
  fallbacks and behaviour that concerns several areas go in [known-issues.md](known-issues.md),
  which the [adt-ls upgrade checklist](adtls-upgrade.md) walks.
- A backlog item is a few lines with the evidence it needs.
- A plan for a larger piece of work lives in its PR or issue. Open points go into the backlog as
  items of their own, so a plan never has to stay around for them.

## No journal

What a session built, measured or found goes into the doc it changes, the commit message and the
PR text. Findings only, no raw output: probe responses, logs and traces stay in the gitignored
`scratch/`.

## Names

Docs, code comments, tests and live test objects use these names, never a real
system's, customer's or person's (AGENTS.md, "Public repository"). Create the packages and
objects a live test needs under these names on your own systems.

| Name | What |
|---|---|
| `onprem` | system handle: S/4HANA on-premise (2023, ABAP platform 2023, 7.58), Basic auth |
| `cloud-erp` | system handle: SAP Cloud ERP (S/4HANA Cloud Public Edition), SSO / reentrance ticket |
| `cloud-erp-private` | reserved: SAP Cloud ERP Private (S/4HANA Cloud Private Edition) |
| `abap-environment` | reserved: SAP Business AI Platform, ABAP environment (formerly SAP BTP ABAP environment) |
| `DEV` | SID in test data, for every system (`DEVK900001`) |
| `S4H` | system handle and SID in the README's examples only (`S4HK900231`): readers know it as SAP's short form for S/4HANA |
| `ZADTPLUS_TEST` | the package for live tests (allowlisted) |
| `ZADTPLUS_*`, `ZCL_ADTPLUS_*`, `ZIF_ADTPLUS_*`, `ZI_ADTPLUS_*` | packages and objects; `ZADTP_` where a type's length limit needs it (`ZADTP_TB_PROBE`). Only classes and interfaces name their type |
| `DEVELOPER`, client `100` | SAP user and client |
| `my-s4.example.com:44300`, `~/certs/corp-ca.pem` | host and corporate CA |

The handles follow SAP's current product names; SAP renames products more often than the
systems change, so the technical name stays in parentheses. Not `cloud`: abaplint's `Cloud` is a
language version that covers the ABAP environment too.

## Decisions

An ADR states a decision as it holds today, with its reasons; how the feature behaves in detail is
in the current-state doc it links.

- **A refinement** (a default, a scope, a rule added or dropped) edits the ADR in the same commit as
  the code, and adds a dated line under a `## Changes` section at its end: what changed, why, and
  the PR. An ADR edit without that line is a mistake.
- **A reversed or replaced decision** gets a new ADR; the old file shrinks to a stub that names its
  successor, the date and the reason, so its number and links keep working.
- Numbers are not reused once published. A change to the write gates (ADR-003) gets `/code-review high`.

The ADRs were consolidated for the public release: each states its decision as of 2026-10-15,
amendments folded in, and the numbers closed up to 001–020 (the retired ones are gone). Nothing outside the repo linked to the old numbers yet, so they left no stubs; the git history has the earlier texts.

| # | Decision |
|---|---|
| [001](decisions/001-session-and-auth.md) | adt+ owns its SAP sessions: one adt-ls per system, held by one daemon per user; one SSO window for adt-ls and REST together |
| [002](decisions/002-rest-fallbacks.md) | adt-ls first; REST only as a tagged, runtime-probed fallback that retires as soon as adt-ls covers the feature |
| [003](decisions/003-write-gates.md) | Write gates in adt+ itself: package allowlist for every write and execution, `ADTPLUS_DENY`, read-only mode, per-system switches; `confirm` is not a gate |
| [004](decisions/004-sdk-strategy.md) | Use the SDK and upstream what's missing; workarounds yes, reimplementation no |
| [005](decisions/005-api-policy-scope.md) | Development-tooling scope under the SAP API Policy: no endorsement claimed; what can reach business data off by default, the operator's switch per system; reserved clients refused; rate limit, call log, no disguise |
| [006](decisions/006-layered-config.md) | Layered configuration: project `.adtplus/systems.json` on top of the user config, objects merged key by key, approved by content hash in a native dialog |
| [007](decisions/007-mirror-mode.md) | Mirror mode: packages as AFF files, LF locally with hashes over normalized content, push through the gates with a conflict check and `.remote` resolution, one activation |
| [008](decisions/008-budget-in-backend-requests.md) | Load on a system: the budget counts estimated backend requests; bulk work bounded by calls in flight in a lane of its own |
| [009](decisions/009-mirrored-object-write-gate.md) | An MCP session's in-system write is refused on an object a mirror it used holds |
| [010](decisions/010-object-source-read.md) | `adtplus_object read`: source by name through adt-ls, served version reported, active read under an exclusive hold, narrowing cut locally |
| [011](decisions/011-git-remote-helper.md) | Git remote helper `git-remote-adtplus`, opt-in per system: a daemon client on a shadow mirror that takes the system's version; push through the same gates; history from released versions, off by default |
| [012](decisions/012-local-abap-checks-through-abaplint.md) | Local checks: ABAP only through abaplint, additions upstream; errors and likely bugs by default; text rules for RAP files abaplint doesn't parse |
| [013](decisions/013-data-preview.md) | Data preview: free SQL through REST, one `allowDataPreview` switch per system, one SELECT, logon client only, row and size caps, own tool |
| [014](decisions/014-message-classes-in-the-mirror.md) | Message classes in the mirror as AFF `.msag.json`, pulled and pushed through REST; removed messages and a changed description reported, never sent |
| [015](decisions/015-short-dumps.md) | Runtime logs through REST: short dumps and gateway errors, one `allowRuntimeLogs` switch, own by default, metadata-only lists, one case per call |
| [016](decisions/016-system-clock.md) | Every time adt+ reports or takes is UTC: the system clock's and ADT's feed offsets measured per system, uncorrected times noted, never guessed |
| [017](decisions/017-formatting.md) | `quality format`, layout only and never saved: SAP's formatter by default, abap-cleaner opt-in per system; a result whose code changed is refused |
| [018](decisions/018-names-and-grouping.md) | 14 tools, one risk tier each; names after SAP's terms, one name through MCP, daemon and CLI; `update` takes source or the type's AFF JSON, merged by key |
| [019](decisions/019-translations-through-odata-ui-service.md) | Translations through the unreleased OData UI service `UI_SMTR_PROJECT`: `object translations` reads, the project is object type `TRPR`; off by default (`allowTranslations`) |
| [020](decisions/020-evals-outside-the-repo.md) | Evals live outside the repo; `dev/` off the shipped surface; nothing in the repo writes to a system on its own |

Client-side configuration (`mcp.json`, approvals) is in [clients.md](clients.md). Agent
instructions and skills that route work through adt+ are not part of this repo.
