# GridLens development guide

This guide describes the current TypeScript application, its local input and
source contracts, and the remaining work. See [README](../README.md) for startup,
[HOSTING_HANDOFF](HOSTING_HANDOFF.md) for platform integration and
[UX_CONSISTENCY](UX_CONSISTENCY.md) for phone/laptop acceptance.

## Toolchain and commands

Use Node **24.14.1**, npm **11.11.0**, TypeScript **7.0.2**, Node declarations
**24.13.6** and Playwright **1.63.0**. Dependencies are exact-pinned in
`package.json` and the lockfile. Install with `npm ci --ignore-scripts`.
Server-side NOS derivation uses `@solana-program/token` and `@solana/kit`;
these packages are not shipped to the browser.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Compile and serve the live preview at `127.0.0.1:4173`. |
| `npm run preview` | Serve the existing browser build. |
| `npm run dev -- --port 4176` | Compile and serve at another explicit loopback port. |
| `npm run dev:handoff` | Run the synthetic snapshot integration rehearsal at `127.0.0.1:4175`. |
| `npm run typecheck` | Strict TypeScript checking. |
| `npm test` | Isolated Node tests. |
| `npm run test:browser` | Build and run isolated Playwright checks. |
| `npm run check` | Run typechecking, Node tests and browser checks. |
| `npm run build` | Emit browser assets in ignored `dist/`. |
| `npm run build:handoff` | Emit the portable runtime artifact in ignored `.tools/handoff/`. |

