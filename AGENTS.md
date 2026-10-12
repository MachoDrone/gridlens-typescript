# GridLens TypeScript repository instructions

Read `README.md` and `docs/DEVELOPMENT.md` first. They describe the current
application, architecture, implemented fields and remaining work. User
instructions take precedence. Use this repository as the working directory.

The local live preview is `http://127.0.0.1:4173`; use the pinned toolchain below.
Keep a healthy preview running across tasks. When starting a persistent preview,
use the development guide's detached `nohup setsid` recipe. Keep PID/log records outside Git,
for example in `~/.local/state/gridlens-typescript/preview.{pid,log}`. Before
stopping or restarting, verify the saved process's command, working directory and
process group; never kill a process merely because it occupies 4173. Restart
after source or startup-input changes and verify the same URL. Check the preview
process and source first when the URL is unavailable.

A portable hosting boundary is implemented and documented in
`docs/HOSTING_HANDOFF.md`. Hosting is not arranged, and no production platform
session, data adapter or storage integration is configured. The live preview and
snapshot gateway share the UI and typed observation contracts. Continue testing
integration-independent behavior locally; do not invent a platform authentication
contract or claim a production deployment. `npm run dev:handoff` starts a separate
explicit loopback simulation at 4175 with synthetic snapshots.
`npm run build:handoff` produces the compiled runtime, typed adapter declarations and
integrity manifest. Keep rehearsal stores isolated from live data. Verify command,
working directory and process group before stopping any rehearsal process;
graceful termination releases its single-writer lock.

- Application logic, server code, build scripts and tests use TypeScript. A
  runnable Fleet preview reads selected public Nosana data for explicitly
  supplied host addresses. Synthetic scenarios stay separate.
- The address file is external developer input, read once at preview startup:
  `GRIDLENS_HOSTS_FILE` or `~/.local/share/gridlens-typescript/hosts.json`.
  Never add discovery, seeding, synchronization, address maintenance or file-writing
  logic. Report missing/invalid input without creating or replacing it. Keep
  addresses out of Git/build output and test only with isolated files. External
  edits take effect after restarting the preview; five-character Explorer links
  sort using the full public address. No measurements may be inferred from an address.
- Real200 is a second live scenario, separate from the default roster and
  synthetic examples. Its external input is
  `~/.local/share/gridlens-typescript/real200.json`
  (override: `GRIDLENS_REAL200_HOSTS_FILE`). CSV preparation may extract only the
  `Node Address` column; do not import measurements or contact fields. Preserve
  existing order when appending and show the actual count despite the name.
  Read that file once at startup. Fixed `?scenario=real200` API selection may
  choose only that startup roster, never arbitrary addresses or paths. Use shared
  provider caches, budgets and cooldowns across live scenarios; selecting one
  must not collect the other. Tests use isolated explicit inputs and injected
  providers, never a developer's Real200 file. Missing/invalid Real200 input must
  not affect the default roster.
- The live metadata adapter reads Host Address, Status, Market label,
  RAM/Disk GB, CPU model, CUDA/NVIDIA driver versions, reported package version
  and System release from anonymous Nosana metrics plus a deduplicated market
  lookup. Keep the existing compact displays, saved toggles and raw-value
  sorting. Metadata does not establish host activity, heartbeat or physical GPU
  index. Public Node Info now separately supplies State and DL/UL/Ping. Preview reads are on demand through an in-memory shared cache, with
  bounded requests and Retry-After handling; no unattended server polling or disk cache.
  Tests must inject providers, never contact Nosana or real hosts.
  This public-preview policy remains separate from the portable snapshot source:
  trusted ingestion can update shared observations independently of viewers.
  Its explicit local file adapter is only for isolated single-writer persistence
  tests/rehearsal; never point synthetic ingestion at live stores or either host file.
- Status maps ONBOARDED to COMMUNITY (yellow C), with raw status in details and
  sorting by displayed full classification; REJECTED is red R, PREMIUM green P.
