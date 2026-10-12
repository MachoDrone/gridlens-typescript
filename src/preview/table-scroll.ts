/** Keep native horizontal table scrolling without creating a vertical viewport. */
export function bindFleetTableScroll(wrapper: HTMLElement): () => void {
  const document = wrapper.ownerDocument;
  const window = document.defaultView;
  const table = wrapper.querySelector<HTMLTableElement>("table");
  const heading = table?.tHead;
  if (!window || !table || !heading || typeof window.ResizeObserver !== "function" ||
      !window.CSS?.supports("overflow-x", "clip") ||
      !window.CSS.supports("view-timeline-name", "--fleet-table") ||
      !window.CSS.supports("animation-timeline", "--fleet-table") ||
      !window.CSS.supports("animation-range", "exit-crossing 0% exit-crossing calc(100% - 1px)")) return () => {};

  const root = document.documentElement;
  const properties = ["--fleet-table-height", "--fleet-table-heading-height", "--fleet-table-bottom-space"] as const;
  let disposed = false;
  function measure(): void {
    if (disposed) return;
    const height = table!.offsetHeight;
    const headingHeight = heading!.offsetHeight;
    // A native horizontal scrollbar and the wrapper's border belong below the
    // table. End pinning at the table's bottom, before that extra chrome.
    const bottomSpace = Math.max(0, wrapper.offsetHeight - height);
    for (const [index, value] of [height, headingHeight, bottomSpace].entries()) {
      const property = properties[index]!;
      const next = `${value}px`;
      if (wrapper.style.getPropertyValue(property) !== next) wrapper.style.setProperty(property, next);
    }
  }
  root.dataset.nativeTableScroll = "true";
  const observer = new window.ResizeObserver(measure);
  observer.observe(wrapper);
  observer.observe(table);
  observer.observe(heading);
  measure();
  // Scrolling itself is entirely browser-managed. These measurements change
  // only when layout changes; existing header controls and column widths stay put.
  return () => {
    disposed = true;
    observer.disconnect();
    delete root.dataset.nativeTableScroll;
    for (const property of properties) wrapper.style.removeProperty(property);
  };
}
