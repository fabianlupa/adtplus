# ADR-003: Write gates in adt+ itself — allowlist, deny list, read-only mode

- Status: accepted 2026-09-21

## Context

A client's approval can't be the boundary. Under VS Code's Allow all or Autopilot, and in
terminal agents run with every tool allowed, nothing is approved per call, and Autopilot retries
after an error, turning a refusal into something to route around. A `confirm: true` the model
sends itself is no approval either.

## Decision

The gates are checked in the daemon, before any SAP call, whatever the client approved.

### The write allowlist

**One rule for every write:** a write is allowed when the package it lands in is covered by an
entry of the system's `writeAllowlist` (`src/capabilities/policy.ts`).

- `"PKG"` covers that package only; `{ "package": "PKG", "subpackages": true }` covers its whole
  subtree.
- An object lands in its own package; **a package lands in its superpackage**, so an allowlist
  root can never be deleted through itself.
- The package comes from the system: it is read off the resolved `abap:` repotree URI, which
  carries the whole package chain (`src/core/placement.ts`), never from a caller or a mirror
  manifest. A subtree check on a new package costs one package resolve.
- **Fails closed:** an unknown chain or a failed lookup is a refusal.
- **Covers every write and every execution:** object create, update, activate (all or nothing per
  batch), delete, publish and unpublish, generate, quick fixes, message deletes, transport create
  and assign, a mirror push per object, ABAP Unit and `run`, because executing code is as
  consequential as changing it. Transport release is bound to no package and isn't covered.
- The allowlist exists for the operator's own development packages (ADR-005). It may come from a
  project config, which only takes effect once approved (ADR-006).

### `ADTPLUS_DENY` and `ADTPLUS_READONLY`

- **`ADTPLUS_DENY`:** comma-separated daemon command names, each optionally ending in `*`, from
  the daemon's environment or stamped per request by the client. A name or pattern that matches no
  command refuses **every** command, naming the entry, so a typo or a stale name can't leave a
  command open (ADR-018). The MCP server hides denied actions.
- **`ADTPLUS_READONLY`:** refuses every command outside a read allowlist
  (`src/daemon/readonly.ts`); the MCP server registers only the tools that don't change the
  system.

### Further gates

- **Per-system switches** for what reaches beyond development artifacts, off by default:
  `allowRun` (ADR-005), `allowDataPreview` (ADR-013), `allowRuntimeLogs` (ADR-015),
  `allowTranslations` (ADR-019); `allowPublishService: false` turns publishing off.
- **A mirrored object** is written through its mirror, not in the system (ADR-009).
- **`confirm: true`** stays on irreversible actions, `run`, `publish` and `unpublish` as a speed
  bump for the model. It is not a gate.

## Consequences

- An agent can't write outside the allowlisted packages, whatever its client allows; within them,
  the client's approvals decide whether it asks first.
- The allowlist checks where code lives, not what it does: `run` and a unit test at a high risk
  level can still change data anywhere.
- The daemon inherits the environment of the client that started it, so a deny list set in one
  client can apply to all ([known-issues.md](../known-issues.md)).
- A change to a gate is built under the strictest review (`/code-review high`).

## Changes

- 2026-10-15: restated as it holds today for the public release.
