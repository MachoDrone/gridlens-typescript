import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Existing diagnostic tests opt in through the same disclosure users open. */
export async function openPreviewTools(page: Page): Promise<void> {
  const tools = page.locator("#preview-tools");
  await expect(tools).toHaveCount(1);
  if (await tools.getAttribute("open") === null) {
    const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    await tools.locator(":scope > summary").click();
    await expect(tools).toHaveAttribute("open", "");
    await page.evaluate(position => scrollTo(position.x, position.y), scroll);
  }
}

/** Horizontal scrolling must not turn Fleet into a clipped vertical viewport. */
export async function expectFleetDocumentFlow(page: Page, { native = true }: { native?: boolean } = {}): Promise<void> {
  const root = page.locator("html");
  if (native) await expect(root).toHaveAttribute("data-native-table-scroll", "true");
  else await expect(root).not.toHaveAttribute("data-native-table-scroll", "true");
  const region = page.getByRole("region", { name: "Fleet table", exact: true });
  await expect(region).toHaveCSS("overflow-x", native ? "auto" : "visible");
  await expect(region).toHaveCSS("overflow-y", native ? "hidden" : "visible");
  await expect.poll(() => region.evaluate(wrapper => {
    const table = wrapper.querySelector<HTMLTableElement>("table")!;
    const tableBox = table.getBoundingClientRect();
    const wrapperBox = wrapper.getBoundingClientRect();
    const innerTop = wrapperBox.top + wrapper.clientTop;
    const innerBottom = innerTop + wrapper.clientHeight;
    const rows = [...table.querySelectorAll<HTMLTableRowElement>("tbody tr")]
      .map(row => row.getBoundingClientRect());
    const scenario = document.querySelector<HTMLSelectElement>("#scenario")!.getBoundingClientRect();
    const tools = document.querySelector<HTMLElement>("#preview-tools")!.getBoundingClientRect();
    // Fractional layout boxes may differ from integral clientHeight by <1px.
    const tolerance = 1;
    return {
      innerScrollTop: wrapper.scrollTop,
      innerVerticalRange: Math.max(0, wrapper.scrollHeight - wrapper.clientHeight),
      fullTableHeight: wrapper.clientHeight + tolerance >= tableBox.height,
      tableInsideWrapper: tableBox.top >= innerTop - tolerance && tableBox.bottom <= innerBottom + tolerance,
      rowsInDocumentFlow: rows.every((row, index) => row.height > 0 &&
        row.top >= (index === 0 ? tableBox.top : rows[index - 1]!.bottom) - tolerance &&
        row.bottom <= tableBox.bottom + tolerance),
      tableInsideDocument: tableBox.bottom + window.scrollY <= document.documentElement.scrollHeight + tolerance,
      scenarioAfterTable: scenario.top >= tableBox.bottom - tolerance,
      toolsAfterScenario: tools.top >= scenario.bottom - tolerance,
    };
  }), { message: "Fleet must retain its full table and row height in ordinary vertical document flow" }).toEqual({
    innerScrollTop: 0,
    innerVerticalRange: 0,
    fullTableHeight: true,
    tableInsideWrapper: true,
    rowsInDocumentFlow: true,
    tableInsideDocument: true,
    scenarioAfterTable: true,
    toolsAfterScenario: true,
  });
}
