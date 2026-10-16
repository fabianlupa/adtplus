# ADT MCP Server gaps vs. SAP roadmap

What SAP's **ADT MCP Server** (built into *ABAP development tools for Visual
Studio Code*, provider `com.sap.adt/mcp`) cannot do today, what SAP has planned,
and what adt+ offers instead. Checked **2026-09-22** against extension 1.1.2 and
SAP Help:
[Model Context Protocol Tools](https://help.sap.com/docs/abap-cloud/abap-development-tools-for-visual-studio-code/mcp-tools)
(the 20 tools today),
[What's New](https://help.sap.com/docs/abap-cloud/abap-development-tools-for-visual-studio-code/what-s-new)
(1.1: no MCP changes), and the ABAP Platform roadmap pages
[AI](https://help.sap.com/docs/abap-cross-product/roadmap-info/genai) (new MCP
tools) and [Tools](https://help.sap.com/docs/abap-cross-product/roadmap-info/tools)
(extension features).
**Re-checked 2026-10-10**: still extension 1.1.2
(Marketplace, 2026-08-14) with the same 20 tools; the MCP Tools page and both roadmap pages
re-read (pasted by the user, the pages don't render for a fetch). Changes since 09-22 are in the
tables below: the docs tool's dates, the feeds tool's route (adt-ls), and new 1.2/1.3 extension
items (SQL Notebook, DTEL apart from MSAG, Dictionary Activation Log, BAdI editors, API state
moved to 2708).

**How SAP ships these.** New **MCP tools** are tied to *backend* releases: SAP BTP
ABAP environment 2611/2702, S/4HANA Cloud **Public** 2702, Cloud **Private** 2027.
On-prem isn't listed, but it gets what Private Edition gets, i.e. S/4HANA
**2027**. So **`cloud-erp` gets them with 2702**, and **`onprem` (S/4HANA 2023) only after an
upgrade to 2027**. New **extension features** ship with ADT for VS
Code 1.2 (Q4/2026) or 1.3 (Q1/2027). They list on-prem backends too: `onprem` ✓, `cloud-erp`
from 2702. They add editors and views, not MCP tools, though each needs a
request in adt-ls that adt+ could use (unprobed until 1.2 ships).

**License.** The MCP Tools page: "Support for the MCP tools is only provided if the
customer possesses a valid SAP Joule for Developers, ABAP AI capabilities license";
tools that need Joule want a Joule logon before the server starts. Token
consumption is "Not required" for all tools but the two ATC AI-fix tools
(`abap_atc_apply_ai_fix`, `abap_atc_get_ai_fix_result`). adt+ calls adt-ls
directly and needs neither.

adt+ route: **adt-ls** = typed SDK call · **adt-ls raw** = LSP request past the
SDK · **REST** = hand-built ADT REST call (fallback, ADR-002) · **local** = no SAP
call.

## Planned as ADT MCP Server tools (AI roadmap)

| Gap | SAP plan (`cloud-erp` / `onprem`) | adt+ today | adt+ route |
|---|---|---|---|
| Object search (incl. reference search) | *MCP Tool for ABAP Object Search*: 2702 / 2027 | `adtplus_object search/resolve/list` | adt-ls (list: adt-ls raw) |
| Read objects | *MCP Tool for Reading ABAP Objects*: 2702 / 2027 | `adtplus_object read` (active or inactive, `method`, `grep`, line ranges) | adt-ls (MSAG: REST) |
| Edit objects | *MCP Tool for Editing ABAP Objects*: 2702 / 2027 | `adtplus_object_write update` | adt-ls raw |
| Syntax check | *MCP Tool for ABAP Syntax Check*: 2702 / 2027 | `adtplus_quality syntax` (stored source; text not saved with `source`) | adt-ls (`source`: REST) |
| Check objects | *MCP Tool for Checking ABAP Objects*: 2702 / 2027 | `adtplus_quality atc`, `syntax` | adt-ls |
| Where-used | *MCP Tool for Where-Used*: 2702 / 2027 (BTP 2702, not 2611) | `adtplus_navigate whereUsed` (+ own-source scan) | adt-ls; scan's active read REST |
| Source code search | *MCP Tool for ABAP Source Code Search*: 2702 / 2027 | none (backlog, on-prem only) | REST planned |
| Short dumps, gateway error log, system messages | *MCP Tool for Reading ABAP Feeds*: 2702 / 2027, "via the ADT Language Server", filtered by time range, user or object | `adtplus_runtime` dumps and gateway errors (opt-in per system, ADR-015); `adtplus_system messages` | REST; adt-ls on 2702/2027 backends |
| Developer documentation | *MCP Tool for Access to Developer Documentation*: 2702 / 2027 (BTP 2611) | none (`mcp-sap-docs`) | — |
| Restrict tools to allowed objects | *Configurable Allow-Lists*: BTP 2611 only; — / — | package write allowlist + `ADTPLUS_DENY` (ADR-003) | local (daemon) |

## Planned as extension features (Tools roadmap)

| Gap | SAP plan (`onprem` / `cloud-erp`) | adt+ today | adt+ route |
|---|---|---|---|
| Packages (DEVC): create, edit, delete | *Create and Manage ABAP Packages*, 1.2 (Q4/2026): ✓ / 2702 | `adtplus_object_write` create/update and `adtplus_irreversible deleteObject` on `DEVC/K`, `adtplus_object validate` | REST |
| Package read | (same item) | `adtplus_object read` on `DEVC/K` | REST |
| Transport release | *Transport Organizer View*, 1.2 (Q4/2026): ✓ / 2702 | `adtplus_irreversible releaseTransport` | REST |
| Version history | *ABAP Timeline View*, 1.2 (Q4/2026): ✓ / 2702 | `adtplus_object versions`, `read` with a version number, `diff`; the same feeds give `transport diff`'s supplement and the git helper's history | REST |
| Message classes (MSAG) | *Create and Manage Message Classes*, 1.2 (Q4/2026), no long texts: ✓ / 2702 | `adtplus_object read`/`create`, `adtplus_object_write update`, `adtplus_irreversible deleteMessages`/`deleteObject`, mirror `.msag.json` | REST |
| Data elements (DTEL) | *Create and Manage Dictionary Data Elements*, 1.2 (Q4/2026): ✓ / 2702 | none (backlog) | — |
| Simple transformations (XSLT) | *Create and Manage Transformations*, 1.2 (Q4/2026): ✓ / 2702 | none | — |
| Table technical settings | *Edit Dictionary Table Technical Settings*, 1.2 (Q4/2026): ✓ / 2702 | none | — |
| Dictionary activation log | *Access to Dictionary Activation Log*, 1.2 (Q4/2026): ✓ / 2702 | none; `activate` reports adt-ls's messages only | — |
| Free SQL, data preview | *SQL Notebook*, 1.2 (Q4/2026): ✓ / 2702 | `adtplus_data` | REST |
| DSFD, DTDC, DTSC, entity indexes, service consumption models | 1.2 (Q4/2026); DTSC on-prem from 2025, entity indexes cloud only | none | — |
| BAdI implementation (ENHO, kernel BAdIs) / definition (ENHS) | 1.2 / 1.3, on-prem from 2022: ✓ / 2702 | none | — |
| SQL CREATE statement of CDS objects | 1.3 (Q1/2027): ✓ / 2702 | none | — |
| API release state (APIS) | *Editor for API State*, 1.3 (Q1/2027): ✓ / **2708** (was 2702 on 09-22) | none | — |
| ATC checks, categories, variants (CHKO, CHKC, CHKV) | 1.3 (Q1/2027): ✓ / 2702 | none (variants listed: `atcVariants`) | — |

## No SAP plan

| Gap | adt+ today | adt+ route |
|---|---|---|
| Domains, table types (DOMA, TTYP) create/edit | none (backlog) | — |
| Transport list (own requests) | `adtplus_transport list` | adt-ls |
| Transport lock check | `adtplus_transport check` | adt-ls |
| Assign an object to a transport | `adtplus_transport_write assign`, verified by lock read-back | adt-ls raw |
| Definition, hover, outline, type hierarchy | `adtplus_navigate` | adt-ls |
| Delete an object | `adtplus_irreversible deleteObject` | adt-ls raw |
| Inactive objects, lock status | `adtplus_object listInactive/lockStatus` | adt-ls |
| Publish / un-publish a service binding (the server only reads service info) | `adtplus_object_write publish`/`unpublish` | adt-ls raw |
| Run a class (`if_oo_adt_classrun`) | `adtplus_run` | adt-ls |
| Table contents, free SQL SELECT (opt-in per system) | `adtplus_data` | REST |
| A transport of any owner, open or released, with its entries | `adtplus_transport read` | REST |
| Pull a package as AFF files, push it back; `git clone adtplus::…` | `adtplus_mirror`, git remote helper | adt-ls (+ REST) |
| ABAP Unit with coverage (the server runs tests without coverage) | `adtplus_test` with `coverage` | adt-ls |
| ATC variant list, synchronous ATC (the server runs ATC asynchronously) | `adtplus_quality atcVariants/atc` | adt-ls |
| Local abaplint | `adtplus_quality abaplint` | local |
| Works without VS Code running with an ABAP folder open | whole tool; own daemon and sessions | — |

## What only the ADT MCP Server has

ATC **AI** fixes (`abap_atc_apply_ai_fix`, `abap_atc_get_ai_fix_result`): they need a Joule
license and cost tokens, so adt+ leaves them out. Everything else of the 20 tools adt+ has since
2026-10-11: RAP generators (`adtplus_object
generators`/`generatorSchema`, `adtplus_object_write generate`), deterministic ATC quick fixes
(`adtplus_quality atc` with `quickfixes`, `adtplus_object_write applyQuickfixes`) and OData
service information (`adtplus_object serviceInfo`). The transport diff
(`abap_transport-unifiedDifference`) is `adtplus_transport diff` since 2026-10-10.

The ADT MCP Server is switched off in the user's VS Code since 2026-10-12; Copilot reaches ABAP
through adt+ alone. This file stays to track SAP's roadmap: when a row lands natively, adt+ may
retire a fallback, and from `cloud-erp`'s 2702 the server may be worth switching back on.

## What this means for adt+

- **`onprem`:** SAP's new MCP tools need S/4HANA 2027, so on 2023 adt+ stays the only
  MCP route for search, navigation, syntax and edits until that upgrade. The
  REST fallbacks for packages and transport release can retire with extension
  1.2, *if* adt-ls exposes them as requests.
- **ADT for VS Code 1.2 (Q4/2026):** probe the new adt-ls before building a REST
  fallback for anything it may bring (DTEL, version history), and check the
  existing fallbacks' retirement conditions (packages, transport release,
  MSAG, data preview, history).
- **`cloud-erp`:** from 2702 the ADT MCP Server covers read, edit, search, syntax,
  where-used and feeds natively. At that point, re-evaluate which `adtplus_*` read
  tools still earn their place.

## Keeping this current

Re-check the four SAP pages when an extension version or a 2611/2702 backend
ships. When SAP covers a row natively:
1. Delete the row; the commit message says what SAP now covers.
2. Check whether adt+'s REST fallback can retire (`adtplus_system` →
   `nativeAvailable`; see [known-issues.md](known-issues.md)).