Install the pinned test browser with `npx --no-install playwright install chromium`.
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` may select an existing compatible executable.
Tests use isolated input files and injected providers; browser tests use port
4174 and reject nonlocal requests. Other test servers use isolated loopback ports.
Keep real rosters, exports, snapshots, credentials and local evidence outside Git.

## External roster input

The live preview accepts two independent startup files:

| View | Explicit setting | Default path |
| --- | --- | --- |
| Supplied Host Addresses | `GRIDLENS_HOSTS_FILE` | `~/.local/share/gridlens-typescript/hosts.json` |
| Real200 | `GRIDLENS_REAL200_HOSTS_FILE` | `~/.local/share/gridlens-typescript/real200.json` |

Each file is a UTF-8 JSON array of unique base58 public addresses decoding to
32 bytes. `[]` is valid. A missing, unreadable, malformed or duplicate-containing
file fails that roster with a diagnostic; it never produces partial rows or an
automatic sample fallback. A broken Real200 file does not break the primary list.
The Real200 label is a scenario name, and its displayed count is always actual.

When overriding the primary file, also set `GRIDLENS_REAL200_HOSTS_FILE` explicitly
to enable Real200. This prevents a custom/test setup from silently loading a second
list from the developer's home directory. The app reads files once, never writes
or maintains them, and does not discover hosts. Restart to load external changes.
Refresh view retains the startup roster; requests cannot select arbitrary files
or host addresses.

For an existing CSV export, use a CSV parser to select the exact `Node Address`
column, trim entries and deduplicate while preserving source order, then save the
JSON array outside the checkout. Check the resulting count and addresses before
launching. Do not copy measurement, contact or access fields. CSV import/upload
and automated roster synchronization are not implemented.

Only the selected live roster is collected. Switching to a synthetic scenario
cancels that page's live work. All live viewers and rosters share the same process
caches, in-flight work, cooldowns and provider budgets. Client scenario selection
is developer functionality, not an operator-isolation boundary.

## Live source and freshness contracts

The browser obtains data from the same-origin Node server. The server reads fixed
Nosana Host Manager/indexer routes, per-node Node Info endpoints and fixed public
Solana RPC providers. External Explorer links navigate only when selected.
Readers require no wallet keys, signing, transactions or privileged host access.

| Reading | Current source and behavior |
| --- | --- |
| Status and metadata | Anonymous metrics plus deduplicated market lookup provide Status, Market, RAM/Disk, CPU, CUDA/NVIDIA, package version and System release. Metrics cache for five minutes; market labels for one hour. Status describes tier/classification, not liveness. |
| API and State | Validated Node Info supplies reported activity and API results. Successful responses cache for 15 seconds; Node-backed State expires locally after 30 seconds. OTHER may be resolved with positive, nonconflicting public running-job/queue membership. |
| DL / UL / Ping | Reported Node Info network readings, not browser-triggered speed tests. The default 0/0/0 triplet is unknown because validity is not established. |
| Queued | Validated ordered indexer market queue gives one-based position/total, never an ETA. It shares market reads with State, caches for 15 seconds and expires locally after 30 seconds. |
| Duration | Verified running assignment plus job timing. Known jobs refresh every 120 seconds; evidence expires after 180 seconds. The local clock uses the original start and reported limit. |
| SOL | Confirmed public RPC batches of up to 100 accounts, verified mainnet and block freshness, exact integer lamports. Best-effort refresh every 30 seconds; local expiry after 60 seconds. |
| NOS | The host's standard associated NOS token account, with verified mint/owner/state. Refresh every 120 seconds; local expiry after 180 seconds. Other token accounts, stake and rewards are separate. |
| Staked NOS | Verified staking vault balance and current market target, with independent source times. Refresh every 30 minutes; expiry after 35 minutes. Vault tokens still releasing are included. |

These intervals are local preview policy, not guaranteed provider service levels.
Reads run on demand while a live view is visible, including visible unfocused
windows. Hidden/minimized pages and pagehide cancel active work; resume requests
overdue evidence. No unattended preview collection loop or disk cache runs.
Sorting and display toggles never trigger collection. Metadata, State, jobs,
Queue and SOL can deliver validated progress without waiting for the whole roster.
Joining viewers reuse existing progress and original timestamps.

Keep these semantic distinctions:

- Unknown, missing and failed are never measured zero, stopped or confirmed
  absence. Failed reads retain dated values. Cache replay, browser reload and
  rendering must not advance source times. Source ages remain independent.
- API Online requires a validated response. Offline requires two actual HTTP 503
  responses within 30 seconds; timeouts and network errors remain inconclusive.
  A retained label preserves its original confirmation time. Online stays bold
  within 30 seconds; Offline's bold window follows its recorded retry deadline
  plus the eight-second request allowance, bounded by normal backoff policy.
- Explicit Node Info categories remain distinct. Fresh running-job proof can
  supply State within its original 180-second deadline unless equally recent or
  newer contrary evidence vetoes it. A stale ticking Duration cannot make State
  fresh. Unresolved activity retains the last useful dimmed artwork or uses an
  extra-dim unknown spinner; that spinner does not promise an active request.
- Queue identity and complete membership must validate. Confirmed absence clears
  the old position; a market change invalidates its old rank immediately. Indexer
  processing time is not an observation timestamp or synchronization watermark.
- Live Duration keeps ticking from the last verified start as a dimmed estimate
  after failure/expiry, until newer evidence retires or replaces it. Red overrun
  starts only more than five minutes beyond the reported positive limit. This
  changes warning color, not runtime allowance or freshness. Unknown timing is
  Populating..; confirmed no assignment is a dash. Synthetic elapsed examples
  keep their reported-time behavior and never become live projections.
- SOL displays three decimals rounded down; NOS and numeric stake amounts display
  whole NOS rounded half up. Sorting retains exact integers. A verified absent
  associated token account can establish zero for that account; failure cannot.
  A staking amount comparison is not proof of full market eligibility.
- Status maps ONBOARDED to COMMUNITY; a reported package version is not a verified
  latest-version comparison, and a kernel release is not an OS distribution.
  PC labels, private PC IPs and physical GPU indices require verified mappings.
- Rewards mean the actual `claimableUptimeNosRewards`. Staking rewards, voting
  distributions, earned totals and estimates are different values. Keep this
  column unknown until a supported source supplies that exact amount automatically.

## Request budgets and scheduling

Caches and limits are process-local and reset on restart. Metadata and market
readers use bounded two-request pools; Node Info uses four slots, with at most
one failed-host retry in flight. Requests have eight-second timeouts and bounded
bodies. Honor Retry-After, cancellation and failure backoff; deferrals are not
failed attempts and cannot extend old evidence.

Complete first attempts across eligible Node Info/market rosters before ordinary
repeats. Among due work, prioritize expiring evidence and useful state transitions
without starving older work. Failed/unresolved real responses count as attempts;
cancellation or deferral does not. SOL similarly prioritizes never-attempted
accounts and then oldest evidence, preserving fairness across reordered rosters.
Known jobs and first discovery have protected capacity inside shared job limits.
A State hint can request a cache recheck, but never supplies timing or bypasses
server budgets.

Job reads share limits of **16/30 seconds, 400/hour and 2,400/day**. Discovery has
nested limits of **14/30 seconds, 336/hour and 900/day**; repeats stop at 75% of
each discovery allowance to preserve first-read capacity. Empty/failed discovery
backs off from 60 seconds to 15 minutes. Production bulk host-to-job lookup and
capacity still require a verified backend contract.

SOL, NOS and staking share one RPC transport and limits of **one/second,
12/minute, 600/hour and 12,000/day**, including network validation and failover.
The fixed provider preference is Solana Labs, PublicNode, Solana Vibe Station,
then OnFinality. Success is sticky; a refresh can use one eligible alternate
without rereading successful batches. There is no provider racing, address/IP
rotation or quota bypass. A larger roster or failures can defer readings under
these limits; never hide that by extending freshness.

At 200 hosts, approximate steady-state SOL/NOS/staking demand is 11,184 RPC
requests/day with 200 distinct markets, before startup and retries. This estimate
is not a provider quota guarantee or production capacity result. Hosted replicas
need shared durable cache and budget ownership, not independent public collectors.
The portable snapshot gateway uses trusted independent ingestion instead;
see [HOSTING_HANDOFF](HOSTING_HANDOFF.md).

## Fleet interaction contract

Fleet has 27 data columns, or 26 with the optional combined Queued / Duration
layout. Staked NOS precedes Status. After SOL, keep **API → State → Queued →
Duration**, then the decorative divider. Rows remain compact, and the page grows
vertically with the fleet; horizontal overflow supports the full table.

Sorting uses exact amounts/full identities and stable ties, with unknown values
last in either direction. Clear sort restores supplied order or synthetic PC
order. The eight independent saved display controls are IP, Host Address,
Duration, Staked NOS, Market, NVIDIA, CPU and System. Full values remain in the
model even in compact display. Combined Queued / Duration retains both readings,
freshness, sort controls and source details; changing layout does not change data.

All column headers retain sorting, information and display controls. Left-side
body controls open concise details with full provenance in a closed Source details
disclosure. Body values right of the divider are plain, nonfocusable text without
hover or row popups. Keep controls connected through refresh, sorting and layout
changes to preserve keyboard focus and animation timelines. Unchanged status
messages must not repeatedly announce loading or rebuild stable text.

State and Duration each have saved On/System/Off animation preferences, defaulting
to On for their artwork. System respects browser reduced motion; Off stops that
animation. Retained animation never establishes fresh evidence. Other reduced
motion behavior remains intact.

The sidebar expands by reserving space beside Fleet and collapses to a 56px rail;
it never dims the table or suspends refresh. The Fleet header stays one line and
prioritizes the connection indicator. Its Connected/Data Unreachable result means
browser-to-Fleet reachability, not host health or source freshness. The local
connection check makes no provider requests. Scenario stays below the table;
Tools & diagnostics starts closed and contains the other preview controls.

Phone and laptop retain the same actions and meanings. At normal scale and while
zoomed out, navigation follows the visible viewport, and table headings stay
pinned where supported. Pinch magnification preserves naturally sized page
coordinates and panning. Native zoom-out can expose all columns, but does not
make every row of a large fleet fit simultaneously. Dialogs must retain reachable
close controls and non-overlapping targets. See [UX_CONSISTENCY](UX_CONSISTENCY.md)
for complete-component journeys and physical-device acceptance limits.

## Hosting and feature backlog

The portable gateway, shared contracts, snapshot store, single-writer persistence
reference, synthetic rehearsal and compiled artifact are implemented. The gateway
requires injected authorized scope/roster resolution and a normalized snapshot
source. It validates and rechecks access, filters responses, bounds streams and
preserves evidence times across storage/restart. The local file store is not a
distributed database. Platform authentication, data connectors, production storage,
TLS/domain/ingress and deployment/recovery acceptance remain integration work.
See [HOSTING_HANDOFF](HOSTING_HANDOFF.md) for the contract and exact open decisions.

The proposed small beta would associate unguessable links with fixed operator
rosters and enforce that assignment on every data request, retaining shared
provider budgets and per-link limits. That beta link resolver, revocation
configuration and CSV preparation workflow are **not implemented**. The preview's
scenario query is not private access control. Public source availability does
not publish operator rosters or create a hosted beta.

Current feature priorities and source gaps:

| Item | Required next step |
| --- | --- |
| Exact claimable uptime rewards | Verify the supported source, amount/units, identity permissions and observation times; no estimate, manual entry or user-managed credential substitute. |
| Daily uptime/history | Verify day/timezone boundaries, coverage, partial/empty history and completeness. |
| Node run time and Latest Job | Connect verified sources with independent evidence and correct host/job association. |
| PC/private IP/physical GPU identity | Define authoritative grouping and physical-device mapping, including replacement/reordering; reported device index alone is insufficient. |
| 200+ host overview | Design a separate overview that exposes every host without shrinking the detailed table further. |
| Alerts | Define live alert behavior and delivery; the current sidebar entry is disabled. |
| Hosted capacity and bulk data | Verify pagination, batching, source timestamps, shared quota ownership and failure/recovery with the actual platform. |
| Physical UX acceptance | Complete the device/browser, address-bar, safe-area and motion matrix separately from emulated browser checks. |

Deferred field candidates are GPU model/VRAM, GPU verification and UUID details,
CPU core counts, model-named benchmark throughput, benchmark temperature/power,
location, GPU runtime version, market guidance, alternate network-test selection
and last-reported-update semantics. Their presence in a source does not settle
meaning, units, access or freshness. Add verified fields in bounded changes;
benchmark averages are not current sensor readings, and runtime version is not
process run time.

## Keep a local preview running independently

Reuse a healthy preview on port 4173. On Linux, start a detached preview from the
checkout only after verifying no existing launch owns that port. Set any external
roster environment overrides before launching:

```sh
preview_state="$HOME/.local/state/gridlens-typescript"
mkdir -p "$preview_state"
chmod 700 "$preview_state"
(
  set +m
  nohup setsid npm run dev </dev/null >>"$preview_state/preview.log" 2>&1 &
  printf '%s\n' "$!" >"$preview_state/preview.pid"
)
```

Check `curl --fail --head http://127.0.0.1:4173/` after the build and inspect the
saved log if it fails. The subshell disables job control so the saved PID remains
the detached launch. The state files stay outside Git. This launches a process;
it does not install a service or enable crash recovery/reboot startup.

Before stopping or restarting, inspect the saved PID with
`ps -o pid,ppid,pgid,sid,args -p PID` and `/proc/PID/cwd`. Verify the command is this
checkout's preview launch and its process-group ID equals the saved PID. Only
then use `kill -TERM -- -PID` to stop that verified group. Never signal a stale
PID or an unrelated process just because it occupies the port. Restart after
source/input changes, check the URL and reload the browser.
