const LAYOUT_SETTLE_MS = 250;
const PINCH_SIGNAL_MS = 350;
// Ignore floating-point noise, not an entire percent of real browser zoom.
const ZOOM_EPSILON = 0.0001;

interface ViewportLayout {
  readonly width: number;
  readonly height: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

/** Browser restoration/rotation can change absolute scale without a user pinch. */
export class PageZoomTracker {
  private baseline: number | null = null;
  private relative = 1;
  private lastScale = 1;
  private layout: ViewportLayout | null = null;
  private pinchUntil = -Infinity;
  private pending: { relative: number; until: number; measured: boolean } | null = null;
  private unsignaledScale: { before: number; at: number } | null = null;

  pinch(at: number): void {
    this.pinchUntil = at + PINCH_SIGNAL_MS;
    this.pending = null;
    this.unsignaledScale = null;
  }

  layoutChanged(at: number): void {
    if (this.baseline === null || at <= this.pinchUntil) return;
    // Some browsers deliver the scale resize before the layout resize. Recover
    // the prior ratio when that ungestured change was part of the same rotation.
    const before = this.unsignaledScale && at - this.unsignaledScale.at <= LAYOUT_SETTLE_MS
      ? this.unsignaledScale.before : this.relative;
    this.pending = { relative: this.pending?.relative ?? before, until: at + LAYOUT_SETTLE_MS, measured: false };
    this.unsignaledScale = null;
  }

  /** A canvas we resized is not browser restoration or device rotation. */
  canvasChanged(layout: ViewportLayout): void {
    this.layout = layout;
    this.pending = null;
    this.unsignaledScale = null;
  }

