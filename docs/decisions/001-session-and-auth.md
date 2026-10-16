# ADR-001: adt+ owns its SAP sessions, held by one daemon per user

- Status: accepted 2026-09-17

## Question

Should adt+ reuse VS Code's ADT session, by federating the ADT MCP server that ADT for VS Code
starts, or own its sessions?

## Decision

**adt+ always owns its sessions: one adt-ls process per system, driven through
`@arc-mcp/adt-ls`, held by one long-lived local daemon per user.** It never federates VS Code's
ADT MCP server.

- **The daemon holds the sessions.** The stdio MCP server, the CLI and the git remote helper are
  thin clients of it over a user-only local socket; the first client starts it. It starts each
  system's adt-ls lazily, logs on again when a session expires, and shuts down after an idle
  timeout. `adtplus system status` shows each system's session.
- **Basic-auth systems (`onprem`):** a headless reentrance logon with the password from the
  Keychain. adt+ appends `sap-client` to the reentrance-ticket request, which adt-ls's logon URL
  lacks.
- **SSO systems (`cloud-erp`):** one browser window per session, for adt-ls and REST together.
  adt+ logs on the REST session first (capture a reentrance ticket on the SSO host, redeem it on
  the API host), then answers adt-ls's browser-logon request with a second ticket minted
  headlessly from that session's cookie. If the cookie can no longer mint, the REST session logs
  on again once (one window) and the request is retried.
- **REST fallbacks** (ADR-002) get their own session: adt-ls's lives inside its JVM and can't be
  shared, and a reentrance ticket is single-use. On Basic-auth systems it is created on the first
  fallback call; on SSO systems it is the logon path. Disposing an idle adt-ls keeps the REST
  cookie jar, so the next connect stays headless.
- **One password attempt per logon.** A failed Basic logon counts against the user's lock
  counter, so a 401 is never retried, by adt+ or by a re-logon.
- **Secrets never pass through a shell:** Keychain values are read with `execFile`, stripping only
  the trailing newline.
- **CA trust has two halves:** the JVM through `connection.extraCaCerts`, Node through its own
  trust store (`extraCaCerts` in `systems.json`).
- The session model stays behind `SessionProvider` (`src/core/session.ts`).

## Why

- **Federation gives too little.** VS Code's ADT MCP server is adt-ls's own federated MCP server,
  started only after an ABAP folder is opened, with the same 20 tools a standalone adt-ls offers.
  None of the LSP-only features (transports, run, package read and write, inactive objects,
  activation results, ABAP Unit coverage, ATC variants) are reachable through it, so adt+ would
  need its own adt-ls anyway. It also exists only while VS Code runs, and terminal agents need a
  session without it.
- **A session can't be persisted.** It lives in the adt-ls JVM and the ticket is single-use, so
  only a long-lived process keeps one. Without the daemon every CLI call would start adt-ls again
  and open a new SSO window.
- **One window, not two:** an SSO user shouldn't log on twice because a call happened to need a
  REST fallback.
- VS Code's virtual file system caches package metadata; adt+'s own session reads current data.

## Consequences

- Each adt-ls process takes about 300 MB while active; with VS Code open the machine runs VS
  Code's adt-ls plus one per system in adt+.
- VS Code's on-premise destination may be RFC, so adt+ keeps its own HTTP URL in `systems.json`.
- Revisit if SAP exposes the LSP-only features as ADT MCP tools, or adds an HTTP passthrough to
  adt-ls.

## Changes

- 2026-10-15: restated as it holds today for the public release.
