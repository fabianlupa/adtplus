# ADR-016: Every time adt+ reports or takes is UTC, corrected by a measured system clock

- Status: accepted 2026-10-12

## Context

SAP answers in two time scales besides UTC, and neither names its zone (no zone in
`core/http/systeminformation` or the discovery document, no `Date` header; probed 2026-10-09):

- **The system clock** (CTS): a request's `tm:lastchanged_timestamp`, a `tm:root`'s
  `adtcore:changedAt` (the answer's own time, labelled `Z`).
- **ADT's feed times**, labelled `Z`: the version feeds, short dumps (list and detail, and the
  `from`/`to` filters), system messages: the system's local date and time, converted to UTC by
  ADT with the zone SAP is configured with, not the one its clock runs at.

The gateway error log keeps real UTC timestamps (its detail page shows the same moment in the
configured zone, `10:42:29 (System)` for `08:42:29Z`), so its times and filter need nothing.

Probed at one moment against the Mac's clock: `onprem`'s clock runs 60 minutes ahead of UTC and
its feed times 60 minutes behind (local time converted with two hours); `cloud-erp` has both at
UTC. Passed on as SAP sends them, dump and version times would be an hour off on `onprem`.

## Decision

- **One rule:** every time adt+ reports is UTC (ISO 8601, `Z`), and every time it takes (`from`,
  `to`) is read as UTC and sent in the system's scale.
- **Measured, not configured:** per system, two small REST reads at once give "now" in each scale:
  an empty request list (`cts/transportrequests?user=<none>`, 0.3 KB, `changedAt`) and the dump
  feed asked for a user that doesn't exist (0.6 KB, the feed's own `atom:updated`; no entry, so no
  runtime log is read, and `allowRuntimeLogs` doesn't apply). Each offset is that time less the
  Mac's, rounded to 15 minutes, each scale on its own. Measured on the first call that needs it;
  kept an hour when both measured, so a clock change during a long session is caught; 5 minutes
  when a scale didn't for a reason that repeats (a refusal, no time); not kept after a passing
  failure, so the next call measures again.
- **Not measurable: times not corrected, and said so** (a note in the result; the git helper
  warns), never a guess and never a failed call.
- **`adtplus system status`** shows each system's offsets once measured.
- **Today's offsets go for every past time.** A time on the other side of a daylight-saving change
  can be an hour off where the system's scales differ in it (`onprem`'s feed scale looks like it
  follows summer time, its clock not); documented, not modelled.

## Consequences

- Applies to `object versions`/`read`/`diff`, `adtplus_runtime` (lists, details, filters),
  `transport read` and the git helper's transport history, which shares the measurement.
- A measurement costs 2 units per system and hour, only when a time is reported.
- Retire the correction for a scale when SAP reports it in UTC (the offset is then 0 anyway).

## Changes

- 2026-10-15: restated as it holds today for the public release.
