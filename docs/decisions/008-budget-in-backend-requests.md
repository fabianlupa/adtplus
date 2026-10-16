# ADR-008: Load on a system — a budget in backend requests, bulk work bounded by calls in flight

- Status: accepted 2026-10-02

## Context

ADR-005 asks for a rate limit per system that bounds adt+'s load on SAP. Two things make a plain
"calls per minute" a poor measure of it:

- **Calls cost SAP very different amounts.** Traced per SDK method: `abapStat` costs no backend
  request, a search or folder read about 1, a cold file read 1.4–3.5, a source write 5–9 (lock,
  reads, PUT, unlock), a create 3–9, an activation about 1.4 per file. adt+ can't count the
  requests exactly: adt-ls makes them and reports none, and its HTTP log, the only exact source,
  holds credentials in clear text.
- **Bulk work is not a loop.** The per-minute budget guards against an agent calling tools in a
  loop. A clone or pull knows its size up front, runs once, and its load is best described by how
  many requests it keeps open at once. Paced per minute, a 1,477-object clone took 33 minutes at
  the pacing cap, not at anything SAP needed: each call takes tens to a few hundred milliseconds,
  and the system's work processes stayed idle almost all the time.

## Decision

### The budget counts estimated backend requests ("units")

- Each SDK method has a fixed weight, its typical traced cost rounded up, or the middle of the
  range where costs spread widely (a create, 3–9 → 6). `raw.lsp` calls are weighted by their LSP
  method; an activation weighs per object it activates. A REST request weighs 1.
- **A method without a traced weight weighs 3**, about the middle of the traced costs, until a
  trace gives it its own.
- The weights live in one table in `daemon/ratelimit.ts`, not in `systems.json`.

### Two lanes per system

- **Interactive lane:** every command that isn't bulk (MCP tools, CLI commands, single reads and
  writes): `rateLimit.concurrency` calls in flight (default 4) and a budget of
  `rateLimit.perMinute` units in a sliding minute (default 600). A command that would exceed it is
  refused (`throttled`).
- **Bulk lane:** the mirror commands and the git helper's reads. **No per-minute pacing**: a bulk
  command keeps at most `mirror.concurrency` calls in flight, back to back (default 3, at most 5),
  and its units don't count against the interactive budget, so a clone at full speed doesn't get
  an agent's reads throttled. They are still counted in the command's result, the call log and
  the progress.
- **Per channel within the bulk lane:** REST requests use `mirror.concurrency` in full; adt-ls
  calls are capped at 3, since adt-ls runs one call at a time per session and more only queue,
  delaying the interactive calls that share the session.

### Unchanged by lane

SAP's 429 and 503 start a cooldown (honouring `Retry-After`) that stops both lanes, and nothing
is retried in a loop (ADR-005). The object ceiling, the write gates, the deny list, read-only
mode and the call log apply to bulk work as to any.

## Why

- Weights track SAP's load within their error; for reads, traced per type, the error is small.
  Counting calls charged a 0-request `abapStat` like a 9-request write.
- Measured with parallel calls on `onprem`: adt-ls gains about 20% at 3 in flight and nothing at
  5, while each call waits longer in its queue. Direct REST requests scale almost linearly at a
  flat time per call. Dropping the pacing alone doubles bulk throughput.
- Calls in flight are a fair stand-in for work processes busy, since adt-ls sends a call's own
  backend requests one after another.

## Consequences

- A badly wrong weight is the failure mode: a method that costs far more than 3 is under-counted
  until it is traced.
- While a clone runs, a system sees up to 3 adt-ls calls and `mirror.concurrency` REST requests of
  adt+'s bulk work open at any moment. The operator lowers it, or raises the REST part to 5, per
  system.
- More adt-ls throughput would need more adt-ls sessions per system (backlog).
- Settings: [configuration.md](../configuration.md), "Rate limit" and "Mirror".

## Changes

- 2026-10-15: restated as it holds today for the public release, with the retired ADRs it absorbed merged in.
