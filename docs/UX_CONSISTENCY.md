# Phone and laptop UX consistency

Phone and laptop preserve the same functional actions, data meanings, refresh
rules and outcomes. Fixed navigation stays reachable, panels fill their intended
visible area, and required content or controls cannot be clipped or stranded
outside the screen.

Above the browser's normal baseline, pinch magnification may move naturally
enlarged navigation and text outside the screen if native panning or zooming out
recovers them without chart overlap. At the baseline and while zoomed out, the
Fleet bar stays visible, the sidebar covers the full visible height, and the
original column headings remain pinned below the bar.

Navigation must remain stationary throughout ordinary scroll gestures, including
before JavaScript can update offsets. Correct settled positions alone are
insufficient. Cover fractional widths and scales close to the baseline using
measured geometry and browser capabilities, without device-model or version
branches. Automated and physical-device acceptance are separate.

## Approved compact behavior

The locally embedded Nosana logo stays 26×22px above the sidebar toggle row in
both menu states, preserving the 56px collapsed rail. In extremely short views,
branding may scroll away while the toggle and menu links remain reachable.

- The Fleet header stays on one line. Connection status has priority; a numeric
  count, title ellipsis, hidden secondary text and an accessible × Clear sort
  button are allowed. Below 160 CSS pixels of available header width, the same
  Clear sort action is available above Alerts in the sidebar, using a labeled
  icon when collapsed and text when expanded. Full status text remains accessible.
  Above the browser baseline, pinch magnification preserves the header's natural
  dimensions and column headings scroll with the table. At the baseline and
  while zoomed out, the Fleet bar follows the visible width after the sidebar;
  pin the original column headings below it, except in the existing short-height mode.
- The sidebar retains its nominal 56px collapsed rail, natural expanded width, saved
  browser preference and default-collapsed behavior at 760px or narrower. Alerts
  remains a disabled placeholder. Expanded menus push the table and header aside
  on both phone and laptop; the table keeps its normal brightness and remains
  available for touch and keyboard interaction, including its first column.
  Pinch magnification above the baseline preserves the natural width and may
  move the enlarged menu outside the screen. Do not squeeze the rail/menu or
  change its saved choice to fit a shrinking viewport. At the baseline and while
  zoomed out, keep its full nominal width and fill the visible height.
- Fleet retains compact rows and ordinary vertical page scrolling. A horizontal-
  only table scroller is allowed when its height follows every row; it must not
  become a height-limited vertical table window. Scenario and diagnostics remain
  below the full table. Menu and dialog
  contents may scroll within their own visible panels when height is limited.
  Interactive targets must be at least 24×24 CSS pixels and must not overlap;
  normal Fleet rows remain 34px high.
  A stacked combined Queued / Duration cell uses one coherent details target
  opening both readings; both displayed lines, source details and independent
  header sorts remain intact. Connected source artwork keeps its animation,
  while the duplicate underlying actions leave keyboard and accessibility
  navigation. If background readings change the presentation while a dialog
  is open, Close returns focus to the surviving details action for that row;
  native return focus remains authoritative when the original opener is available.
- Existing left-side tap-open details and header information remain available.
  Do not add mobile hover instructions or new info bubbles. A mobile bubble
  toggle remains future work. The approved removal of body hover text and
  popups to the right of the divider remains in effect on both device types.
  Country is the final plain-text column after System. Its header help, sorting
  and saved compact-code/full-name toggle remain available on phone and laptop;
  the body adds no hover or popup. Both modes preserve reported country meaning,
  unknown/retained styling and metadata refresh behavior.
- Browser-local preferences, source meanings, data APIs and refresh semantics
  are preserved. A smaller screen or an open menu does not pause a visible
  page's refreshes or change evidence, timestamps, ordering or source selection.

These are presentation exceptions, not permission to remove actions or strand
required controls permanently offscreen. The magnification exception requires
recovery through ordinary native panning or zoom-out.

