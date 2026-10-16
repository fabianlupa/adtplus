# ADR-002: adt-ls first, REST only as a fallback that retires itself

- Status: accepted 2026-09-17

## Decision

adt+'s engine is adt-ls, driven through `@arc-mcp/adt-ls`: the typed API first, then `raw.lsp` /
`raw.tool` for requests the SDK hasn't wrapped (ADR-004). adt+ calls a system directly only where
adt-ls verifiably lacks the feature, and each such call:

- is tagged `via: "rest-fallback"` in its result;
- states its retirement condition, usually an ADT for VS Code or backend release that ships the
  native path;
- has a runtime probe (`src/core/capabilities.ts`) that reports `nativeAvailable` per session, so
  `adtplus system status` shows when a fallback could retire. Switching to the native path is a
  deliberate code change after a live test, never automatic.

A fallback retires as soon as adt-ls covers the feature in any form adt+ can call: natively, or
through a raw LSP request or federated tool. adt+ doesn't wait for a typed SDK method.

A fallback without a probe yet reports `nativeAvailable: null`, and
[known-issues.md](../known-issues.md#rest-fallbacks) names it. One never gets a probe: formatting
text waits for an SDK release, not a system feature (ADR-017). A call to an unreleased OData UI
service is a fallback of its own kind with stricter terms (ADR-019).

## Rules the REST path keeps

1. Send the ABAP language version on package create (`""` standard, `"2"` key user, `"5"` cloud
   development); re-read and fail on a mismatch.
2. End the stateful context after every lock sequence: reusing it leaves an ENQUEUE lock that
   blocks the next operation.
3. A text change sends `adtcore:masterLanguage` and `adtcore:language`, or `cloud-erp` answers 200
   and keeps the old value. Every edit is verified by reading it back.
4. Never retry a 401 (ADR-001).

## Why

- A hand-built REST client for everything hits the stateful-protocol bugs above; adt-ls already
  handles sessions, locking and XML.
- SAP ships native support for packages, transports and the rest on a different date per system,
  so hardcoding either path would be wrong on one of them. The probe tells which applies.
- A tagged, self-retiring fallback keeps adt+ a stopgap: what SAP ships replaces it piece by piece.

The live list of fallbacks and their retirement conditions: [known-issues.md](../known-issues.md#rest-fallbacks).

## Changes

- 2026-10-15: restated as it holds today for the public release.