  measure(scale: number, layout: ViewportLayout, at: number): { relativeScale: number; baselineScale: number; settleAt: number | null } {
    if (this.baseline === null) {
      this.baseline = scale;
      // Browser restoration may arrive after the module starts, without a
      // corresponding layout change. A real early pinch cancels this window.
      this.pending = { relative: 1, until: at + LAYOUT_SETTLE_MS, measured: false };
    }
    // A queued restoration/layout event must reach at least one geometry read.
    // Main-thread rendering can delay its first rAF beyond the settle deadline.
    if (this.pending?.measured && at > this.pending.until) this.pending = null;
    if (this.layout && (Math.abs(layout.width - this.layout.width) > 1 || Math.abs(layout.height - this.layout.height) > 1 ||
        Math.abs(layout.innerWidth - this.layout.innerWidth) > 1 || Math.abs(layout.innerHeight - this.layout.innerHeight) > 1)) {
      this.layoutChanged(at);
    }
    const before = this.relative;
    const rebasing = this.pending !== null;
    if (this.pending && at > this.pinchUntil) {
      this.baseline = scale / this.pending.relative;
      this.pending.measured = true;
    }
    this.relative = scale / this.baseline;
    if (this.pending?.measured && at > this.pending.until) this.pending = null;
    if (!rebasing && at > this.pinchUntil && Math.abs(scale - this.lastScale) > 0.000001 &&
        (!this.unsignaledScale || at - this.unsignaledScale.at > LAYOUT_SETTLE_MS)) {
      this.unsignaledScale = { before, at };
    }
    this.lastScale = scale;
    this.layout = layout;
    return { relativeScale: this.relative, baselineScale: this.baseline, settleAt: this.pending?.until ?? null };
  }
}

/** Share viewport geometry while letting native pinch zoom pan one page canvas. */
export function bindFleetViewport(header: HTMLElement): () => void {
  const document = header.ownerDocument;
  const window = document.defaultView;
  if (window === null) return () => {};
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const wrapper = document.querySelector<HTMLElement>(".fleet-table-wrap");
  const table = wrapper?.querySelector<HTMLTableElement>("table");
  const geometryProperties = ["--fleet-viewport-left", "--fleet-viewport-top", "--fleet-viewport-width", "--fleet-viewport-height",
    "--fleet-canvas-width", "--fleet-canvas-height"] as const;
  let frame: number | null = null;
  let layoutTimer: number | null = null;
  let layoutTimerAt: number | null = null;
  let pageHidden = false;
  let disposed = false;
  let pinching = false;
  let touchSpan: number | null = null;
  let relativeScale = 1;
  let overview: { width: number; exposed: boolean; settledWidth: number } | null = null;
  let overviewNeedsMeasure = false;
  let ownedLayout: ViewportLayout | null = null;
  const zoom = new PageZoomTracker();

  function layout(): ViewportLayout {
    return { width: root.clientWidth, height: root.clientHeight,
      innerWidth: window!.innerWidth, innerHeight: window!.innerHeight };
  }

  function adoptCanvas(): void {
    ownedLayout = layout();
    zoom.canvasChanged(ownedLayout);
    // Width adoption can move a pan between the visual and layout viewports.
    // Publish its new origin in the same turn, before the next paint.
    if (viewport && Number.isFinite(viewport.offsetLeft) && Number.isFinite(viewport.offsetTop)) {
      setProperty("--fleet-viewport-left", `${viewport.offsetLeft}px`);
      setProperty("--fleet-viewport-top", `${viewport.offsetTop}px`);
    }
  }

  function overviewWidth(): number {
    if (!wrapper || !table) return 0;
    const main = wrapper.parentElement!;
    const style = window!.getComputedStyle(main);
    return Math.ceil(table.getBoundingClientRect().width + parseFloat(style.marginLeft) +
      parseFloat(style.paddingLeft) + parseFloat(style.paddingRight));
  }

  function exposeOverview(): void {
    // The legacy CSS fallback already exposes the full document-width table.
    if (overview?.exposed || !viewport || !wrapper || !table || root.dataset.nativeTableScroll !== "true" ||
        document.querySelector("dialog[open]")) return;
    const width = Math.max(overview?.width ?? 0, overviewWidth());
    if (!Number.isFinite(width) || width <= root.clientWidth) return;
    const left = viewport.pageLeft + wrapper.scrollLeft;
    const top = viewport.pageTop;
    overview = { width, exposed: true, settledWidth: 0 };
    setProperty("--fleet-overview-width", `${width}px`);
    root.dataset.fleetOverview = "true";
    root.dataset.fleetOverviewExposed = "true";
    delete root.dataset.nativeOverviewScroll;
    wrapper.scrollLeft = 0;
    // Exposing the table widens Chrome's layout viewport. window.scrollTo alone
    // cannot transfer a previously scrolled column into its visual viewport.
    // A transient, inert point uses the browser's coordinated viewport scroll.
    const padding = window!.getComputedStyle(root);
    const anchor = document.createElement("span");
    anchor.inert = true;
    anchor.setAttribute("aria-hidden", "true");
    Object.assign(anchor.style, { position: "absolute", width: "1px", height: "1px", opacity: "0",
      pointerEvents: "none", scrollMargin: "0px",
      left: `${left + (parseFloat(padding.scrollPaddingLeft) || 0)}px`,
      top: `${top + (parseFloat(padding.scrollPaddingTop) || 0)}px` });
    document.body.append(anchor);
    try { anchor.scrollIntoView({ inline: "start", block: "start", behavior: "instant" }); }
    finally { anchor.remove(); }
    adoptCanvas();
    schedule();
  }

  function settleOverview(): void {
    if (!overview || !viewport || !wrapper) return;
    const visibleWidth = viewport.width;
    if (!Number.isFinite(visibleWidth) || visibleWidth <= 0) return;
    // Keep an all-column overview exposed when the table itself still fits.
    // Rotation can widen responsive cells while native minimum zoom rounds the
    // unused right gutter. Containing that already-visible table would clip its
    // last fractional pixels inside the inward-rounded scroll window. Require
    // naturally coincident viewports, so deliberate partial overviews still
    // receive their existing inward-rounded containment.
    const tableBox = overview.exposed ? table?.getBoundingClientRect() : undefined;
    const tableFits = tableBox !== undefined && tableBox.left >= viewport.offsetLeft &&
      tableBox.right <= viewport.offsetLeft + visibleWidth && Math.abs(window!.innerWidth - visibleWidth) <= 1.1;
    if (overview.exposed && (visibleWidth >= overview.width - 1 || tableFits)) return;
    // A fractional CSS width can round the layout viewport upward and leave
    // a persistent visual pan. Round inward so the browser fits the selected
    // canvas, allowing less than one CSS pixel of native scale rounding.
    const width = Math.floor(visibleWidth + ZOOM_EPSILON);
    if (!overview.exposed && width === overview.settledWidth) return;
    const left = viewport.pageLeft + wrapper.scrollLeft;
    const top = viewport.pageTop;
    // Match the layout viewport to the chosen native zoom, containing only
    // horizontal table overflow. One-finger scrolling is then compositor-owned;
    // it does not need JS to chase a visual viewport inside a wider layout.
    overview.exposed = false;
    overview.settledWidth = width;
    delete root.dataset.fleetOverviewExposed;
    delete root.dataset.nativeOverviewScroll;
    setProperty("--fleet-overview-width", `${width}px`);
    wrapper.scrollLeft = left;
    window!.scrollTo({ left: 0, top: top - viewport.offsetTop, behavior: "instant" });
    wrapper.scrollLeft = left - viewport.pageLeft;
    adoptCanvas();
    schedule();
  }

  function restoreScroller(): void {
    if (!overview || !wrapper || !viewport) return;
    // Carry the visible table column/row back from page panning into the normal
    // horizontal scroller. There is still only one table and one set of controls.
    const left = viewport.pageLeft + wrapper.scrollLeft;
    const top = viewport.pageTop;
    overview = null;
    overviewNeedsMeasure = false;
    delete root.dataset.fleetOverview;
    delete root.dataset.fleetOverviewExposed;
    delete root.dataset.nativeOverviewScroll;
    root.style.removeProperty("--fleet-overview-width");
    // Force the smaller layout before reading its surviving visual pan. At a
    // slightly magnified endpoint the browser can retain nonzero offsets.
    wrapper.scrollLeft = left;
    window!.scrollTo({ left: 0, top: top - viewport.offsetTop, behavior: "instant" });
    wrapper.scrollLeft = left - viewport.pageLeft;
    adoptCanvas();
    schedule();
  }

  function clearGeometry(): void {
    for (const property of geometryProperties) root.style.removeProperty(property);
  }

  function setProperty(property: string, value: string): void {
    if (root.style.getPropertyValue(property) !== value) root.style.setProperty(property, value);
  }

  function measureHeader(borderBoxHeight = header.offsetHeight): void {
    if (disposed || pageHidden || document.hidden || !Number.isFinite(borderBoxHeight) || borderBoxHeight <= 0) return;
    root.dataset.narrowHeader = String(header.getBoundingClientRect().width < 160);
    // The header stays auto-sized: only page spacing and sticky cells use this value.
    setProperty("--fleet-header-height", `${Math.ceil(borderBoxHeight)}px`);
  }

  function cancelFrame(): void {
    if (frame !== null) window!.cancelAnimationFrame(frame);
    frame = null;
  }

  function cancelLayoutTimer(): void {
    if (layoutTimer !== null) window!.clearTimeout(layoutTimer);
    layoutTimer = layoutTimerAt = null;
  }

  function update(): void {
    frame = null;
    if (disposed || pageHidden || document.hidden) return;
    if (overview && overviewNeedsMeasure) {
      overviewNeedsMeasure = false;
      const nextWidth = overviewWidth();
      // Toggles and new values may need more room. Never shrink the canvas
      // underneath an active gesture or horizontal pan.
      if (Number.isFinite(nextWidth) && nextWidth > overview.width) {
        overview.width = nextWidth;
        if (overview.exposed) {
          setProperty("--fleet-overview-width", `${nextWidth}px`);
          adoptCanvas();
        }
      }
    }
    let scale = 1;
    if (viewport === undefined || viewport === null ||
        ![viewport.offsetLeft, viewport.offsetTop, viewport.width, viewport.height].every(Number.isFinite) ||
        viewport.width <= 0 || viewport.height <= 0) {
      clearGeometry();
    } else {
      setProperty("--fleet-viewport-left", `${viewport.offsetLeft}px`);
      setProperty("--fleet-viewport-top", `${viewport.offsetTop}px`);
      setProperty("--fleet-viewport-width", `${viewport.width}px`);
      setProperty("--fleet-viewport-height", `${viewport.height}px`);
      if (Number.isFinite(viewport.scale) && viewport.scale > 0) scale = viewport.scale;
    }
    const width = parseFloat(root.style.getPropertyValue("--fleet-viewport-width")) || root.clientWidth;
    const height = parseFloat(root.style.getPropertyValue("--fleet-viewport-height")) || window!.innerHeight;
    const at = window!.performance.now();
    const measured = zoom.measure(scale, layout(), at);
    if (measured.settleAt !== layoutTimerAt) {
      cancelLayoutTimer();
      if (measured.settleAt !== null) {
        layoutTimerAt = measured.settleAt;
        layoutTimer = window!.setTimeout(() => {
          layoutTimer = layoutTimerAt = null;
          schedule();
        }, Math.max(1, measured.settleAt - at + 1));
      }
    }
    const ratio = measured.relativeScale;
    relativeScale = ratio;
    if (overview && !pinching) {
      if (ratio >= 1 - ZOOM_EPSILON) restoreScroller();
      else settleOverview();
    }
    // A restored scale belongs to this page's baseline. Only magnification from
    // that baseline pans navigation with the document. Zoom-out keeps the bars
    // anchored and the sidebar at the full visible height, including while the
    // wider table canvas is exposed. Column pinning follows the same distinction.
    setProperty("--fleet-canvas-width", `${width * ratio}px`);
    setProperty("--fleet-canvas-height", `${height * ratio}px`);
    const magnified = ratio > 1 + ZOOM_EPSILON;
    const navigationWidth = magnified ? width * ratio : width;
    const navigationHeight = magnified ? height * ratio : height;
    root.dataset.pageZoomed = String(overview !== null || Math.abs(ratio - 1) > ZOOM_EPSILON);
    root.dataset.pageMagnified = String(magnified);
    // Fixed edge constraints follow the native layout viewport directly once
    // the contained canvas fits it. Keep measured positioning for active pinch,
    // exposed minimum and restored baselines with a smaller visual viewport.
    root.dataset.nativeOverviewScroll = String(overview !== null && !overview.exposed && !pinching && !magnified &&
      viewport !== undefined && viewport !== null && Math.abs(window!.innerWidth - viewport.width) <= 1.1);
    root.dataset.pageZoomRatio = String(ratio);
    root.dataset.compactViewport = String(navigationWidth < 100);
    root.dataset.compactDialog = String(width < 200 || height < 180);
    root.dataset.shortViewport = String(height < 120);
    root.dataset.shortNavigation = String(navigationHeight < 120);
    root.dataset.scrollColumnHeaders = String(magnified || height < 200);
    root.dataset.compactHeader = String(navigationHeight < 80);
    measureHeader();
  }

  function schedule(): void {
    if (disposed || pageHidden || document.hidden || frame !== null) return;
    frame = window!.requestAnimationFrame(update);
  }

  const scrolled = (): void => {
    if (disposed || pageHidden || document.hidden) return;
    // Native table containment makes ordinary scrolling compositor-owned. A
    // restored browser scale can still pan only the visual viewport; publish
    // its offsets in this event instead of leaving fixed bars one rAF behind.
    // No header/layout measurements belong in this position-only path.
    if (viewport && Number.isFinite(viewport.offsetLeft) && Number.isFinite(viewport.offsetTop)) {
      setProperty("--fleet-viewport-left", `${viewport.offsetLeft}px`);
      setProperty("--fleet-viewport-top", `${viewport.offsetTop}px`);
    }
    schedule();
  };

  const visibilityChanged = (): void => {
    if (document.hidden) { pinching = false; touchSpan = null; cancelFrame(); cancelLayoutTimer(); }
    else schedule();
  };
  const pageHiddenHandler = (): void => { pageHidden = true; pinching = false; touchSpan = null; cancelFrame(); cancelLayoutTimer(); };
  const pageShownHandler = (): void => {
    pageHidden = false;
    if (!overview) zoom.layoutChanged(window!.performance.now());
    schedule();
  };
  const layoutChanged = (): void => {
    if (disposed || pageHidden || document.hidden) return;
    const current = layout();
    // Resize events from our own canvas mutation can arrive well after the
    // touch event. Only a different browser layout is rotation/restoration.
    if (ownedLayout && Object.keys(current).every(key =>
      Math.abs(current[key as keyof ViewportLayout] - ownedLayout![key as keyof ViewportLayout]) <= 1)) {
      schedule();
      return;
    }
    ownedLayout = null;
    zoom.layoutChanged(window!.performance.now());
    schedule();
  };
  const touchChanged = (event: TouchEvent): void => {
    if (disposed || pageHidden || document.hidden) return;
    if (event.touches.length >= 2 || pinching) zoom.pinch(window!.performance.now());
    pinching = event.touches.length >= 2;
    if (pinching) delete root.dataset.nativeOverviewScroll;
    if (event.isTrusted && event.touches.length === 2) {
      const [first, second] = [event.touches[0]!, event.touches[1]!];
      // screen coordinates stay physical as the browser changes page scale.
      const span = Math.hypot(first.screenX - second.screenX, first.screenY - second.screenY);
      if (touchSpan === null) touchSpan = span;
      else if (span < touchSpan - Math.max(6, touchSpan * .04) && relativeScale <= 1.05) exposeOverview();
    } else touchSpan = null;
    if (!pinching) schedule();
  };
  const wheel = (event: WheelEvent): void => {
    if (event.ctrlKey && !disposed && !pageHidden && !document.hidden) zoom.pinch(window!.performance.now());
  };
  const resizeObserver = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(entries => {
    for (const entry of entries) {
      if (entry.target === header) measureHeader(entry.borderBoxSize?.[0]?.blockSize ?? header.offsetHeight);
    }
    if (overview) {
      overviewNeedsMeasure = true;
      schedule();
    }
  }) : null;
  resizeObserver?.observe(header);
  if (table) resizeObserver?.observe(table);
  if (wrapper?.parentElement) resizeObserver?.observe(wrapper.parentElement);
  // Older browsers still remeasure when status text or its styling changes.
  const mutationObserver = resizeObserver === null && typeof window.MutationObserver === "function"
    ? new window.MutationObserver(schedule) : null;
  mutationObserver?.observe(header, { attributes: true, childList: true, characterData: true, subtree: true });
  viewport?.addEventListener("scroll", scrolled, { passive: true });
  viewport?.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", scrolled, { passive: true });
  window.addEventListener("resize", layoutChanged, { passive: true });
  window.addEventListener("orientationchange", layoutChanged, { passive: true });
  window.screen.orientation?.addEventListener("change", layoutChanged);
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
    document.addEventListener(type, touchChanged, { passive: true });
  }
  document.addEventListener("wheel", wheel, { passive: true });
  window.addEventListener("pageshow", pageShownHandler);
  window.addEventListener("pagehide", pageHiddenHandler);
  document.addEventListener("visibilitychange", visibilityChanged);
  update();
  return () => {
    disposed = true;
    cancelFrame();
    cancelLayoutTimer();
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    viewport?.removeEventListener("scroll", scrolled);
    viewport?.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", scrolled);
    window.removeEventListener("resize", layoutChanged);
    window.removeEventListener("orientationchange", layoutChanged);
    window.screen.orientation?.removeEventListener("change", layoutChanged);
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
      document.removeEventListener(type, touchChanged);
    }
    document.removeEventListener("wheel", wheel);
    window.removeEventListener("pageshow", pageShownHandler);
    window.removeEventListener("pagehide", pageHiddenHandler);
    document.removeEventListener("visibilitychange", visibilityChanged);
    clearGeometry();
    delete root.dataset.fleetOverview;
    delete root.dataset.fleetOverviewExposed;
    delete root.dataset.nativeOverviewScroll;
    root.style.removeProperty("--fleet-overview-width");
    root.style.removeProperty("--fleet-header-height");
    delete root.dataset.narrowHeader;
    delete root.dataset.compactViewport;
    delete root.dataset.compactDialog;
    delete root.dataset.shortViewport;
    delete root.dataset.shortNavigation;
    delete root.dataset.pageZoomed;
    delete root.dataset.pageMagnified;
    delete root.dataset.pageZoomRatio;
    delete root.dataset.scrollColumnHeaders;
    delete root.dataset.compactHeader;
  };
}
