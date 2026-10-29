# GridLens development guide

This guide describes the current TypeScript application, its local input and
source contracts, and the remaining work. See [README](../README.md) for startup,
[HOSTING_HANDOFF](HOSTING_HANDOFF.md) for platform integration and
[UX_CONSISTENCY](UX_CONSISTENCY.md) for phone/laptop acceptance.

The installed [shared backend composition](SHARED_BACKEND.md) adds durable
provider checkpoints, a SQLite owner, HTTPS pairing and terminal setup. It is
separate from the preview behavior documented below. See the
[modern installer](MODERN_INSTALL.md) for runtime isolation, recovery and build
commands. Earlier published releases remain immutable; physical reboot, GPU
recorder lifecycle and physical-phone acceptance have separate evidence.

The explicitly selected `--vpn-web` address uses the existing private LAN/VPN
without browser codes or sign-in expiry. A dedicated server-side grant follows
the configured fleet's current roster, survives restart, and remains revocable.
Rerunning setup cannot revive revoked access. Anyone who can reach this private
HTTP address can operate that fleet; the LAN leg is unencrypted. Native Android's
HTTPS pairing stays separate. No VPN changes or duplicate collection are added.

The dev.6 update makes onboarding a single terminal wizard. It uses verified
network suggestions, bounded discovery, one numbered computer list with filters
and selection counts, new-identity review, credential entry, monitoring choices
and inspection. Only completed setup prints the browser address. Existing fleets
default to Finish and can explicitly add computers; empty or failed results offer
retry. Browser Manage computers is a read-only status/installer-command page.
Search cancellation still fences late results, and owner shutdown cancels scan
work before state closes. Existing browser setup APIs remain compatible, but the
deployed UI does not require their interactive flow. Developer-preview sources
are unchanged.

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
list from the developer's home directory. The app reads these files once and
never writes or maintains them. Restart to load external file changes.
Refresh view retains the startup roster; requests cannot select arbitrary files
or host addresses.

For an existing CSV export, use a CSV parser to select the exact `Node Address`
column, trim entries and deduplicate while preserving source order, then save the
JSON array outside the checkout. Check the resulting count and addresses before
launching. Do not copy measurement, contact or access fields. CSV import/upload
and synchronization of these input files are not implemented.

Only the selected live roster is collected. Switching to a synthetic scenario
cancels that page's live work. All live viewers and rosters share the same process
caches, in-flight work, cooldowns and provider budgets. Client scenario selection
is developer functionality, not an operator-isolation boundary.

### Online GPU Hosts

`?scenario=online-gpu-hosts` selects a third, dynamic preview roster, with the full
Fleet table. It unions the complete anonymous responses from the fixed Nosana
indexer `/markets/queued-nodes` and `/markets/running-nodes` endpoints as candidates.
Explorer's own queued-or-running total includes historical jobs still stored as
running; neither these endpoints nor that total proves current presence. The
endpoints supply no heartbeat or atomic snapshot timestamp; the discovery check
time records our completed read.

