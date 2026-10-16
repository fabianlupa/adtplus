# ADR-020: Evals live outside the repo; `dev/` stays off the shipped surface

- Status: accepted 2026-10-14

## Context

adt+'s routing and mirror evals measured one user's agent setup: the agent instructions and skills
together with adt+'s tool descriptions. They needed that setup, workspace and system, nobody else
could run them, and one of them needed a write exception to run on its own against a system.

## Decision

1. **No eval tooling in this repo.** Routing and mirror evals belong with the agent instructions
   they test, in each user's own setup. They talk to adt+ like any client: the MCP server, the CLI,
   the call log (`ADTPLUS_LOG`).
2. **`dev/` holds development scripts only** (parallel daemons, the public-safety gate and its
   hooks, the README logo): never in `tsup.config.ts`'s entry map, never an MCP tool, daemon
   command or CLI subcommand.
3. **Nothing in the repo writes to a system on its own.** Live tests that write are run by hand
   under `docs/testing.md`, "Live", on throwaway objects in allowlisted packages.

## Consequences

- The call log stays a product feature (ADR-005): on by default, `ADTPLUS_LOG=0` turns it off.
- A change to tool names or descriptions (ADR-018) is checked by each user's own routing evals,
  outside the repo.

## Changes

- 2026-10-15: restated as it holds today for the public release, with the retired ADRs it absorbed merged in.
