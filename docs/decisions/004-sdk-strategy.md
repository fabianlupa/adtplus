# ADR-004: Use the SDK, upstream what's missing, no reimplementation

- Status: accepted 2026-09-24

## Decision

adt+ stays on the published `@arc-mcp/adt-ls` SDK. When adt+ needs something the SDK lacks or
gets wrong, it goes upstream as an issue or PR.

- **Allowed until upstream ships:** a workaround in adt+: a `raw.lsp` / `raw.tool` call, a tagged
  REST fallback (ADR-002), a retry, a shim around an SDK result, or a documented limitation. Each
  workaround names the upstream item that retires it
  ([known-issues.md](../known-issues.md), "SDK workarounds"; backlog "Upstream").
- **Not allowed:** reimplementing what the SDK does, as a patched fork of the SDK or as adt+'s own
  LSP client, session or resolver layer.

## Why

SDK plus a growing set of local replacements carries the cost of both: two code paths to keep
working, and fixes that reach no other SDK user. Upstream releases have retired local workarounds
before, so the route works.

## Changes

- 2026-10-15: restated as it holds today for the public release.
