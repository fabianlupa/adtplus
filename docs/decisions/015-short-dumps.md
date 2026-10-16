# ADR-015: Runtime logs through REST — short dumps and gateway errors, one switch per system

- Status: accepted 2026-10-12

## Context

After a failing `adtplus_test` or `adtplus_run` an agent can't see why: the user pastes the dump
from ST22. A failing OData call is the same story with the gateway error log.

adt-ls has no request for runtime feeds. SAP's "MCP Tool for Reading ABAP Feeds" reads them
through the ADT language server on newer backends, so adt-ls gains them there. ADT's feeds answer
on both systems today:

- **Short dumps:** `GET /sap/bc/adt/runtime/dumps` (Atom, newest first, at most 100 entries, a
  user filter, `from`/`to`), one dump's chapters at `/sap/bc/adt/runtime/dump/<id>`. The feed
  lists every user's dumps. A dump's text runs to 200,000 characters, most of it "Selected
  Variables": the values a program held, which is where business data sits.
- **Gateway errors:** `GET /sap/bc/adt/gw/errorlog` (Atom, every user's errors, filter on user,
  service and timestamp), each entry carrying its whole detail as a large HTML summary; one error's
  detail at `/sap/bc/adt/gw/errorlog/<type>/<id>`. Messages can carry application values, as a
  dump's can.

## Decision

- **REST fallbacks** (ADR-002), retiring when adt-ls reads the runtime feeds on that system (one
  `nativeAvailable` probe for both).
- **Off by default. One switch per system for all runtime logs**, `allowRuntimeLogs: true`. A gate
  field for project configs (the trust dialog, ADR-006).
- **Its own tool**, `adtplus_runtime`: `dumps`, `dump`, `gatewayErrors`, `gatewayError` (CLI
  `adtplus runtime dumps|dump|gateway-errors|gateway-error`). Read-only, listed only for systems
  that allow it, its `system` enum holding only those. `ADTPLUS_READONLY` keeps it; `ADTPLUS_DENY`
  takes any action out.
- **Lists are your own by default.** `user` names another user, `"*"` lists everyone's. A list
  returns metadata only (id, time, error, program or service, user), never the summary SAP sends
  with each entry. At most 100 entries, one feed request per call, no paging: a narrower
  `from`/`to` reaches older ones. A time bound adt+ can't read is refused, since SAP ignores one it
  can't parse and answers with the whole feed.
- **One case per call**, by its id from the list.
  - A dump returns its header and the developer chapters (what happened, error analysis, how to
    correct it, where it terminated, the source extract, the active calls). Any other chapter,
    "Selected Variables" among them, only when named. The result names the chapters left out.
  - A gateway error returns its sections as text, the HTML dropped.
  - Both are cut at a size limit, saying so.
- **Call log:** metadata only, no log text (ADR-005).

## Why

- These are the reads an agent needs to fix what it just broke, and adt-ls won't offer them on
  today's backends.
- ADR-005 keeps anything that can reach business data off by default, one case at a time and never
  in bulk; the own-user default and the chapters left out by default keep a read to what debugging
  needs.
- One switch, not one per feed: both logs carry the same kind of data, and the operator's decision
  is the same.

## Consequences

- Traces stay unbuilt (ADR-005).
- System messages (SM02) are operational notices, not runtime logs: they are read through
  `adtplus_system` without a switch (ADR-018).
- Times are reported in UTC, corrected by the measured system clock (ADR-016).

## Changes

- 2026-10-15: restated as it holds today for the public release, with the retired ADRs it absorbed merged in.