Live timestamp calculations share a server-referenced clock across API, State,
Queued, Duration, SOL, NOS, staking and source refresh schedules. For identical
evidence and delivery confidence at the same time, phone and laptop must agree
despite different device clock settings or timezones. A delayed connection may
conservatively retain a reading sooner; that uncertainty must not change its
elapsed duration, overrun threshold or source refresh schedule. Preserve each source's freshness policy and original
UTC check times. After suspension, retain known values while server timing is
revalidated; this must not fabricate source failures or retire activity history.
Clock-skew acceptance covers repeated refreshes, expiry, replay, combined Queued /
Duration, resume, device-clock changes, daylight-saving boundaries, delayed
bootstrap and buffered streams. Timing precision changes must not create extra
provider reads or mistake a long stream's lifetime for new delivery delay. Automated
mobile contexts remain separate from physical-device confirmation.

## Visible-screen layout requirements

Use shared left, top, width, height and scale measurements from the browser's
visual viewport. Keep ordinary CSS fallback behavior when the API or valid
geometry is unavailable. Follow viewport scroll/resize, page scrolling,
rotation, pinch zoom, reload and page resume.

At the browser's normal baseline and while zoomed out, the sidebar remains
anchored to the visible screen's left/top edges and covers its full height.
The Fleet bar uses the remaining visible width after reserving the full sidebar width. Keep the
menu toggle reachable above its remaining contents, which deliberately scroll when
needed, including on short landscape screens; every footer link must be
reachable. Continue to allow horizontal and vertical page panning with the menu
expanded. Preserve the table's first column and normal brightness.
Navigation must remain anchored throughout ordinary scroll gestures, not only
return to the correct position after scrolling settles.

At normal size and after an intermediate zoom-out gesture settles, the selected native scroll path contains horizontal table
overflow so wide columns do not expand the page's layout viewport. Browser-native navigation
positioning and a view timeline pin the existing table heading while heading
and body move horizontally together. Use this path only when CSS view timelines,
exit-crossing ranges, horizontal clipping and ResizeObserver are supported;
otherwise retain the existing layout/sticky
fallback. The supported-path motion fix does not establish equivalent smoothness
for unsupported browsers. Header pinning is functional layout, remains enabled
under reduced motion and does not change saved State/Duration animation choices.
Do not clone controls or introduce new refresh, source or preference behavior.
Pinning is suspended during relative pinch magnification above the baseline and
in the existing short-column-header mode (visible height below 200 CSS pixels),
when column headings remain in normal table flow. Zoom-out keeps the original
column headings pinned below the Fleet bar while preserving their horizontal
alignment with the table; do not clone the heading controls.
Restored browser scales can still pan the visual viewport independently. The
scroll handler publishes valid left/top offsets synchronously without header or
layout reads, while complete resize/zoom work remains scheduled. Validate actual
visual-viewport movement; stationary-offset document/table scroll samples are
insufficient. Event-time DOM bounds do not prove compositor behavior during a
blocked main thread or physical smoothness.

During pinch magnification above the browser baseline, the sidebar, header and
table share document coordinates and natural sizes. The navigation must not
independently follow visual-viewport offsets onto the chart. Enlarged bars may
move outside the visible screen; reverse panning or zoom-out must recover them.
Preserve the normal layout's reserved sidebar/header space, without tiny-bar
width caps or a reduced-height zoom header. Test separation immediately after
the pinch and each pan, before a recovery gesture or test helper can conceal a mismatch.
During browser-permitted zoom-out, retain access to the whole table while anchoring
the sidebar to the full visible height and the Fleet bar to the remaining visible
width. Keep the original column headings below the Fleet bar through vertical
scrolling. Do not leave a visible gap below the zoomed-out menu.
The base page dimensions follow visual-viewport dimensions multiplied by zoom
relative to the browser's initial/restored baseline. Absolute scale differing
from 1 is insufficient evidence of a pinch: Chrome can change it during ordinary
rotation. Rebase layout/orientation changes without discarding genuine pinch
zoom. Modal dialogs continue to use actual visible dimensions. When valid
viewport geometry is unavailable, retain the ordinary CSS fallback.

