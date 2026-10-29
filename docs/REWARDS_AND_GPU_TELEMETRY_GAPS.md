# Rewards and GPU telemetry gaps

Status: 2026-10-24. Scope: current TypeScript app, including Real200.

Candidate update, 2026-10-28: the separate installed shared backend now includes
an approved fixed in-node TypeScript rewards reader, verified Android recorder
compatibility and a separate owned TypeScript GPU recorder path when none exists.
Its generated-fixture tests do not authorize or demonstrate live
key use. The developer preview/Real200 remains public-only and unchanged. See
[shared backend](SHARED_BACKEND.md) for permissions, exact source contracts and
the remaining Docker/physical acceptance.

## Rewards to Claim

- Required value: `claimableUptimeNosRewards`. No staking/earnings estimates,
  manual entries or user-managed API-key substitute.
- One approved authenticated Nosana GET succeeded on one lab host. This did not
  establish fleet support or authorize recurring use of existing node keys.
- Preview/Real200 still lacks authorized automatic access. The installed candidate
  connector requires terminal-owned SSH credentials and explicit exact-node approval.
  Never export existing private keys or authorization headers into GridLens;
  unavailable amounts remain unknown.

## GPU conditions during jobs

- Track thermal slowdown, hardware thermal protection, power limiting and power
  braking against individual jobs.
- No verified public Nosana feed for these signals was found in the checked
  interfaces. Real200 has job data but no throttle readings or verified physical
  GPU mapping. The legacy collector reads GPU UUID/index only.
- Verify each GPU/driver's supported signals. Need timestamped reason flags,
  supported duration counters, reliable
  host/job/GPU association and recording independent of an open dashboard.
  Preserve unsupported states and gaps; benchmark temperatures/watts are not proof.
- Report **observed during this job**, not proven causation. Past jobs cannot be
  evaluated without recorded telemetry. Verify backend options first; host-side
  collection is a separately authorized option, not an automatic requirement.

## Shared connection

Both could share a GridLens reporting connection. Their sources and permissions
remain separate: rewards authentication does not unlock GPU readings, and GPU
monitoring itself needs no Nosana wallet key. Public Real200 addresses grant
neither capability.

See [current source contracts and backlog](DEVELOPMENT.md#live-source-and-freshness-contracts).
