# Optimal tool call considerations

Status: optional considerations, not scheduled implementation.

Track possible request reductions and a consistent bandwidth data source for
GridLens. This TODO does not authorize changes to collection or display behavior;
select and verify each implementation separately.

UI maintainability tasks are in the
[maintenance backlog](DEVELOPMENT.md#maintenance-backlog).

## Current baseline

The October 13, 2026 audit found no accidental per-host multiplication of market
requests. Within one preview server, hosts and viewers share market labels,
ordered queues, running-host membership and staking requirements. Separate server
processes have separate caches.

The app uses direct HTTP and RPC requests. It does not currently call the Nosana
MCP server or `market-metric-aggregates`. Similar fields in different responses do
not establish identical meaning, freshness or availability. Provider failover and
reads of different balance accounts are not redundant merely because they use
the same RPC method.

## Considerations

- [ ] **Measure potential savings and latency.** Count eligible skipped requests
  per market and refresh, including concurrent viewers, failures and transitions.
  Compare State update latency before choosing an optimization. Both running-host
  shortcuts below avoid the same `GET /jobs/running-nodes?market=...` request;
  their savings cannot be double-counted or multiplied by the number of hosts.

- [ ] **Reuse a fresh zero running-job count.** The indexer
  `GET /markets/{market}` response already contains `running`, which our queue
  normalizer discards. Retain and validate it. A count of zero establishes an
  empty running set for the entire market, allowing the separate running-host
  lookup to be skipped while that evidence remains current. A positive count
  identifies no individual hosts; missing, invalid or expired counts require
  the existing lookup.

- [ ] **Reuse sufficiently fresh, complete job evidence.** Job lookup and batch
  responses already contain `market`, which our job normalizer discards. Retain
  that field and distinguish a complete host-filtered empty lookup
  (`jobs: []`, `totalJobs: 0`) from a missing or ended known job. Use validated
  matching running jobs, or complete empty discovery, only when every watched
  `OTHER` host needing that market check has adequate evidence. Otherwise retain
  the shared running-host lookup. Generic `job: null` and missing batch rows are
  insufficient absence evidence.

- [ ] **Share identical qualifying NOS mint-validation reads.** NOS and staking
  can request the same mint from the same provider with matching parameters.
  Consider sharing an in-flight read or qualifying validated response while
  preserving each consumer's minimum-slot requirement, cancellation and failure
  isolation. NOS's once-per-provider verification cannot replace staking's
  required later revalidation. This is a conditional validation saving, not a
  reason to combine distinct balances or remove alternate providers.

- [ ] **Share matching block-time lookups.** Consider reusing
  `getBlockTime(slot)` only for the same provider and exact slot. Each consumer
  must independently apply its present-time freshness checks. Different slots
  are different observations. Mainnet identity verification is already shared.

- [ ] **Confirm and connect authoritative bandwidth results.** Obtain a supported
  endpoint and field contract for the evaluated download/upload values used by
  Nosana's thresholds, and clarify the corresponding ping source. Verify
  selection, averaging, units, timestamps, validity, missing values and API
  compatibility before changing DL/UL/Ping sourcing. Prefer shared backend
  results over separately reproducing threshold logic. Current saved Node Info
  readings, individual FAST/Libre/Ookla measurements and averaged threshold
  values must not be treated as interchangeable without verification.

## Constraints and acceptance

- Preserve 15-second activity reuse and expiry at the original check time plus
  30 seconds. Do not borrow Duration's 120-second refresh or 180-second validity
  windows, renew timestamps on reuse, or increase job polling to create savings.
- Preserve exact host and current-market matching, queue-conflict checks, newer
  contradictory evidence and fallback requests whenever coverage is insufficient.
- Avoid delaying currently parallel queue and running-host reads merely to learn
  that a shortcut cannot apply. Existing fresh evidence may be reused without
  waiting for another source.
- Preserve provider identity, account validation, request budgets, cooldowns,
  failover, successful-batch retention and independent consumer cancellation.
- Test any future implementation with isolated injected providers: incomplete
  coverage, invalid values, reassignment, job transitions, expiry, failures,
  cancellation and concurrent viewers. Never mix synthetic data into live stores.
- Verify actual saved requests and latency before claiming an improvement.
  Selecting an item does not imply that implementation or rollout is complete.

See the [development guide](DEVELOPMENT.md) for the existing source contracts,
refresh policies and broader feature backlog.
