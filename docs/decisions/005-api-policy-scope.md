# ADR-005: Development-tooling scope under the SAP API Policy

- Status: accepted 2026-09-28
- Sources: SAP API Policy v.4.2026a; SAP API Policy FAQ v1.3 (June 2026)

## Context

The SAP API Policy governs how SAP APIs may be used. Four passages bear on adt+:

- **Policy §2.2.2** prohibits API use for "interaction or integration with (semi-) autonomous or
  generative AI systems that plan, select, or execute sequences of API calls", except through
  "SAP-endorsed architectures, data services, or service-specific pathways expressly identified
  and intended for such purposes". It also prohibits "systematic and/or large-scale data
  extraction or replication".
- **FAQ Q33** says ADT APIs "may be used for development purposes through endorsed channels
  only". It lists those channels, among them "SAP-provided developer tools that leverage ADT APIs"
  and "custom developer utilities built on the documented Eclipse Java SDK". It then states that
  ADT APIs "are not intended for programmatic reading of application tables or export of business
  data, SQL execution against SAP backend systems, business data integration or runtime
  orchestration, agentic AI workflows operating on business data, or substitution for business
  APIs".
- **FAQ Q56** says third-party or custom MCP servers may be used "provided all use complies with
  the agreement, the Documentation and in particular the SAP API Policy". That includes "enforcing
  proper authentication and authorization on every connection, and respecting published rate
  limits, quotas, and usage constraints". Operators "remain fully responsible". SAP gives no
  support or stability guarantee for such servers.
- **Policy §1.2 and FAQ Q55** exclude APIs "bound to SAP-reserved clients e.g. client 000".

adt+ is an MCP server and CLI that a coding agent uses. It reaches the ABAP system through SAP's
ABAP language server (adt-ls), which comes with ADT for VS Code: a headless Eclipse runtime built
from SAP's ADT plug-ins, including SAP's ADT MCP server. On that path, every request to the system
is made by SAP's ADT communication layer. Only the fallbacks (ADR-002) and the reentrance-ticket
logon call the system directly. The published texts don't settle whether this way of using adt-ls
counts as one of the endorsed channels Q33 lists, and no clarification is expected from SAP.

## Decision

### Standing

adt+ claims no endorsement, certification or approval by SAP. It makes no statement about whether
any particular use complies with the SAP API Policy. Whoever operates adt+ against an SAP system
is responsible for using it in line with their agreements with SAP and the applicable SAP
documentation, including the API Policy. That responsibility can't be delegated to adt+.

The rest of this ADR describes what adt+ does and does not do. It keeps adt+ to development
tooling, the purpose Q33 describes, and keeps its footprint small and attributable.

### Scope: development artifacts; anything beyond is the operator's switch

- **In scope:** reading and changing development artifacts: source code, repository metadata,
  packages, transports, translations of development objects. Also checks, tests, activation and
  service publication. Reading repository objects of any namespace, SAP's own included, is in
  scope for development work such as navigation, where-used and type information, as Eclipse ADT
  offers it.
- **Source code is not business data.** Exporting it, as mirror mode and the git helper do
  (ADR-007, ADR-011), stays within the named packages and the rate limit and never becomes a
  periodic, system-wide replication.
- **What can reach business data is off by default and switched on per system by the operator**,
  on the operator's responsibility, each through its own tool so a person approves it apart from
  the code reads:
  - table contents and SQL (`allowDataPreview`, ADR-013): read only, small results, no export;
  - runtime logs, meaning short dumps and gateway errors (`allowRuntimeLogs`, ADR-015): one case
    at a time, never in bulk, the parts holding program data only on request;
  - running a class (`allowRun`, below).

  adt+ can't tell test data from business data, for example on a system copied from production.
  Whether reading it is acceptable is the operator's judgement.
- **Traces** aren't built. They wait for adt-ls.
- **An unreleased UI service** is used only for translations, off by default, on stricter terms
  (ADR-019).

### Writes

Every write stays behind the package allowlist (ADR-003). The allowlist exists for the operator's
own development packages; SAP-delivered packages and objects must never be allowlisted.
Customer-owned development is not only `Z*`, `Y*` and `$*`: it includes namespaces registered to
the customer or partner, such as `/NSPC/`. adt+ doesn't check namespaces separately; the allowlist
is the single rule.

### Execution

- `adtplus_run` executes arbitrary ABAP, which can read data anywhere. It is off by default and
  listed only for systems where the operator sets `allowRun: true`.
- ABAP Unit has no risk-level cap in adt+ yet; the system's own maximum risk level is the limit
  (backlog, waiting for the SDK option).

### SAP-reserved clients

adt+ refuses client `000` and `066`: a system configured with either fails at load and never
reaches a logon, and a data preview statement that reads another client is refused (ADR-013).

### Footprint

- **Rate limit per system**, enforced in the daemon (ADR-008): calls in flight and a budget of
  estimated backend requests. When the budget is exhausted, the result says `throttled`; requests
  aren't queued without bound. Tools that fan out are bounded. An HTTP 429 or 503 stops the
  system's calls for a cooldown, honouring `Retry-After`, and is never retried in a loop. adt+
  limits only its own requests, not the ones adt-ls makes internally for each of them.
- **Call log on by default**, metadata only: time, client, command, system, duration, outcome.
  Source bodies and secrets are never logged. `ADTPLUS_LOG=0` turns it off.
- **No disguise.** adt+ never presents itself as another client: it sends its own user agent.
  Policy §3 forbids circumventing API controls through "impersonation techniques".

## Consequences

- `adtplus_run`, `adtplus_data` and `adtplus_runtime` appear only for systems that switched them
  on.
- SAP's ADT MCP Server, part of ADT for VS Code, is the SAP-published alternative for the
  operations it covers. The README says so.
- This ADR records adt+'s design boundaries. It is not legal advice and no assessment of any
  operator's compliance. If SAP publishes changes to the policy or FAQ that affect it, this ADR is
  revisited.

## Changes

- 2026-10-15: restated as it holds today for the public release.