Native phone zoom-out must be able to reveal the whole table, rather than a
smaller clipped table window. On genuine two-finger contraction, temporarily
expose a page width measured from the actual table, sidebar and padding, and
expand the existing table's visible area with it. Support all 28 data columns,
or 27 in combined Queued / Duration, with both compact and expanded field displays.
Keep the full canvas available during contraction. At an intermediate zoom-out
level, when the gesture ends adopt the visible CSS width rounded inward to an
integer at that native scale and restore the horizontal table scroller at its
full content height.
At the naturally fitting minimum, where the visible width is within 1 CSS pixel
of full capacity, keep the full canvas exposed: the layout and visual widths
already coincide. Preserve this responsive fit through rotation, including
expanded CPU/System/Country values. The exposed wrapper includes the main's 12px
right gutter in its intrinsic maximum-content width so the last column fits before
ResizeObserver updates. Rotation may round unused right gutter while the actual
table still fits. Keep that table exposed only when both edges fit the visible
viewport and layout/visual widths naturally coincide within the existing 1.1px
allowance. A deliberate zoom just above the fitting minimum must still enter
the inward-rounded scroller, without blank document pan. The wider Jobs column
is covered by rotation and near-minimum regression checks.
One-finger pans at intermediate levels use
native table/document scrolling with near-zero visual-viewport offsets, keeping
the navigation stationary without JavaScript following every pan. A subsequent
contraction exposes the whole width again, preserving the viewed column and row.
App-controlled width changes must not rebase the zoom tracker as rotation or
browser restoration. Returning to normal size preserves the viewed column,
vertical position and visible navigation. Keep the accepted default/minimum
zoom behavior. A dedicated 200-host overview remains future work. The page opens at its
usual size with no zoom buttons, saved zoom preference, new data reads or
refresh-scheduling changes; this motion repair changes no viewport-meta settings.
Track the integer settled width so fractional rounding cannot leave a persistent
native pan. Use the same floating-point tolerance around the baseline for
restoring normal layout and entering magnification; a 1% classification band
leaves real browser zoom unhandled.

For a settled, contained canvas without magnification, use native fixed
sidebar/header edges when native and visible widths match within rounding
tolerance. The column-heading timeline inset then uses only header height.
Retain measured geometry for active/exposed pinches and mismatched restored
baselines. This choice follows measured browser geometry, with no device-model
or version branches; dialogs always use the actual visible bounds.

Dialogs use the visible screen's bounds rather than the naturally wide table's
layout viewport. Their heading and Close controls normally remain above
independently scrolling content. Close may use an accessible × in limited space;
below 120 CSS pixels of visible height it stays beside the scrolling content,
and the visually hidden title remains the dialog's accessible name. Preserve
readable content, focus and the existing source-details disclosure.

## Complete-component acceptance

Exercise the whole component and the user journey, including boundary states.
Checking only the recently changed element is insufficient.

| Dimension | Required coverage |
| --- | --- |
| Context | Desktop plus mobile Chromium contexts with `isMobile` and `hasTouch`; a narrow desktop viewport alone is insufficient. |
| Mobile sizes | Portrait 320×844 and 390×844; landscape 844×390; short-height 667×240. |
| Navigation | Expanded and collapsed menus; first and last rows; leftmost and rightmost columns; Scenario; Tools & diagnostics; existing detail dialogs. |
| Scroll structure | On the supported native path, horizontal table movement keeps heading/body aligned; all rows contribute their full height to document scrolling, with no inner vertical scroll range. Verify existing heading controls and unsupported fallback separately. |
| Viewport movement | Native vertical/horizontal touch panning, rotation, resizing, and reload after panning. Include fresh/restored non-default browser scale and Real200 rotation without pinching, using isolated fixtures. |
| Zoom | Normal baseline, requested 2× and 5× zoom, and requested 0.5× zoom where the browser permits it, plus actual two-touch focal-point pinch gestures. Record actual geometry, browser scale and relative zoom; browser minimums may clamp zoom-out. This is a bounded matrix, not unlimited zoom acceptance. |
| Whole-table zoom-out | Actual two-finger contraction at both 320px and 390px portrait, with every combination of expanded/collapsed menu, separate/combined Queued–Duration and compact/expanded field displays. Require the first and last columns simultaneously visible and unclipped. Start both at the first column and after sideways table scrolling; pan while zoomed out, zoom back through normal size, rotate, reload and hide/resume. Require a visible Fleet bar, full-height sidebar and original column headings pinned below the bar after vertical scrolling. Check blank areas, column/vertical-position jumps, navigation overlap and restoration of normal scrolling. |
| Intermediate zoom-out motion | At 320px/390px, both menu states and native scales around 0.75×/0.55×, move one finger in both axes. Verify native document/table scroll progress and near-zero visual-viewport offsets. Inspect compositor frames during brief main-thread pressure as well as settled bounds; include reverse movement and repeated contraction after sideways scrolling. Preserve default/minimum endpoints. |
| Fractional and near-baseline motion | Include a noninteger visible-width case around 0.813323× and genuine magnification near relative 1.003×–1.009×. Check persistent movement on repeated pans after release, inward integer containment, the matching restore/magnification threshold, and native fixed-edge selection. Preserve exposed-pinch and restored-baseline fallbacks and dialogs' actual visible bounds. |
| Geometry and access | At the normal baseline and while zoomed out, sidebar top/bottom edges, reachable toggle/footer, visible Fleet bar and column headings pinned below it except in short-height mode. Above the baseline, immediate non-overlap and shared document coordinates, then recovery of offscreen bars through native panning/zoom-out. At every scale, non-overlapping controls and bounded dialogs with reachable Close. |
| Refresh | Offscreen rows keep refreshing while the page is visible; expanded menus do not change reads; hidden pages pause and resume overdue reads correctly. |
| Persistence | Existing local preferences and approved defaults survive reload; opening menus, dialogs or diagnostics introduces no new preference or data behavior. |

