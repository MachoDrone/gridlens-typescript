import type { CDPSession, Page } from "@playwright/test";

/** Exact geometry endpoints with the same trusted intent signal as native pinch. */
export async function setBrowserPinchScale(page: Page, session: CDPSession, scale: number): Promise<void> {
  const visible = await page.evaluate(() => ({ width: visualViewport!.width, height: visualViewport!.height }));
  const x = visible.width * .6, y = visible.height * .5, spread = Math.min(12, visible.height / 4);
  // setPageScaleFactor alone emits no user-input cue. Without one, a following
  // resize is indistinguishable from browser rotation/restoration. The separate
  // moving two-finger tests validate the actual native zoom and focal point.
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
    { id: 0, x, y: y - spread }, { id: 1, x, y: y + spread },
  ] });
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: scale });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
