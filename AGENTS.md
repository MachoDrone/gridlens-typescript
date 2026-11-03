# GridLens working instructions

GridLens is the TypeScript app; use this repository explicitly. Preserve unrelated
work in other checkouts. Start new isolated work from the current published
revision, not a historical candidate mentioned in an incident record.

## Work efficiently and verify the right thing

- Establish the requested outcome, boundaries and necessary proof before editing.
  Use targeted discovery; do not reread unrelated documents or rebuild a full repo
  map for a small change. Reuse unchanged evidence already obtained in the task.
- Verify consequential external contracts before implementation: method,
  authentication, field units, recipient behavior and failure/replay semantics.
  Use authoritative evidence and independently specified examples. A fixture
  copied from the implementation's assumption is not independent verification.
  Unknown financial behavior blocks live enablement.
- Make the smallest complete change, including necessary compatibility/recovery
  work. Keep unrelated improvements out of the critical path. Delegate independent
  work with clear file ownership; avoid duplicate whole-task investigations.
- Use focused checks during edits. Freeze and review the candidate, generate its
  verification plan, and run required gates. Reuse successful hash-bound evidence
  through commit and publication. Changed inputs invalidate affected evidence;
  unknown impact, shared tooling, dependencies and broad changes require full
  verification. Never reuse failed or interrupted checks or mask flakes with retries.
- Keep progress concise and factual: current stage, new finding or actual blocker.
  Report measured time/bytes and evidence reuse; do not promise unmeasured speedups.

## Verification and publication

Use pinned Node/npm from `.nvmrc` and `package.json`. Install development
dependencies with `npm ci --ignore-scripts`; do not install host OS packages.

- `npm run verify -- --base <commit>` selects and explains the required gates.
  `npm run check` is the complete typecheck/Node/browser suite and builds once.
- Financial changes require financial, authorization, RPC and persistence checks
  plus Wallet browser journeys and relevant isolated Docker recovery. Provider,
  collection, scheduling and storage changes include their sustained simulations.
  Shared layout changes include full browser coverage. Detailed rules and evidence
  formats live with the maintained verifier and [development guide](docs/DEVELOPMENT.md).
- An approved plan includes its stated development publication after the agreed
  checks pass. Do not ask again for the same scope. Seek fresh direction only for
  material changes in scope, destination or risk. Live installation, stable
  promotion and financial actions remain separate authorizations.
- Publish the exact reviewed source to `main` and `review/fleet-duration-freshness`
  with one fast-forward-only atomic push; verify both remote hashes. Never force
  push, replace immutable release assets or rewind a newer channel.
- Use the maintained release tool and private run journal. Resume by reconciling
  actual remote state after an uncertain write; never repeat a mutation blindly.
  Keep signing keys, credentials, rosters, runtime state and evidence outside Git
  and outside release asset inventories.

## Non-negotiable boundaries

- Preserve financial history, spent allowances, owner settings, TLS identities,
  provider budgets, revocations, unrelated resources and existing VPNs. A restart,
  rollback or settings change must not replenish an allowance or budget.
- Wallet mutations require the saved HTTPS endpoint and separate owner authority.
  Ordinary operator access or Secure setup alone does not grant financial ownership.
  Keep the financial socket absent from HTTP. No automatic repeat claim or transfer.
- Existing source wallet keys and reusable authorization never leave the verified
  source container. Tests use generated data and keys. Do not initiate a live claim,
  transfer or signing action as part of implementation, tests or publication.
- Protected finance requires the pinned source guardian and retained owner
  authority. Never fall back to direct SSH signing, reinitialize a missing pin or
  ledger, or give a viewer installation source credentials or financial IPC.
  Follow `docs/OWNER_BOUND_FINANCE.md`; source/hub root administrators remain trusted.
- The original balance-transfer pilot is exactly 1 NOS total, once. The rewards
  pilot claims all available uptime rewards into the selected host's own NOS ATA,
  one unresolved claim globally and one submitted attempt per public host. Claims
  do not forward funds. See [Wallet requirements](docs/WALLET_PILOT.md).
- Docker must already exist. Add no host packages, users, services, VPN changes,
  public port forwarding, global DNS/sysctl changes or unrelated workload controls.
  Mutations are restricted to validated GridLens-owned resources. The updater's
  existing Docker socket authority is separate from the owner/gateways.
- Cloudflare Workers is abandoned. Keep the app at its saved private LAN/VPN URL.
  HTTPS certificate trust remains an explicit device/OS action; do not bypass
  warnings, regenerate identities or imply that a webpage proves OS trust.
- Never mix synthetic fixtures into live data. Preserve exact claimable uptime
  rewards; staking, estimates and earned totals are not substitutes for that field.

## Read by task

The [component reference](docs/COMPONENT_RULES.md) preserves the detailed rules
formerly loaded at the repository root. Read only applicable sections, together
with the matching implementation documentation below. These references remain
requirements, not optional background.

| Task | Relevant references |
| --- | --- |
| Wallet, rewards, receipt verification | `WALLET_PILOT.md`; component **Wallet and financial authority**, **On-chain balances** |
| HTTPS, device access, pairing | `SECURE_BROWSER_SETUP.md`; component **HTTPS and device setup**, **Preservation and integration boundaries** |
| Network and IP readings | Component **Network readings and provenance**, **Display preferences and field meanings** |
| Collection, RPC, queues, budgets | Development source/budget sections; component **Sources and scenarios**, **Activity and queue reconciliation**, **Collection and progressive feeds** |
| Fleet fields and rendering | Development Fleet contract; component **Metadata and node state**, **Fleet layout and status**, **Display preferences and field meanings** |
| Mobile, zoom, navigation | `UX_CONSISTENCY.md`; component **Viewport and mobile behavior**, **Navigation and connection status** |
| Installer, updater, releases | `MODERN_INSTALL.md`, development publication policy; relevant installer/updater code and maintained release procedure |
| Hosting or preview lifecycle | `HOSTING_HANDOFF.md`; component **Preview and portable hosting**, **Preservation and integration boundaries** |

Documentation names in the table are under `docs/`. Read README sections when
entrypoints or product context are needed. When scope crosses components, combine
their requirements instead of assuming a narrower boundary.

The normal development preview is `http://127.0.0.1:4173`. Reuse a healthy preview;
verify its command, working directory and process group before restarting it.
Never stop an unrelated process merely because it occupies that port. Use the
development guide's detached launch procedure and keep PID/log records outside Git.