- Node Info supports all eight reported states. Reuse the existing running,
  queued and restarting animations in State. STARTING uses the same amber
  rotating-dot spinner as RESTARTING, while retaining its actual STARTING name
  in details, accessible labels and sorting. Other useful states use B/H/J.
  HEALTHCHECK uses a bright yellow H (#facc15), distinct from the amber spinners;
  retained/expired Health Checks keep a dimmer yellow H (#a1840d).
  Unresolved OTHER or missing activity without useful display history uses an
  extra-dim amber rotating-dot spinner (#634006), darker than retained
  STARTING/RESTARTING (#8b5906). Its artwork does not establish either reported
  state or promise a request is in flight; keep raw/unknown meanings in details,
  accessible labels and sorting.
  Full states remain accessible. Do not turn QUEUED into RESTARTING when queue
  position is absent or infer STOPPED from a failed request. Successful reads are
  cached for 15 seconds; state display expires after 30 seconds locally. The visible
  supplied-address feed refreshes hosts independently from their cache deadlines;
  finite-provider compatibility reads retain the earlier 20-second cadence.
  Hidden/synthetic views and pagehide stop active feeds; address inputs are never
  polled. Metadata's shared watch follows its five-minute cache only while viewed.
  There is no unattended server loop.
  Retained/failed/expired states keep the last useful artwork in darker versions
  of its existing colors and continue animation under the saved motion preference.
  The unknown spinner appears only when no useful display history exists;
  useful retained history keeps its original artwork. State animation defaults to
  On, overriding reduced motion only for State
  artwork, including dimmed retained State and the unknown spinner. The saved app-only State animation select also offers System (respect
  browser preference) and Off. Never change desktop/browser OS settings; other reduced-motion behavior is preserved.
  Live State uses fresh useful explicit/reconciled Node evidence first, then a
  fresh matching running job unless equally recent/newer contrary evidence vetoes
  it, then the last useful display dimmed. Node deadlines stay 30s and job-backed
  deadlines stay the original 180s; display-derived State never affects scheduling
  or Queue inference. Bounded page history prevents superseded jobs from reviving
  through expiry/cache replay; a newer successful running check can restore them. Stable
  rows/buttons/SVGs must stay connected through unchanged refreshes
  so animation timelines and keyboard/dialog focus survive. Node Info has independent identity checks, timeout,
  response/concurrency limits, failure backoff and Retry-After handling.
- The Host and Monitor HB columns are removed. Preserve the underlying inventory
  freshness model and original source times; removing Monitor HB does not remove
  freshness handling. Saved sorts for removed columns fall back to PC. The table
  has 27 data columns, with Staked NOS immediately before Status. After SOL, keep
  API → State → Queued → Duration
  adjacent, with other columns retaining their relative order. Duration's queue
  arrow points left; Queued's running arrow points right. Preserve shared host
  identities and inventory/PC details; those are not Host-column-only code.
  Keep a fine 1px vertical divider centered in a separate 34px decorative column
  after Duration, matching existing compact column widths. Continue it through
  the header and body rows; the empty divider column has no sort control or data
  semantics and separates the primary columns on the left.
- Queued and Duration default to separate columns. The icon centered between
  their titles shows two columns with inward arrows to combine, or one column
  with outward arrows to separate. Keep action tooltips and accessible labels;
  Duration's 🔄 stays above its title. This layout control saves only
  `gridlens.preview.queued-duration-layout.v1`;
  missing, invalid or denied storage defaults to separate. Combined mode shows
  one Queued / Duration column between State and the existing divider, retaining
  independent Queued/Duration sorts and the Duration bar/text/motion preferences.
  Keep both useful sources on compact Q/D lines, including stale/conflicting
  values and their individual colors. Suppress redundant arrows/placeholders;
  confirmed queued activity without a rank shows Queued, while missing timing
  preserves Populating.. versus confirmed-absence dash. Combined popups summarize
  both readings and retain both original descriptions and timestamps under the
  closed Source details disclosure. A stacked combined Q/D row uses one coherent
  details target for both readings, preserving compact height and avoiding
  overlapping touch targets; retain independent header sorts and source data.
  Keep the underlying artwork connected but remove its duplicate source controls
  from interaction and accessibility while the shared target is active. If a
  background reading switches between stacked and single-source presentation
  during an open dialog, closing it must return focus to the surviving details
  action; preserve native return focus when the original opener remains available.
  Move stable source controls
  with focus/animation preservation and a compatible-browser fallback; hide unused
  cells/controls from keyboard and accessibility navigation. Layout changes must
  not touch evidence, source selection, deadlines, retirement history, reads or
  coverage summaries. Separating the columns helps diagnose presentation bugs,
  but both views still share underlying readings and source-selection rules.
- API is immediately before State, reusing Node Info rather than
  adding a probe. Online always uses Nosana #10E80C and Offline always #FF0000.
  Both are bold within their checking window and regular weight when stale;
  do not recolor API results gray. Keep the original check time in details.
  Online's window is 30 seconds. Offline follows its frozen per-host nextCheckAtMs
  plus the eight-second request allowance, so ordinary retry waiting stays bold.
  Accept schedules up to the normal 15-minute backoff cap; longer pauses and
  invalid/missing schedules fall back to the original 30-second proof window.
  Amber Populating.. (#F59E0B, exactly two dots) means no established result,
  including inconclusive or deferred reads, not necessarily an in-flight request.
  Keep the underlying unknown semantics; never use API Other as a substitute for
  State OTHER. Preserve one nonrecursive apiCheck.lastConfirmed
  result across inconclusive reads and reconnects. Raw OTHER or failed activity
  reconciliation can still be API Online. Offline requires two actual HTTP 503 responses within 30
  seconds. Timeouts, network/redirect failures and other gateway errors cannot
  establish Offline even when repeated. Expire the confirmation pair from its
  first 503; old errors across backoff or hiding cannot confirm a new outage.
  A first failure gets one confirmation on the same endpoint, eligible after
  one second through the shared five-second confirmation lane. Preserve a
  still-valid previous Online result only until its original deadline. Invalid,
  denied or rate-limited responses cannot confirm an outage; deferrals and
  cancellation never count as attempts. Preserve
  actual check times. The two-503 classification window remains 30 seconds;
  Offline's presentation window follows its recorded retry schedule separately.
  A timely matching 503 confirmation can finish within the original allowance;
  network/preview failures cannot reactivate stale history. Retaining a label
  in regular weight never advances evidence or claims current reachability. Untimed
  failures cannot establish a current Offline result. Provider pauses defer
  unattempted hosts without failure counts or exponential backoff. Persistent
  failures keep exponential backoff and one recovery turn per 30 seconds.
  Keep four total slots, at most one failed-host retry in flight and Retry-After.
  Failure details may include a bounded kind, phase, HTTP status and allowlisted
  transport code; never expose raw exception causes, URLs, headers or credentials.
  Refresh view updates data only; loading preview code changes requires browser reload.
- Keep status-message text and live regions stable during background/manual
  refreshes when previous data exists. Loading prose belongs only to the initial
  read; actual expiry, errors and changed results must still update. Do not rewrite
  equal text or strip/reapply unchanged Status cell classes on every render.
- Preserve all header hovers, Column info windows, sorting and header display
  toggles on both sides of the decorative divider. Remove body-cell hover text,
  tooltips and info popups only to its right: nodeRuntime, dailyUptime, latestJob,
  ram, disk, dl, ul, ping, rewards, nos, market, gpuID, currentNode, cuda, nvidia,
  cpu and system. These 17 body columns use plain nonfocusable text/spans, without
  titles, click handlers, tooltip controls or Open details labels. Keep their
  values, colors, freshness, exact sorting, complete reading model and saved
  compact/expanded header modes. Do not relocate the removed row details to a new
  menu. Left-side body information and connected controls remain available.
- Keep retained header, control and left-side cell hovers concise and single-line. Popups use
  one authored summary sentence and at most four short facts focused on values,
  status, freshness and check times. Preserve full original descriptions,
  identities, exact amounts and source timestamps in a closed Source details
  disclosure; combined Queued / Duration retains both sources there. Keep provider
  budgets and implementation plumbing out of the initial popup. Color supports
  explicit text and verified evidence: unknown is amber, retained readings muted,
  alerts red. API Online/Offline keep their existing green/red colors even when
  stale, with explicit Last confirmed wording. A positive staking comparison
  must not claim full eligibility. Author structured explanations instead of
  parsing source prose into summaries. Render all values as safe text DOM nodes,
  never HTML. Preserve connected source controls, focus, measurements, evidence,
  source selection, read cadence and storage preferences.
- Node Info's classifier can return OTHER during a running job. Resolve fresh,
  successful OTHER using independent per-market public running-job and queue
  membership, with shared metadata/cache reads. Preserve the raw state and exact
  evidence in details. Positive unambiguous membership is required; missing,
  conflicting or failed evidence is unknown. Never equate OTHER or absence from
  a running list with RUNNING_JOB, BENCHMARKING, idle or stopped. Explicit node
  categories remain separate. Combined evidence expires at its earliest deadline;
  the indexer has no source timestamp or synchronization watermark. A benchmark
  need not have an assigned customer job. Do not add RPC polling, SSH or wallet
  access as a fallback.
- Queued uses Nosana indexer `GET /markets/{marketAddress}` for an ordered host
  queue: one-based position / total, plus existing arrows to/from Duration.
  Validate exact host/market, complete unique queue, counts and queueType
  (0 jobs, 1 hosts, 255 empty). Do not infer rank from Host Manager's unordered
  membership list. Actual State and Queued share one per-market memory cache and
  in-flight requests. Use 15-second cache/30-second local display validity,
  visible per-market watches (20-second finite-provider fallback), bounded reads and Retry-After. Retain
  failures/expiry gray, clear confirmed absence, reject contradictory current
  job/State evidence, and never carry positions to a changed market. Keep API
  check time separate from the indexer's processing `updatedAt`; neither is a
  synchronization watermark or ETA.
  A shared provider pause is a deferral, not a new failed market attempt; never
  extend its original deadline by adding another failure backoff. Finite joins
  retain the shared cache's original refresh deadline. Unchanged assignments and
  label-only metadata updates do not republish entire queue cohorts. Reassignment
  immediately clears the old rank while the new market proof is pending.
- SOL now uses a separate public RPC adapter and read-only `/preview/sol.json`,
  restricted to startup hosts. Use confirmed getMultipleAccounts batches <=100,
  zero-length data, exact integer lamports, verified mainnet genesis and one oldest
  slot block-time check/provider/refresh. Reject >60-second-old, >15-second-future
  block times and slot regressions. Best-effort 30-second shared deadlines;
  local expiry 60 seconds, errors retain gray values, null is unknown and zero
  requires validation. Display SOL rounded down to three decimal places using
  integer lamports (`0.005` stays `0.005`; `0.0049` becomes `0.004`). Match the
  existing centered 11px purple (#7B3FCC) current values; retained values stay
  gray. Sorting and details retain exact amounts.
  Fixed Labs/PublicNode/Vibe/OnFinality preference, sticky
  success, at most one alternate/refresh; never reread successful batches.
  Publish each completely validated SOL batch progressively, including cache
  replay for joining viewers, while preserving finite JSON snapshots. Keep the
  original account check time through block-time verification and publication.
  Prioritize never-attempted eligible accounts, then oldest supporting evidence
  with stable insertion ties; a reordered viewer cannot restart roster-prefix
  priority. Provider-specific pauses may use the one eligible alternate, while
  a shared budget deferral cannot obtain a new allowance. Observer failures must
  not affect provider health or other viewers.
  Respect Retry-After, exponential 60-second to 15-minute cooldown and permanent
  process disable for denied/wrong-chain/unsupported providers. Short or expired
  Retry-After headers never shorten the local exponential cooldown. All RPC methods
  share one/second, 12/minute, 600/hour, 12,000/day limits, max 2 concurrency,
  8-second timeout, 28-second refresh deadline and bounded bodies. These are local limits,
  not quotas/SLA; production durable shared ownership remains an integration
  requirement. Every automated test must inject providers. No wallet or
  transaction operations belong to these read-only adapters.
- NOS uses read-only `/preview/nos.json` for each startup host's standard
  associated NOS token account, with 120-second shared refresh and 180-second
  local expiry. Show nearest whole NOS (integer half-up), centered 11px normal
  green #15803d; retain exact six-decimal base units for sorting and the reading
  model. Header information states the account scope; additional owned token accounts, staking and rewards
  are separate. Verify mainnet, official NOS mint, classic Token program,
  six decimals, token mint/owner and initialized/frozen state. A freshly verified
  absent ATA is zero for that account; failure is unknown or retained gray.
  Frozen accounts retain amounts and account state in the model; NOS has no body
  hover or row popup. Use official server-only
  Solana derivation/codecs, never hand-written curve code or wallet access.
  SOL and NOS share one transport, request budget, concurrency and provider
  health per server, with independent caches and asset validation. Never grant
  a second RPC allowance to NOS. At 200 hosts the combined steady-state estimate
  is 450/hour or 10,800/day before startup/retries; larger rosters may defer under
  the unchanged cap. Preserve cancellation, scenario isolation and gray expiry.
- Staked NOS uses read-only `/preview/staking.json` for the selected startup
  roster, sharing the SOL/NOS RPC transport and unchanged limits. Show vault NOS
  (including releasing tokens), never original principal after withdrawals.
  Derive stake/vault addresses with the installed Solana library and validate
  program, layout, authority, vault and mint. Both accounts absent establishes
  zero; inconsistent or failed reads stay unknown. Deduplicate current-market
  headers and keep the node software's displayed NOS target separate from the
  duration-weighted xNOS requirement in details. The saved header toggle defaults
  to symbols: dull-green #15803d ✓ when both exact readings and assignment are
  current and actual >= target, or red #ff0000 lowercase x when current actual <
  target. Missing comparisons are —; retained matching comparisons use gray
  symbols, never a false red x from unknown data. Both ✓ and lowercase x use
  16px semibold (font-weight 600, line-height 1), including retained gray symbols;
  the unknown dash keeps its existing size. The alternate `# / #` mode shows
  centered normal-weight 11px `actual / required`, whole-NOS half-up rounding and
  base color #15803d. When current, only the actual amount turns #ff0000 below
  target or #10E80C at/above target; the required amount stays #15803d. This
  comparison is not full eligibility proof. Keep all seven saved display toggles
  (IP, Duration, Staked NOS, Market, NVIDIA, CPU and System).
  Preserve exact integers for sorting/details, independent source times, 30-minute
  refresh and 35-minute expiry. Failures retain gray; market changes immediately
  invalidate the comparison and request the new target, reusing current stake data.
  Hidden/pagehide/synthetic views cancel staking reads too. At 200 hosts and
  200 markets, budget about 384 extra requests/day, 11,184 combined before
  startup/retries; no additional allowance or wallet access is granted.
- Metadata, Node Info/State, jobs, Queued and SOL publish completed per-host/market/batch
  snapshots progressively to visible viewers. Preserve JSON compatibility and
  startup roster validation; bounded NDJSON is opt-in through Accept. Shared
  progress replays to joining viewers without more upstream work and stops after
  last-consumer cancellation. Never publish raw OTHER before reconciliation or
  hold healthy rows behind unrelated slow hosts. Queue updates preserve coherent
  market cohorts. Partial updates preserve original source times and connected
  row controls; genuine expiry/errors keep their original deadlines and retained status.
  Publish validated metadata/market addresses before optional market labels and
  release the host slot. Labels share the two-request pool behind initial metrics;
  apply them only to the matching host/market generation without changing source times.
  At each shared Duration dispatch, prioritize never-attempted hosts, then due
  known-job batches, then eligible repeated discovery across all viewers.
  Follow authoritative job retry/budget deadlines; do not remove limits or extend
  freshness to mask large-roster delays. Discovery has at most 14/30s, 336/hour,
  900/day inside the unchanged total budget. Never reserve hypothetical maintenance
  for undiscovered jobs or reduce discovery allowance based on roster size. Repeated discovery
  must preserve first-read capacity:
  repeats stop at 75% of each discovery allowance, counting all discovery
  requests; first reads retain the full allowance. Shared quota deadlines must be
  recomputed separately from true host backoff, including after State hints.
  Preserve per-host first/repeat eligibility in both dispatch and reported retry times.
  Rotate due known jobs by oldest original supporting evidence in batches of at
  most 100, and back off empty/failing discovery from 60s to 15min. Cold discovery
  can span multiple windows. Validate sustained multi-hour/day operation, not only
  initial population, before claiming the Duration-wide outage is fixed.
  A first fresh RUNNING_JOB observation may invalidate an already cached empty
  assignment; repeated RUNNING_JOB reports must not repeatedly reset backoff.
  Coalesce State hints arriving during a browser job read into one follow-up
  preview-cache check, even if the older response supplied a retry deadline.
  The server remains authoritative for upstream budgets, Retry-After and the
  60-second discovery floor. Never derive job timing from State.
- State, Queued and shared metadata use demand-scoped continuous visible feeds.
  Node Info and required market pools complete initial attempts before ordinary
  repeats. Real failed/unresolved responses count as attempts; cancellation and
  deferral do not. Preserve bounded API confirmation/recovery lanes. Among due
  ordinary reads, expired evidence or evidence within 10s of expiry comes first,
  then fresh STARTING/RESTARTING or newly running without timing, then verified
  jobs in their first two minutes or within two minutes of the reported limit
  through the five-minute grace. Newly running means the first two minutes after
  a validated transition; repeated reports do not restart that interval. Break
  ties by oldest eligibility then stable insertion. Only backend evidence supplies
  hints; display State, animation settings and row visibility never affect them.
  These priorities change ordering only, not eligibility, cadence or freshness.
  Refresh raw hosts and market proofs independently from actual cache/backoff
  deadlines; never refresh source timestamps by redisplaying them. Watchers share
  request limits/caches across viewers and stop timers/queued reads after their
  last consumer leaves. Finite JSON callers remain supported. Watch NDJSON bounds
  memory per frame and per rolling minute rather than limiting a feed's lifetime.
  Stream metadata changes to the browser too, so Queue identity gates use the same
  current assignment as the server. Keep fixed last-check/retry summaries and
  distinguish fresh queue absence from unknown or retained positions.
  Repeated Node Info failures back off 60/120/240/480/900 seconds and reset on
  success; Retry-After can extend the pause. Healthy deadlines outrank failed
  retries, and finite readers must reuse active watch caches without bypassing
  scheduling priorities. Pace persistent failed-host recovery at one turn per
  30s, with the first-failure recovery lane described above, so failures cannot
  starve forever or crowd out healthy reads. Cancellation must leave
  no new retry delay. Raw Node Info uses four shared slots after measured fleet
  latency exceeded the earlier two-slot capacity; each host still follows its 15s
  cache and 30s expiry. Metadata, market, job and SOL limits remain two. Never
  extend timestamps or TTLs to hide expired evidence.
- All preview fetches and timers pause on hidden/pagehide, including metadata,
  State, Duration, Queued, SOL and NOS; unfocused-visible continues. Abort browser and
  queued provider work, guard late responses and immediately resume missing/overdue
  reads. Shared work aborts only when its last consumer leaves, including dependent
  routes. Cancellation must not mark failures/cooldowns or let old cleanup erase
  resumed work. Preserve connected controls/focus and original timestamps.
- DL/UL/Ping use only info.network.download_mbps/upload_mbps/ping_ms, rounded for
  compact display with raw-value sorting and Mbps/ms retained in the reading model;
  these body cells have no hover or row popup. The documented
  default 0/0/0 triplet is unknown, not measured zero. These are saved readings
  without a reported test provider or measurement timestamp. Do not substitute
  FAST/Libre/Ookla metrics or run a new test to fill missing readings.
- Backburner: alternate network tests (FAST/Libre/Ookla), GPU model/VRAM/
  verification/UUID/reported index, CPU core counts, model-specific throughput,
  benchmark temperature/wattage, country, GPU runtime version and lastUpdatedAt
  display. Node run time and info.protocol also remain unconnected. Preserve their meaning and scope in docs/DEVELOPMENT.md. Do not populate
  these fields or repurpose GPU ID from the node-visible index in this slice.
- Hosting remains unarranged. Use the supported Nosana interfaces documented at
  https://learn.nosana.com/. Select SDK/API methods or MCP tools per field by
  coverage, batching, efficiency and documented limits; a different transport
  does not remove a shared backend limit. Missing interfaces require verified
  connector work, not automatic local OS/container collection.
- Keep changes bounded and preserve relevant behavioral tests. Update development
  documentation and implementation/verification status when behavior changes.
- Phone and laptop must preserve the same functional actions, data meanings,
  refresh rules and outcomes. Preserve their intended visual structure too:
  fixed navigation stays reachable, panels fill their intended visible area,
  and required content or controls cannot be clipped or stranded offscreen.
  During pinch magnification above the browser baseline, enlarged navigation
  and text may move outside the visible screen if native panning or zooming out
  recovers them without overlap. During zoom-out:
  below the baseline, keep the Fleet bar visible, the sidebar at full visible
  height, and the original column headings pinned below the bar. Physical
  verification of this correction is separate from the approved behavior.
  Follow [the UX consistency contract](docs/UX_CONSISTENCY.md). Compact layouts
  remain approved; do not add mobile hover instructions or new info bubbles.
  Preserve existing tap-open details. A mobile bubble toggle is future work.
  Share valid visualViewport left/top/width/height measurements, with a CSS
  fallback. At the normal browser baseline and while zoomed out, keep
  sidebar/header fixed to the visible screen: the sidebar covers its full height
  and stays left-anchored after panning, reload and rotation; the Fleet bar uses
  the visible width after reserving the full sidebar width. During pinch
  magnification above the baseline, sidebar, header and table share the
  document's coordinates and natural sizes; do not independently re-anchor the
  bars to visualViewport offsets or squeeze them into its shrinking bounds.
  Use zoom relative to the browser's initial/restored baseline, not absolute
  `visualViewport.scale !== 1`: Chrome can change that scale during ordinary
  rotation without a pinch. Rebase ordinary layout/orientation changes while
  preserving genuine pinch zoom. Derive natural page dimensions from visible
  size multiplied by that relative zoom; dialogs still use actual visible bounds.
  Magnified navigation may pan out of view and must return through reverse
  panning or zoom-out. Zoom-out instead retains visible navigation and full-height
  sidebar coverage. Expose the measured full table canvas during genuine native
  two-finger contraction, then at intermediate zoom-out levels fit the page
  width to the visible CSS width at the chosen native scale and restore the
  full-height horizontal table scroller. At the naturally fitting minimum,
  retain the full exposed canvas: the visual/layout widths already coincide,
  and keeping responsive width preserves every column after rotation. Treat
  a visible width within 1 CSS pixel of full capacity as that fitting endpoint.
  Include the main right gutter in the exposed wrapper's intrinsic width
  (`width: max-content` with its 12px right padding), so Chrome's rotation
  minimum fits the final column before ResizeObserver measurements arrive.
  One-finger movement at intermediate zoom-out scales must use native document
  and table scrolling; do not depend on JavaScript following visual-viewport
  panning to keep the bars stationary. Fractional visible widths must round
  inward to an integer CSS width, tracking that exact settled target; rounding
  upward can leave a persistent native pan. Use only floating-point tolerance
  (currently 0.0001) around the zoom baseline, not a 1% classification band.
  When the canvas is contained, the gesture has ended, there is no magnification,
  and native/visible widths agree within rounding tolerance, use native fixed
  edges for the sidebar/header and only header height for the heading inset.
  Active/exposed pinches and mismatched restored baselines retain measured
  positioning; dialogs always use actual visible geometry.
  A later contraction exposes the full
  canvas again while preserving the viewed column and row. Preserve the accepted
  default/minimum zoom behavior and the separate 200-host overview TODO; add no
  zoom controls, saved zoom preference or viewport-meta changes for this motion
  repair. Column headings scroll with the table only above the baseline or
  in the existing short-column-header mode (visible height below 200 CSS pixels).
  Otherwise pin the original column headings below the Fleet bar, including
  while zoomed out. Keep the toggle above independently scrollable
  menu contents that reach every footer link. Fleet keeps ordinary page scrolling.
  The selected scroll-motion repair allows a horizontal-only table scroller with
  automatic full content height; all rows, Scenario and diagnostics remain in
  ordinary vertical document flow. Do not add a height-limited inner vertical
  table viewport. Where CSS view timelines, exit-crossing ranges, horizontal
  clipping and ResizeObserver are supported,
  use browser-native navigation positioning and pin the existing table heading
  while its header/body move together horizontally. Preserve connected controls,
  focus and animations; do not clone the heading or alter reads. Let column
  headings return to normal flow during relative pinch magnification above the
  baseline or the existing short-column-header mode. Zoom-out keeps them pinned
  below the visible Fleet bar without cloning controls. This pinning is
  functional scroll layout, not decorative motion: it remains active with reduced
  motion and does not change State/Duration motion preferences. Unsupported
  browsers retain the existing layout/sticky fallback; do not claim their scroll
  jitter is fixed by the supported native path.
  A restored browser baseline can still produce real visual-viewport-only pans.
  Publish valid left/top offsets synchronously in the passive scroll handler,
  without header or layout measurements; keep full resize/zoom work scheduled.
  Event-time DOM alignment does not establish smoothness during a blocked main
  thread or replace a physical-device motion check.
  Cover 320px/390px, both menu states and intermediate native scales around
  0.75×/0.55× with one-finger movement in both axes. Inspect compositor frames
  during brief main-thread pressure as well as settled bounds. Include
  fractional zoom-out and just-above-baseline cases. Corrections must follow
  measured browser geometry across devices, without phone-model/version branches.
  Keep automated and physical acceptance separate; bounded automated checks do
  not establish universal browser support or physical smoothness.
  Fit dialogs within the visible screen, with readable
  scrolling content and reachable Close controls. Keep compact rows, with
  non-overlapping interactive targets at least 24×24 CSS pixels.
  Test complete components and journeys on desktop and true mobile/touch
  Chromium at 320×844, 390×844, 844×390 and 667×240: expanded/collapsed menus,
  normal/zoomed-in/browser-permitted zoomed-out views, native touch panning,
  rotation/resizing and reload after panning. Use real focal-point pinch gestures
  and assert immediate navigation/chart separation before any recovery gesture,
  not only eventual target reachability. At the normal baseline and while
  zoomed out, check sidebar edges, visible Fleet bar, pinned column headings,
  toggle and footer reachability before automatic test scrolling; check visible-screen
  bounds before hit testing. Cover first/last rows, both table edges, Scenario,
  diagnostics and dialogs. Preserve offscreen-row refresh, open-menu refresh
  and hide/resume recovery. Verify normal Real200 scrolling after fresh/reloaded
  non-default browser scales or rotation without pinching, using isolated
  Real200 fixtures rather than live inputs. Run shared assertions through `npm run check`, using
  the measured 90-second existing header/sidebar and 360-second sustained-test
  allowances without weakening application timing assertions. New complete-component shell and
  200-row touch journeys use 120-second wall-clock allowances after taking about
  80 seconds under the full suite; existing fixed-navigation tests use 90 seconds.
  Require a clean run before claiming
  emulated parity. Physical Chrome address-bar/safe-area behavior requires a
  separate phone check; emulation does not establish it.
- The supplied Nosana logo is embedded locally above the existing sidebar toggle
  row, horizontally centered in the panel at a constant 26×22px in both menu
  states. Omit the adjacent Nosana word
  label; keep the logo. Preserve the 56px collapsed
  rail. Extremely short views may scroll branding away to preserve controls.
- Expanded menus reserve their full width for the table and fixed Fleet header
  on phone and laptop. Do not dim or make the Fleet content inert, trap keyboard
  focus in the menu, or block touch panning while expanded. Preserve the nominal
  56px collapsed rail, natural expanded width, saved choice, mobile default-collapsed
  behavior, footer links and Escape with focus in the sidebar. Menu changes must
  not change refresh scheduling or visibility cancellation. Pinch magnification
  above the baseline preserves the nominal rail/menu width and header dimensions;
  their enlargement may extend outside the view without overlapping the chart.
  Zoom-out preserves the nominal menu width but fills the visible height and
  anchors the Fleet bar to the remaining visible width.
  Dialog Close may become an
  accessible ×; on extremely short screens, retain the title as the dialog's
  accessible name while Close stays beside the scrollable content (title visually
  hidden only below 120 CSS pixels of visible height). Current browser acceptance
  requests 2× and 5× zoom plus permitted zoom-out; report actual observed scale,
  not unlimited zoom or physical-device coverage.
- The upper-right connection indicator describes browser-to-Fleet reachability
  only. Checking… starts neutral; a validated `/preview/connection.json` response
  gives Connected with an 8px #10E80C ball; failure gives larger Data Unreachable
  with a 20px #FF0000 ball. Keep text left of the ball, the indicator visible while
  scrolling and sufficient space above sticky table headers on Android widths.
  Above the browser baseline, the pinch-magnification exception allows the
  naturally sized header to pan outside the screen with the page; never move it
  onto the chart. Zoom-out keeps the Fleet bar visible with column headings below it.
  Check only while visible, every 15s after success or 5s after failure, with an
  8s complete-response timeout. Network events trigger checks, never proof.
  Hide/pagehide cancels pending checks; resume revalidates and preserves red until
  recovery. The endpoint reads no hosts/providers; no source timestamp, host API
  status, data refresh budget or stale style changes from connection checks.
  Keep repeated status announcements stable. This is not PWA/offline caching.
  At the normal baseline and while zoomed out, anchor the entire Fleet header to
  shared visualViewport offsets/width on mobile, not merely
  the layout viewport: the naturally wide table can expand Android's layout
  viewport past the visible screen. Preserve touch page scrolling and pinch zoom;
  keep the row unwrapped with the connection indicator taking priority within
  its natural header width,
  and retain CSS fixed positioning as fallback.
  Regression tests must use isMobile/hasTouch, visual-viewport bounds and actual
  touch panning; narrow desktop viewport tests alone missed this behavior.
  Keep Nosana Fleet, host count, Clear sort and the indicator together and visible
  through vertical/horizontal scrolling on phone and laptop at the normal
  baseline and while zoomed out. Above the baseline, preserve their shared
  document coordinates and natural sizing. The header requires one row at every
  width, with connection status taking priority.
  Header height is 32px normally and 40px for the larger red warning. Preserve
  the status fonts/ball sizes. Narrow widths use a numeric host count, an accessible
  Clear sort × button and title ellipsis. Title/count collapse for a large warning
  or very narrow layout; when the header is narrower than 160 CSS pixels, preserve
  Clear sort in the sidebar above Alerts, with a labeled icon when collapsed
  and text when expanded. The indicator and ball remain visible; its label may
  ellipsize at extreme widths, with full
  accessible text. Never wrap or disable zoom. Container layout uses
  the actual header width. Above the browser baseline, use the natural page width;
  at the baseline and while zoomed out, use the visible width after the sidebar.
  Measure the auto-sized header with ResizeObserver
  for page spacing and sticky column-header clearance; never feed that measurement
  back into the header's own size. At the baseline and while zoomed out, reserve
  the full anchored sidebar width at the viewport's left; above the baseline,
  preserve that space in document coordinates.
  Verify visibility and paint of ALL header elements in their applicable mode,
  not only the badge. Preserve colors and all connection/source behavior.
- Verify Nosana backend fields and column meanings before connecting new data.
  Preserve source-age details and the existing local freshness model.
  Prefer verified backend data over duplicate container/OS measurements. Do not
  build local collection or public-API quota workarounds as default requirements.
  Keep real node exports and identifying/contact values out of Git and synthetic
  fixtures. See the field backlog in `docs/DEVELOPMENT.md`.
- Show red titles for current local observation/mapping
  dependencies (PC, private PC IP, physical GPU ID). Explain them in Column info;
  defer collection and transport to the
  hosted app. Missing backend connectors alone do not imply local-only data.
- IP display cycles through: hidden → full global/internal
  → global last octet → internal last octet. Keep the leading dot in compact
  IPv4 values. Use separate row-specific address sources; the viewing machine's
  address must never substitute for a host's global address. Display changes
  preserve sorting by full internal address and original observation times.
- Duration toggles between a compact elapsed/limit bar and time text. Red overrun
  presentation starts only when elapsed minus the reported positive limit is
  greater than 300 seconds; exactly limit + five minutes is normal, and the first
  second beyond is red. Apply the same threshold to live and synthetic bar/text
  views. Current timing stays green and retained live estimates stay dim green
  during the grace period; retained live overruns become dim red, while retained
  synthetic readings keep their existing gray/still policy. Preserve true elapsed,
  the reported limit and progress against that original limit capped at 100%.
  The grace changes only the warning color/overrun bar height; it grants no extra
  runtime and never starts or resets from RESTARTING or other State changes.
  Synthetic animation requires fresh matching job evidence and a positive limit;
  keep its reported-elapsed semantics and live projection separate. Use the
  backend's verified freshness contract, not an assumed local-inventory dependency.
  Public assignment GET validates
  `{ jobs, totalJobs }`; known timings use read-only POST `/jobs/batch` with at
  most 100 addresses. Live clocks use the exact job start/timeout, refresh every
  120 seconds while visible, and become retained estimates at the original
  180-second deadline or first failure, without freezing their elapsed clock. The API supplies no indexing-freshness timestamp. Use shared
  memory/in-flight reads, two concurrent requests, eight-second timeouts, bounded
  responses, Retry-After and at least 60-second empty/failure backoff. Local job
  limits are 16 requests/30 seconds, 400/hour, 2,400/day; delayed lookups stay
  pending. Production quotas and bulk host-to-job lookup remain hosting requirements.
- Duration glare has a separate saved animation setting: On (default), System
  and Off. On overrides reduced motion only for bounded Duration bars, including
  retained live estimates; System respects it, Off hides the
  glare. Preserve the existing 10-second cycle with its half-second sweep,
  independent per-row phases (including similar addresses), independent State
  preference, stable bar nodes and original freshness deadlines. Never
  change desktop/browser settings. Retention is page/process memory only;
  synthetic Duration retains its reported-elapsed semantics and existing gates.
- Market toggles between the full reported market label and its first two
  characters, with sorting by the full label. Keep current assignment distinct
  from recommendations and physical GPU identity. Synthetic market examples
  should be visible in populated sample scenarios; never import real export records.
- NVIDIA, CPU and System default to compact, with independent saved expanded
  modes. Compact displays use driver major version; CPU ordinal, vendor or first
  word; system string before its first hyphen. Keep full values for sorting,
  expanded header modes and the reading model, without body popups. These synthetic metadata examples establish no live freshness contract
  or GPU identity; a kernel release is not a complete OS description.
- This repository is public. Never commit real rosters, runtime data, backups,
  credentials, machine/server/client identities, wallet/signing keys or local
  evidence. Review staged paths and content; ignore rules alone cannot prevent
  disclosure. Preserve MIT and applicable third-party notices.
- Preserve Fleet behavior and column meanings, with the Host/Monitor HB removal
  and API/State/Queued/Duration order above. Preserve interactions, compact
  density, freshness and GPU identity. Unknown/stale is not zero, stopped or live.
  No synthetic observations may enter live stores. Keep viewers separate from
  Nosana's host collection; target 200+ hosts.
- Fleet content extends naturally down the page for long portrait-monitor views.
  Use ordinary vertical page scrolling, not a height-limited internal table or
  inventory scroll window. Horizontal-only table overflow with automatic full
  height is permitted for the native scroll-motion repair described above.
  Keep Scenario visible below the table. The remaining lower controls (Refresh
  view, Advance 30s, Reset sample and both animation preferences), diagnostic
  paragraphs, scenario explanation, clock help, inventory and footer belong in
  the default-closed native details#preview-tools disclosure labeled Tools &
  diagnostics. Preserve existing element IDs, controls and content for
  troubleshooting. Keep Nosana Fleet in
  Nosana green (#10e80c), an actual count formatted as N host/hosts
  in dull green (#15803d), and Clear sort visible above the table. Move the
  GridLens Preview wordmark, source notice, inventory summary, sorting prose,
  current sort and Column info button into Tools & diagnostics.
  Preserve visible input errors, the synthetic sample-clock display, column
  header controls and left-side body popups outside this disclosure. Opening/closing
  it changes visibility only: no reads, collection pause, evidence/history reset
  or preference change. Do not add a saved open/closed preference; it starts
  closed on reload. Keep all saved display/motion preferences and counts intact.
- Preserve unrelated resources, identities, accounts, ports, data and workloads.
  Do not install host packages/services or change host networking, DNS, sysctls,
  SSH or existing VPN configuration for this project.
- The browser UI receives no container-runtime socket, host shell, private-key or
  workload-control authority. Verify supported authentication and data permissions
  before connecting an integration. Account registration, deployment, wallet use
  and privileged operations require separate authorization.
- The portable gateway requires an injected verified access resolver and source,
  with no default login or public-provider fallback. Authorize the scope and exact
  roster revision before any read; query/header values cannot select arbitrary
  identities, sources or file paths. Sanitize exceptions and strip unknown source
  and resolver fields. Revalidate active feeds, stop on revocation/roster change,
  replay withheld updates only after authorization, and cancel feeds on shutdown.
  Keep the browser API prefix in trusted same-origin configuration, with shared
  finite/stream validators, bounded bodies/timeouts and visibility cancellation.
  Missing data is unknown; reading/restoring a snapshot never advances source time.
  Storage uses scope/roster isolation and atomic CAS updates. The file reference
  permits one owner, leaves crash locks for explicit investigation and fails
  closed after ambiguous persistence errors; it is not a distributed datastore.
  Handoff artifacts exclude local rosters, snapshots, credentials, test fixtures
  and public-provider adapters. Test copied artifacts and typed adapters outside
  the checkout before claiming a portable handoff. Source publication does not
  configure a production integration or authorize a hosted deployment.
- Do not access, copy, export, print or persist existing Nosana/Solana private
  keys. Read-only tests may use temporary, unfunded reader identities generated
  only in memory and discarded afterward. This does not authorize private-key
  persistence, account registration, transaction signing, claims or transfers.
  Automatic rewards require the exact `claimableUptimeNosRewards`, with no
  estimate/manual-entry or user-managed API-key substitute. Supported Nosana
  authentication is a separate integration choice; do not ship an unverified
  mechanism. Keep unavailable rewards unknown.
- The loopback developer preview is developer tooling. Hosting and recovery
  require an explicitly configured and verified integration; public source does
  not establish a deployed service.
- Use isolated fixtures and meaningful checks appropriate to each change. Keep
  implementation, automated test evidence, physical-device verification and
  product targets separate. Report changed behavior, verification, privileges and
  unresolved decisions.
- Use the pinned Node/npm versions in `.nvmrc` and `package.json`. Install local
  development dependencies with `npm ci --ignore-scripts`; run `npm run check`
  (strict typechecking, Node tests and isolated browser tests). Install the pinned
  test browser with `npx --no-install playwright install chromium` when needed;
  do not install OS packages. Server-only NOS derivation/codecs use exact-pinned
  @solana-program/token 0.17.0 and @solana/kit 8.4.0. `npm run dev`
  builds and serves the preview on `127.0.0.1:4173`; restart it after source edits.
- Treat hosting and missing connectors as unresolved integration work. Do not
  imply a provider commitment, delivery date, authenticated access or completed
  deployment without evidence.
