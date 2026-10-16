# Runtime logs

`adtplus_runtime` (CLI `adtplus runtime dumps|dump|gateway-errors|gateway-error`): ABAP runtime
errors (short dumps, ST22) and the gateway error log (/IWFND/ERROR_LOG, both ADR-015) through
ADT's feeds. System messages (SM02) are `adtplus_system messages` ([system](system.md#messages),
ADR-018). Backend and gate letters: [capabilities.md](../capabilities.md#legend).

| Tool | Action | Backend | Gate | Verified |
|---|---|---|---|---|
| `adtplus_runtime` | dumps | REST | U | both |
| | dump | REST | U | both |
| | gatewayErrors | REST | U | both |
| | gatewayError | REST | U | both |

## dumps

- Newest first, metadata only: `id`, `time` (UTC, by the measured system clock: [known-issues.md](../known-issues.md#system-clock)), `runtimeError`, `program` (the terminated
  one), `user`. The HTML summary SAP sends with each entry, the dump itself, is never read.
- `user`: default the logon user's own (ADT's system information, read once per session; on a
  basic-auth system the configured user if that fails); another user's name, or `"*"` for
  everyone's.
- `from`/`to`: ISO 8601 (`2026-10-12T08:00:00Z`, an offset taken into account), a date (its
  start as `from`, its end as `to`, UTC) or SAP's `YYYYMMDDHHMMSS` (UTC). Anything else is
  refused: SAP ignores a bound it can't parse and answers with the whole feed. adt+ sends them in
  the feed's own scale (`onprem`: an hour behind UTC).
- A clock that didn't measure: times and bounds as SAP has them, and `notes` says so.
- `maxResults` default 20, at most 100 (SAP's ceiling per request). `mayHaveMore` when as many
  came back as asked for; older ones need a `to` at the oldest time seen. The bounds are
  inclusive, so that second's entries come again; a page that is all one second needs a higher
  `maxResults`. No paging inside adt+ (ADR-015: one feed request per call).

## dump

- By `id` from `dumps` (a pasted one with spaces is encoded). Two requests: the dump's header
  and chapter index, then its formatted text.
- Returns `runtimeError`, `exception`, `program`, `user`, `time` (UTC, as in `dumps`) and the developer chapters: Short
  Text, What happened?, Error analysis, How to correct the error, Chain of Exception Objects,
  Information on where terminated, Source Code Extract, Active Calls/Events (those the dump has).
  `otherChapters` lists the rest by name and title; `chapters` takes names (`kap10`) or titles
  ("Selected Variables") instead of the default set. Variables, where program data sits, only so.
- SAP boxes and pads every line to 100 characters; adt+ drops the box, the padding and the dash
  rows (a default read on `onprem`: 14,000 characters to 5,800). The chapters returned are cut at
  40,000 characters in all, with `truncated`; a chapter cut or left out stays in `otherChapters`.
- English chapter titles when the logon language is English; names (`kap0` …) don't change.

## gatewayErrors

- Newest first, metadata only: `id`, `time` (UTC: the log keeps UTC timestamps, unlike the dump
  feed, so no correction), `type` (Frontend, Backend, Client), `shortText`,
  `user` (the user name; SAP adds the full name, left out). The HTML summary SAP sends with each
  entry, the whole error, is never read.
- `user`, `from`/`to`, `maxResults`, `mayHaveMore` as for `dumps`. SAP ignores `from`/`to` on
  this feed; adt+ sends them as a `timestamp` filter (UTC, unshifted), and always sends a filter, since SAP answers
  a read without one with recent entries only.

## gatewayError

- By `id` from `gatewayErrors` (`<Type>Error/<transaction id>`). One request, the detail page.
- Its sections as text, each with its name: Header Information (`HEADER`, the transaction id
  taken from its GW client link), Service Information (`SERVICE`), Error Context (`CONTEXT`: the
  exception chain with attributes and raise locations, indented as SAP nests it), Source Code
  Extract (`SOURCE`: line numbers, `>>` at the raising line, numbered from its neighbours since
  SAP shows `>>` there), Active Calls/Events (`STACK`, ` | `-separated rows). A page of 15,000
  characters of HTML reads as about 3,500.
- `sections` takes names or titles instead of all. Cut at 40,000 characters, with `truncated`;
  `otherSections` names those not returned whole.

## Availability

- Listed only while a system of the workspace folders sets `allowRuntimeLogs: true`
  ([configuration.md](../configuration.md#runtime-logs-off-by-default)), with only those systems;
  in read-only mode too. `ADTPLUS_DENY=runtime.dump` leaves the rest, `runtime.*` the tool out.
- The call log keeps no log text (an id is a parameter).
