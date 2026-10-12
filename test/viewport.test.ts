import assert from "node:assert/strict";
import test from "node:test";
import { PageZoomTracker } from "../src/preview/viewport.ts";

const portrait = { width: 390, height: 844, innerWidth: 1133, innerHeight: 2452 };
const landscape = { width: 844, height: 390, innerWidth: 1301, innerHeight: 602 };

test("a newly loaded page treats a restored browser scale as its normal view", () => {
  const zoom = new PageZoomTracker();
  assert.equal(zoom.measure(2, portrait, 0).relativeScale, 1);
  assert.equal(zoom.measure(2, portrait, 1000).relativeScale, 1);
  zoom.pinch(1100);
  assert.equal(zoom.measure(3, portrait, 1110).relativeScale, 1.5);
  assert.equal(zoom.measure(2, portrait, 1200).relativeScale, 1);
});

test("late startup restoration with unchanged layout joins the initial baseline", () => {
  const zoom = new PageZoomTracker();
  assert.equal(zoom.measure(1, portrait, 0).relativeScale, 1);
  zoom.layoutChanged(100); // pageshow extends the existing startup calibration.
  assert.equal(zoom.measure(2, portrait, 300).relativeScale, 1);
  const settled = zoom.measure(2, portrait, 400);
  assert.equal(settled.relativeScale, 1);
  assert.equal(settled.baselineScale, 2);
  assert.equal(settled.settleAt, null);
});

test("pageshow restoration is consumed when rendering delays its first measurement beyond the settle deadline", () => {
  const zoom = new PageZoomTracker();
  // Captured Chromium reload at 4x CPU: scale restored at pageshow 605ms,
  // but the first queued geometry update did not run until 1407ms.
  zoom.measure(1, portrait, 319);
  zoom.layoutChanged(605);
  const restored = zoom.measure(1.92, portrait, 1407);
  assert.equal(restored.relativeScale, 1);
  assert.equal(restored.baselineScale, 1.92);
  assert.equal(restored.settleAt, null);
  // Consuming the delayed event does not swallow later ordinary zoom changes.
  assert.equal(zoom.measure(3.84, portrait, 1900).relativeScale, 2);
});

test("a real pinch still cancels an overdue restoration before its first measurement", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(1, portrait, 319);
  zoom.layoutChanged(605);
  zoom.pinch(1400);
  const pinched = zoom.measure(1.92, portrait, 1407);
  assert.equal(pinched.relativeScale, 1.92);
  assert.equal(pinched.baselineScale, 1);
  assert.equal(pinched.settleAt, null);
});

test("a genuine early pinch bypasses startup and pageshow calibration", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(1, portrait, 0);
  zoom.pinch(50);
  assert.equal(zoom.measure(2, portrait, 100).relativeScale, 2);
  zoom.layoutChanged(120); // A late pageshow must not turn this into a baseline.
  assert.equal(zoom.measure(2, portrait, 150).relativeScale, 2);
});

test("rotation can deliver its layout and scale in separate frames without becoming a pinch", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(1, portrait, 0);
  zoom.layoutChanged(1000);
  assert.equal(zoom.measure(1, landscape, 1001).relativeScale, 1);
  assert.equal(zoom.measure(1.88, landscape, 1030).relativeScale, 1);
  const stable = zoom.measure(1.88, landscape, 1300);
  assert.equal(stable.relativeScale, 1);
  assert.equal(stable.baselineScale, 1.88);
  assert.equal(stable.settleAt, null);
});

test("an ungestured scale change arriving before its rotation layout also rebases", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(1, portrait, 0);
  assert.equal(zoom.measure(1.88, portrait, 1000).relativeScale, 1.88);
  zoom.layoutChanged(1016);
  assert.equal(zoom.measure(1.88, landscape, 1032).relativeScale, 1);
  assert.equal(zoom.measure(1.88, landscape, 1300).relativeScale, 1);
});

test("scale changes after a stable layout work without touch-specific events", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(1, portrait, 0);
  assert.equal(zoom.measure(2, portrait, 1000).relativeScale, 2);
  assert.equal(zoom.measure(1, portrait, 1500).relativeScale, 1);
  assert.equal(zoom.measure(0.75, portrait, 2000).relativeScale, 0.75);
});

test("a real pinch starting before a layout resize cannot be absorbed by rebasing", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(1, portrait, 0);
  zoom.pinch(1000);
  zoom.layoutChanged(1001);
  assert.equal(zoom.measure(2, landscape, 1016).relativeScale, 2);
  assert.equal(zoom.measure(1, landscape, 1100).relativeScale, 1);
});