Assert geometry before a locator action or helper can scroll an element into
view and conceal a defect. A DOM element being visible does not prove it is
inside the visible screen: check visual-viewport bounds first, then hit testing.
Require targets to clear the fixed menu/header and fit their clipping ancestors,
including menu and dialog scroll regions, before treating them as reachable.
Shared document-flow checks must verify the full table/row height, zero table
wrapper vertical scroll range and `scrollTop`, and Scenario/diagnostics ordering;
literal `overflow: visible` is not the preservation contract.
Reach controls through actual touch navigation and deliberately scroll menu or
dialog contents where required. Review screenshots of complete boundary states,
including short/zoomed menus and dialogs; screenshots alone do not establish
interaction or refresh correctness.
Eventual reachability alone is insufficient: assert that a pinch never moves
the menu or header onto chart content before navigation begins.

Run shared desktop/mobile assertions through `npm run check` with the pinned
toolchain and isolated fixtures. Use the 90-second existing header/sidebar
and 360-second sustained-test wall-clock allowances without relaxing application
timing assertions or reducing simulated workloads. The broader new shell and
200-row touch journeys use 120-second wall-clock allowances after taking about
80 seconds under the full suite; existing fixed-navigation tests use 90 seconds.
Require a clean full run before declaring automated parity complete. Report
failed checks and their resolution with the change; keep raw local evidence
outside Git.

## Physical Chrome verification

Mobile Chromium emulation exercises visual-viewport geometry and touch
navigation. It does not establish physical Chrome address-bar expansion and
collapse, browser chrome interaction or device safe-area handling. The complete
physical-device acceptance matrix remains unverified.

On a physical phone, repeat expanded/collapsed menus, vertical and horizontal
panning, reload after panning, rotation, normal/increased/permitted-decreased
zoom, short-landscape footer access, detail dialogs and hide/resume recovery.
Observe the sidebar's top/bottom edges and visible Fleet bar at the baseline and
while zoomed out, pinned column headings after vertical scrolling, immediate
separation during magnification above the baseline, offscreen recovery, toggle
and Close controls while Chrome's address bar changes and around device safe
areas. Include intermediate and fractional zoom levels and inspect motion during
gestures as well as settled positions. Record device, browser, conditions and
results separately from automated checks. Do not claim complete phone/laptop
parity or universal browser smoothness from emulation alone.

## Remaining UX work

- A dedicated 200-host overview remains a separate feature. Whole-table native
  zoom-out supports viewing all columns, but does not fit every fleet row onscreen.
- A mobile information-bubble preference remains unimplemented; preserve existing
  tap-open details and the approved body-detail exclusions.
- The full physical Chrome address-bar and safe-area matrix remains open.
- Unsupported browser layout fallbacks retain functional checks, without an
  unverified claim that their scroll smoothness matches the native path.

See [development status](DEVELOPMENT.md) for broader field and integration work.
