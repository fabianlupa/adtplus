# Test and run

ABAP Unit and running a class. Tools: `adtplus_test`, `adtplus_run`. Backend and gate letters:
[capabilities.md](../capabilities.md#legend).

| Tool | Backend | Gate | Verified |
|---|---|---|---|
| [`adtplus_test`](#adtplus_test) | adt-ls | A | both |
| [`adtplus_run`](#adtplus_run) | adt-ls | R, A, C | both |

## `adtplus_test`

- ABAP Unit, optional coverage.
- No risk-level cap (backlog).

## `adtplus_run`

- Runs `if_oo_adt_classrun`, i.e. arbitrary ABAP.
- Listed only while a system of the workspace folders sets `allowRun: true`, and takes only those
  systems ([configuration.md](../configuration.md#run-off-by-default)).