test("a real pinch during orientation settling immediately keeps its intentional magnification", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(1, portrait, 0);
  assert.equal(zoom.measure(1.88, landscape, 1000).relativeScale, 1);
  zoom.pinch(1010);
  assert.equal(zoom.measure(3.76, landscape, 1020).relativeScale, 2);
  zoom.layoutChanged(1030);
  assert.equal(zoom.measure(3.76, landscape, 1040).relativeScale, 2);
  assert.equal(zoom.measure(1.88, landscape, 1100).relativeScale, 1);
});

test("rotation preserves a settled genuine zoom ratio and permits returning to the new baseline", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(1, portrait, 0);
  zoom.pinch(1000);
  assert.equal(zoom.measure(2, portrait, 1010).relativeScale, 2);
  zoom.layoutChanged(2000);
  assert.equal(zoom.measure(2, landscape, 2001).relativeScale, 2);
  assert.equal(zoom.measure(3.76, landscape, 2030).relativeScale, 2);
  assert.equal(zoom.measure(3.76, landscape, 2300).relativeScale, 2);
  zoom.pinch(2400);
  assert.equal(zoom.measure(1.88, landscape, 2410).relativeScale, 1);
});

test("the layout settle window ends, so later ordinary viewport zoom is not swallowed", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(1, portrait, 0);
  zoom.layoutChanged(1000);
  zoom.measure(1.88, landscape, 1010);
  zoom.measure(1.88, landscape, 1300);
  assert.equal(zoom.measure(3.76, landscape, 1500).relativeScale, 2);
});

test("exposing a wider app canvas preserves the pinch baseline after gesture signals expire", () => {
  const zoom = new PageZoomTracker();
  zoom.measure(2, portrait, 0);
  zoom.measure(2, portrait, 500);
  zoom.pinch(1000);
  assert.equal(zoom.measure(1, portrait, 1010).relativeScale, 0.5);
  const wideCanvas = { ...portrait, innerWidth: 3000, innerHeight: 6492 };
  zoom.canvasChanged(wideCanvas);
  const delayed = zoom.measure(0.5, wideCanvas, 2000);
  assert.equal(delayed.relativeScale, 0.25);
  assert.equal(delayed.baselineScale, 2);
  assert.equal(delayed.settleAt, null);
});

test("restoring the app scroller retains its original baseline and later native gestures", () => {
  const zoom = new PageZoomTracker();
  const wideCanvas = { ...portrait, innerWidth: 3000, innerHeight: 6492 };
  zoom.measure(2, portrait, 0);
  zoom.measure(2, portrait, 500);
  zoom.pinch(1000);
  zoom.canvasChanged(wideCanvas);
  assert.equal(zoom.measure(0.5, wideCanvas, 1010).relativeScale, 0.25);
  zoom.pinch(2000);
  assert.equal(zoom.measure(2, wideCanvas, 2010).relativeScale, 1);
  zoom.canvasChanged(portrait);
  const restored = zoom.measure(2, portrait, 2500);
  assert.equal(restored.relativeScale, 1);
  assert.equal(restored.baselineScale, 2);
  assert.equal(restored.settleAt, null);
  zoom.pinch(3000);
  assert.equal(zoom.measure(4, portrait, 3010).relativeScale, 2);
});

test("a genuine rotation still rebases after the app adopts its wide canvas", () => {
  const zoom = new PageZoomTracker();
  const widePortrait = { ...portrait, innerWidth: 3000, innerHeight: 6492 };
  const wideLandscape = { ...landscape, innerWidth: 3000, innerHeight: 1386 };
  zoom.measure(1, portrait, 0);
  zoom.measure(1, portrait, 500);
  zoom.pinch(1000);
  zoom.canvasChanged(widePortrait);
  assert.equal(zoom.measure(0.25, widePortrait, 1010).relativeScale, 0.25);
  zoom.layoutChanged(2000);
  assert.equal(zoom.measure(0.25, wideLandscape, 2010).relativeScale, 0.25);
  const rotated = zoom.measure(0.5, wideLandscape, 2030);
  assert.equal(rotated.relativeScale, 0.25);
  assert.equal(rotated.baselineScale, 2);
  zoom.measure(0.5, wideLandscape, 2300);
  zoom.pinch(2400);
  assert.equal(zoom.measure(2, wideLandscape, 2410).relativeScale, 1);
});

test("app canvas adoption clears a pending restoration without absorbing zoom", () => {
  const zoom = new PageZoomTracker();
  const wideCanvas = { ...portrait, innerWidth: 3000, innerHeight: 6492 };
  zoom.measure(1, portrait, 0);
  zoom.measure(1, portrait, 500);
  zoom.layoutChanged(1000);
  zoom.canvasChanged(wideCanvas);
  const measured = zoom.measure(0.5, wideCanvas, 1010);
  assert.equal(measured.relativeScale, 0.5);
  assert.equal(measured.baselineScale, 1);
  assert.equal(measured.settleAt, null);
});
