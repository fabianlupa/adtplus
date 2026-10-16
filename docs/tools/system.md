# System

`adtplus_system` (CLI `adtplus system status|connect|messages`): the systems adt+ knows, their
session state, the adt-ls in use, and the administrators' system messages. Backend and gate
letters: [capabilities.md](../capabilities.md#legend).

| Action | Backend | Gate | Verified |
|---|---|---|---|
| status / connect | — | — | both |
| messages | REST | — | both (empty on both) |

## status, connect

- `status` reads cached state and never opens a session; `connect` may open the `cloud-erp` SSO window.
- Both report the adt-ls in use (`adtLs`: path, version, verified release, match) and a `warnings`
  entry when it isn't the verified release (`core/adtls-version.ts`).
- `clocks` per system (CLI: one line each): the system clock's and ADT's feed times' offsets
  from UTC, once a call reporting a time measured them, or why a scale didn't measure
  ([known-issues.md](../known-issues.md#system-clock)).
- Per REST fallback, `nativeAvailable` says whether adt-ls could take it over
  ([known-issues.md](../known-issues.md#rest-fallbacks)).

## messages

- System messages (SM02) through ADT's feed: notices an administrator writes for the system, a
  server, a client, a language or one user, e.g. a maintenance window. Every message in full
  (title, text, author, times, UTC by the measured clock); no filter.
- Not behind `allowRuntimeLogs` (ADR-018): operational notices, no program data. Opens a session,
  like `connect`; read-only mode keeps it, `ADTPLUS_DENY=system.messages` takes it out.
- Both systems had none when built; the format follows the feed's Atom shape, and which messages
  the feed returns (the logon user's, or every one) is unverified.