Verified on October 13, 2026: [Explorer's counter](https://github.com/nosana-ci/explore.nosana.com/blob/8a41d1bf8993ddab676a2600b0af6e91934af676/app/components/Job/Stats.vue)
combines queued hosts and running-job totals. The
[indexer's running-host query](https://github.com/nosana-ci/indexer/blob/0a115f3801c2b2d5d71dc3723dd3a4171c89278c/src/repositories/jobs.repository.ts#L252)
has no heartbeat or recency condition. The stronger display qualification below
is intentional and can produce a lower count than Explorer's headline.

Only candidates whose existing API projection is **current Online** appear in
the table. Reuse its original 30-second proof window, identity validation,
server-referenced clock, conservative expiry and handling of inconclusive reads.
Raw State OTHER with valid API Online evidence remains eligible; queued/running
membership, old job timing, metadata classification and retained Online labels
cannot admit a host. Unknown, Offline and expired candidates remain in the source
roster and bounded retry schedule, and can reappear after a successful check.
The displayed count is the qualifying subset; the notice gives both confirmed
and candidate counts. This confirms API reachability, not physical GPU health.

The display filter does not change request budgets, source selection, evidence
or retry history. Diagnostic coverage remains scoped to
the full candidate roster and is labeled accordingly. Admission changes use
existing Node Info progress and local expiry without extra probes. Preserve
unchanged rows and focus; close a removed row's dialog and return focus to Scenario.
Suspended clock confidence prevents admission until ordinary data revalidates it.

Discovery uses a shared in-memory cache, a 60-second refresh deadline, eight-second
request timeouts and 4 MiB response bounds. Visible pages request it on demand;
hiding, pagehide and synthetic scenarios cancel discovery. Reopening revalidates
through the cache. Failed checks back off from one minute to 15 minutes and honor
longer Retry-After values. Both responses must validate before membership changes.
Candidate additions appear immediately; removal requires absence from two successful checks,
reducing queued/running transition flicker. Failures preserve the last list and
its check time, with a stale notice outside Tools & diagnostics. API proof expires
independently and removes a displayed host even during a stalled discovery read.
A candidate list over two
minutes without a successful check is also shown as stale. Input files are never
read again, modified or generated by discovery.

Online roster replies add an `online` status with a process-specific membership
revision, check time, next refresh deadline and retention/error information.
Online data requests require that revision; outdated requests receive HTTP 409.
Each data envelope includes `onlineRevision`. The browser reconciles membership,
cancels superseded feeds and preserves surviving rows, evidence and preferences.
An unchanged check does not restart feeds or renew measurements. These additions
do not change file-backed rosters or the portable snapshot gateway's admission.

Online streams allow bounded 8 MiB frames for full-cohort replay (including
2,000-host normalized metadata); fixed scenarios retain 2 MiB frames. Both keep
the existing 16 MiB transport response/window limit. Oversized data fails visibly
without truncating membership or weakening identity validation.

Dynamic host caches retain departed addresses for one hour and through outstanding
retry deadlines, protecting fixed rosters and active work. At most 5,000 departed
dynamic identities are retained; discovery admits at most 10,000 current hosts.
Capacity errors retain the previous complete roster with an explicit diagnostic,
never a silently truncated list. Pruning preserves global budgets and cooldowns.

Online browser transport admits at most five requests at once, including
long-lived watches and roster reads. Queued roster refreshes take priority over
ordinary data requests; connection checks remain outside that queue. Admission
lasts through response completion/cancellation, and network timeouts start only
after admission. This leaves space for the connection probe under a single
viewer's HTTP/1 connection limit; multiple tabs still share the browser's origin
pool. Fixed scenarios and snapshot integrations retain their existing behavior.

The address list is inexpensive to refresh, but every column retains its existing
shared limits. Over 1,000 hosts exceed the 900/day individual job-discovery budget
and sustainable RPC refresh capacity. Full-table coverage may remain pending or
stale; no per-scenario budget multiplication or freshness extension is performed.
Automated tests inject discovery and detail providers and use synthetic addresses.

### Protecting supplied-fleet Duration collection

Online GPU Hosts reads **cached job timings only**, at the ordinary 120-second
browser cache-read cadence. Its jobs endpoint never starts assignment discovery
or known-job batch maintenance, including when a user selects Refresh view or a
State transition requests a cache recheck. Only Supplied Host Addresses and
Real200 use active job collection. This prevents a network-wide scenario from
exhausting the existing fleets' shared job-discovery allowance.

The optional job-provider `peek` method returns defensive copies of established
records or honest blank unknowns. It does not insert new hosts, dispatch work,
renew timestamps, change backoff or consume quota. Normal revision validation
still binds the response to the Online candidate roster. Its displayed policy
notice remains outside Tools & diagnostics; cached readings keep their original
180-second validity and become retained estimates when due.

This corrects the shared-capacity regression introduced when all Explorer
candidates entered active job discovery. A read-only comparison over 48 simulated
hours must show the same fixed-fleet requests, original evidence and budget
deadlines with and without interleaved Online cache reads. Changing the policy
does not erase already-spent quota or existing provider refusals. A normal code
update still requires restarting the preview, whose caches and limits are
process-local; repeatedly restarting to obtain more allowance is not a remedy.
Other public readers and their shared budgets are unchanged by this job-specific
guard.

## Live source and freshness contracts

The browser obtains data from the same-origin Node server. The server reads fixed
Nosana Host Manager/indexer routes, per-node Node Info endpoints and fixed public
Solana RPC providers. External Explorer links navigate only when selected.
Readers require no wallet keys, signing, transactions or privileged host access.

| Reading | Current source and behavior |
| --- | --- |
| Status and metadata | Anonymous metrics plus deduplicated market lookup provide Status, Market, RAM/Disk, CPU, CUDA/NVIDIA, package version, System release and Country. Metrics cache for five minutes; market labels for one hour. Status describes tier/classification, not liveness. |
| API and State | Validated Node Info supplies reported activity and API results. Successful responses cache for 15 seconds; Node-backed State expires locally after 30 seconds. OTHER may be resolved with positive, nonconflicting public running-job/queue membership. |
| DL / UL / Ping | Reported Node Info network readings, not browser-triggered speed tests. The default 0/0/0 triplet is unknown because validity is not established. |
| Queued | Validated ordered indexer market queue gives one-based position/total, never an ETA. It shares market reads with State, caches for 15 seconds and expires locally after 30 seconds. |
| Duration | Verified running assignment plus job timing. Known jobs refresh every 120 seconds; evidence expires after 180 seconds. The local clock uses the original start and reported limit. |
| Jobs | Current verified assignment or last observed job, plus optional ten-record history. Expanded history reads the indexer's host-filtered first page on demand, caches it five minutes and preserves individual job check times. Lifecycle and execution result are separate. |
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

Live browser calculations use one server-referenced clock for source validation,
freshness, job elapsed time and source refresh deadlines. Successful roster replies
establish the reference before feeds start; finite replies and stream frames carry
an emission-time `serverTimeMs` that can advance it. Monotonic browser elapsed time
advances the reference between replies. Phone/laptop clock settings, timezones and
daylight-saving changes do not change the age of the same evidence. Source details
keep their original UTC timestamps, and each source keeps its existing validity
window and future-time allowance. Local retry waits and request timeouts use
elapsed time separately, so calibration cannot shorten them.

Hiding preserves the reference and observations but suspends freshness confidence
until a validated data reply arrives after resumption. Known results remain
retained, without recording a source failure or changing activity history. Server
time is transport metadata, never an observation timestamp or stored measurement;
replaying a snapshot does not renew its evidence. Older servers without this field
keep the previous device-clock behavior until a reference is received. Synthetic
scenarios retain their sample clock; connection checks do not calibrate data time.
The browser also measures elapsed time from each request's dispatch to each
validated response/frame. Server emission time plus that elapsed interval gives
a conservative upper bound used only for evidence expiry. The original clock
estimate still controls job elapsed time, overrun warnings, future-timestamp
validation and refresh/backoff schedules. Slow delivery can therefore dim an
uncertain reading without adding that delay to its displayed duration.

Compatible samples narrow the bound; a long-running stream cannot widen a
previously tighter calibration. Suspension discards its earlier precision.
Readings still render immediately, with their original timestamps and values;
uncertain freshness does not manufacture source errors or retire job history.
Precision-only changes recheck display expiry without starting or accelerating
provider reads. This uses the existing server-time envelope, caches and batching;
it adds no clock probes, per-host requests or server protocol fields.
Resuming an untrusted reference reuses an ordinary due data read, or requests
metadata when no read is due (including paused elapsed clocks with finite
providers); shared provider caches and budgets still apply.
Switching synthetic scenarios while visible does not invalidate the reference.

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
  Populating..; a current confirmed absence is a dash. Expired or failed absence,
  or an older absence contradicted by validated running State, returns to
  Populating.. without restoring a retired counter. Original absence and
  retirement evidence stays in details. Synthetic elapsed examples keep their
  reported-time behavior and never become live projections.
  Absence popups describe what the last job reading reported. Retained readings
  explicitly leave current timing unconfirmed, including while the server clock
  is awaiting revalidation after suspension; this wording also appears in the
  combined Queued / Duration summary.
  When API Offline is currently confirmed and no useful timing exists, the
  Duration placeholder is a dash with explicit timing-unavailable details.
  This does not establish job absence or retire a known timer: current/retained
  counters and queue readings remain available. The placeholder returns to
  Populating.. if that Offline proof expires or API recovers while timing is
  still unknown. This presentation rule changes no collection or retry schedule.
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
server budgets. Initial job discovery also uses the existing validated activity
priorities within its first-attempt lane, keeping stable ties and first attempts
ahead of repeated discovery.

Job reads share limits of **16/30 seconds, 400/hour and 2,400/day**. Discovery has
nested limits of **14/30 seconds, 336/hour and 900/day**; repeats stop at 75% of
each discovery allowance to preserve first-read capacity. Empty/failed discovery
backs off from 60 seconds to 15 minutes. Production bulk host-to-job lookup and
capacity still require a verified backend contract.

Each finite job read admits work for at most 60 seconds of monotonic elapsed
time. Already started requests finish under their original eight-second timeout;
expired queued work is released first as pending, without a request or failure
penalty. Replacement lookups inherit the same window. Every completed response
still includes the full selected roster, with original evidence times and shared
cache progress. Visible browsers continue due pending work after a one-second
minimum; later quota and provider deadlines remain authoritative. This avoids a
slow but progressing roster read crossing the browser's 120-second response
timeout and entering its failure retry path. Hidden views still cancel reads.

Local budget deferrals do not start a network timeout or add failure backoff.
Actual timeouts and failed requests retain their existing backoff; provider,
quota and host deadlines combine by their latest deadline, not by adding waits.
Bounded reads do not raise throughput limits: 200 cold host lookups still require
at least seven minutes under the discovery allowance, before network latency.

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

### Recent job history

Jobs replaces the unconnected Latest Job placeholder without adding a data
column. Its collapsed summary uses the existing independently validated current
assignment, otherwise the most recent observed job with a historical label.
Historical records never feed State, API or Duration. The expanded table follows
Explorer's Address / Host / Started / Duration / Price / GPU / Status layout,
with a uniform dark surface, readable sans-serif text, relative starts and
outlined status badges. Only expanded job rows grow to 50–52 pixels; Fleet host
rows remain 34 pixels. Inline-size containment keeps the nested table within the
established Fleet width; unsupported engines use a bounded 1,280px fallback.
History headings scroll with their own rows; only Fleet's direct header is pinned.
Running elapsed values are estimates and show the original
reported maximum. A completed lifecycle is separate from a successful execution
result: SUCCESS/FAILED require explicit completed outcomes, while missing or
contradictory results stay explicit. Last-reported running evidence cannot claim
current work. Exact UTC start/end/check times, lifecycle/result, page coverage
and pricing inputs remain in a default-closed Source details disclosure. Opening
that disclosure changes presentation only and preserves its focus through ticks.

Expansion is per host, survives sorting, and resets on reload or scenario change.
Show all / Hide all operates on the displayed roster. Selected histories are
requested in chunks of at most 100 through `/preview/job-history.json`, with
repeated `host` parameters checked against the startup/Online roster. Optional
`refresh=1` expresses manual refresh, without bypassing budgets or the one-minute
lookup floor. Online requests retain revision checks and only call `peekHistory`;
they never construct a job provider or collect new history.

The source is the same configured Nosana indexer as Duration:
`GET /jobs/?node=<host>&limit=10&offset=0`. It supplies a bounded recent page,
not a synchronized or complete archive. Normalize identity, lifecycle, timings
and the allowlisted `jobStatus` result immediately; raw workload definitions,
results and environment values are discarded. Existing assignment/terminal reads
also retain up to ten observations without renewing the separate history-page
check time. Deduplicate by full job address and preserve newer item observations.

Price/GPU enrichment uses the job's own `market` and recorded
`usdRewardPerHour`, plus one deduplicated, five-minute
`https://host-manager.k8s.prd.nosana.com/markets` catalog. Select only each market's
`address`, `name` and `usd_reward_per_hour`, with 2 MiB/2,048-entry bounds. This
JSON API call shares the same job pool, budgets, retry rules and cancellation;
it runs only for explicit expanded-history demand. Ordinary assignment reads and
Online cache peeks never initiate market enrichment. A market failure preserves
the successful job page and dated catalog; a later explicit read can retry the
metadata independently of the page's refresh floor.

Active job Price uses the market USD/hour quote × 1.1 and displays `/h`;
finished job Price uses its recorded USD/hour rate × final seconds / 3,600 × 1.1.
This follows Explorer's calculated customer price including 10%, not a settled
invoice or host rewards. The [indexer records the job rate](https://github.com/nosana-ci/indexer/blob/0a115f3801c2b2d5d71dc3723dd3a4171c89278c/src/indexer/job-processor.ts#L305)
and [Explorer applies the price multiplier](https://github.com/nosana-ci/explore.nosana.com/blob/8a41d1bf8993ddab676a2600b0af6e91934af676/app/composables/useMarketPricing.ts#L4).
Never replace a missing historical rate with today's
market quote. Missing, default-zero or invalid rates remain unknown; tiny positive
display amounts use `<$0.001` rather than falsely showing zero. Retained hourly
quotes say Last quoted. GPU is the associated job market's name, never the host's
current market or measured physical GPU. Independent market check/expiry times
and retained pricing evidence must not renew job or page timestamps.

Opening missing or five-minute-old history requests one page. No periodic history
polling runs after that read settles. Deferred work follows shared eligibility
only while expanded and visible; hiding/collapsing cancels unneeded work. Manual
Refresh and new openings still share the existing two slots, global budgets and
repeated-discovery allowance, at lower dispatch priority than current-job work.
Failures preserve original records and timestamps. Memory-only caches disappear
on restart; subsequent expansion can retrieve pre-restart records that Nosana
still supplies. There is no live lab database or retention guarantee.

The separate `JobHistorySnapshot` resource carries the same values through the
portable gateway and isolated hosting rehearsal. Missing history in older
snapshots restores as unknown. The trusted platform source and production
retention remain integration work; browser history requests never create a public
provider fallback in snapshot mode.

### Reported country

Country reuses the existing host metrics read, preferring valid
`metrics.network.country` and falling back to `metrics.country`. Bounded safe
text is retained; missing or invalid values remain unknown. Known country codes
have compact code and full English-name displays; other safe reported text stays
as reported. This is upstream-reported country, not verified physical location.
No IP lookup, browser geolocation, new endpoint or extra request is introduced.
Country shares metadata's original check time, cache and retained-value behavior.

The column is last, after System, with a saved compact/full header toggle that
defaults to compact. Sorting uses the full display name in either mode. Body
cells remain plain text without hovers or popups; header help explains the source
and limits. Optional `HostMetadataValues.country` crosses the metadata contract
and snapshot allowlist; older snapshots without it restore as unknown.
Region and city remain unverified and unconnected.

## Fleet interaction contract

Fleet has 28 data columns, or 27 with the optional combined Queued / Duration
layout. Staked NOS precedes Status. After SOL, keep **API → State → Queued →
Duration**, then the decorative divider. Rows remain compact, and the page grows
vertically with the fleet; horizontal overflow supports the full table.

Sorting uses exact amounts/full identities and stable ties, with unknown values
last in either direction. Clear sort restores supplied order or synthetic PC
order. The nine independent saved display controls are IP, Host Address,
Duration, Staked NOS, Market, NVIDIA, CPU, System and Country. Full values remain
in the model even in compact display. Combined Queued / Duration retains both readings,
freshness, sort controls and source details; changing layout does not change data.

All column headers retain sorting, information and display controls. Left-side
body controls open concise details with full provenance in a closed Source details
disclosure. Body values right of the divider are plain, nonfocusable text without
hover or row popups, except the requested Jobs expansion and job links.
Keep controls connected through refresh, sorting and layout
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

## Maintenance backlog

These follow-ups reduce the effort and risk of changing browser orchestration.
Use small, behavior-preserving changes within the current TypeScript/DOM
architecture; keep server-side provider caches and budgets separate.

- [ ] **Give each browser data source clear state ownership.** Extract controllers
  from `src/preview/main.ts` that own their records, loading/error state, active
  requests and timers. Start with SOL/NOS's similar lifecycle code while retaining
  their different progressive and finite response handling.
- [ ] **Share lifecycle and timer mechanics.** Reuse the existing transport,
  clock and deadline helpers for visibility, cancellation, cleanup and timer
  management. Preserve each source's cadence and retry rules, the distinction
  between elapsed time and freshness uncertainty, and expiry deadlines captured
  when cells render current. Do not collapse the sources into one polling cadence.
- [ ] **Give rendering and details their own modules.** Extract row/cell rendering,
  popup ownership and combined Queued / Duration layout from `main.ts`. Preserve
  connected controls and SVGs, animation timelines, keyboard focus and dialog
  return targets through refreshes, sorting and layout changes.
- [ ] **Review stylesheet boundaries after the orchestration work.** Group styles
  by feature and shared tokens where that improves ownership and navigation.
  Preserve cascade order, role colors, responsive zoom and motion preferences;
  file length alone is not a reason to split the stylesheet.

For each extraction, compare existing isolated scenarios before and after: source
request counts, cache reuse, population latency, original timestamps, expiry,
hide/resume, focus and animation behavior. Include the large-roster and
render-crossing-expiry cases; prevent extra reads or repeated short timer loops.
When modules or styles move, update browser asset allowlists and build/handoff
copying, and verify the copied artifact. These are backlog items, not completed
refactors or promised performance improvements.

## Hosting and feature backlog

Optional request reuse and bandwidth integration ideas are tracked separately in
[Optimal tool call considerations](optimal-tool-call-considerations.md). These are
considerations, not scheduled implementation.

The portable gateway, shared contracts, snapshot store, single-writer persistence
reference, synthetic rehearsal and compiled artifact are implemented. The gateway
requires injected authorized scope/roster resolution and a normalized snapshot
source. It validates and rechecks access, filters responses, bounds streams and
preserves evidence times across storage/restart. The local file store is not a
distributed database. External hosting through that handoff still needs its own
platform authentication, data connectors, storage and TLS/ingress integration.
The separate [shared backend candidate](SHARED_BACKEND.md) supplies SQLite, device
pairing and HTTPS in Docker and has passed isolated lifecycle acceptance; it is
not enabled for a live fleet. See [HOSTING_HANDOFF](HOSTING_HANDOFF.md) for the
portable contract and its remaining platform decisions.

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
| Node run time | Connect a verified source with independent evidence and correct host association. |
| PC/private IP/physical GPU identity | Define authoritative grouping and physical-device mapping, including replacement/reordering; reported device index alone is insufficient. |
| 200+ host overview | Design a separate overview that exposes every host without shrinking the detailed table further. |
| Alerts | Define live alert behavior and delivery; the current sidebar entry is disabled. |
| Hosted capacity and bulk data | Verify pagination, batching, source timestamps, shared quota ownership and failure/recovery with the actual platform. |
| Physical UX acceptance | Complete the device/browser, address-bar, safe-area and motion matrix separately from emulated browser checks. |

Deferred field candidates are GPU model/VRAM, GPU verification and UUID details,
CPU core counts, model-named benchmark throughput, benchmark temperature/power,
region/city, GPU runtime version, market guidance, alternate network-test selection
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
