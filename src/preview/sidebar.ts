const SIDEBAR_PREFERENCE = "gridlens.preview.sidebar.v1";
const root = document.documentElement;
const toggle = document.querySelector<HTMLButtonElement>("#sidebar-toggle")!;
const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const footer = document.querySelector<HTMLElement>(".sidebar-footer")!;
const narrow = window.matchMedia("(max-width: 760px)");
let expanded = !narrow.matches;

// Only the header and menu entries size the expanded panel. Footer links wrap
// within that width, including when fonts or menu labels change.
const header = sidebar.querySelector<HTMLElement>(".sidebar-header")!;
const navigation = sidebar.querySelector<HTMLElement>(".sidebar-navigation")!;
function updateSidebarWidth(): void {
  const style = getComputedStyle(sidebar);
  const edges = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth]
    .reduce((total, value) => total + parseFloat(value), 0);
  const width = Math.ceil(Math.max(header.getBoundingClientRect().width, navigation.getBoundingClientRect().width) + edges);
  root.style.setProperty("--sidebar-expanded-width", `${width}px`);
}
const sizeObserver = new ResizeObserver(updateSidebarWidth);
sizeObserver.observe(header);
sizeObserver.observe(navigation);
updateSidebarWidth();

try {
  const saved = localStorage.getItem(SIDEBAR_PREFERENCE);
  if (saved === "expanded" || saved === "collapsed") expanded = saved === "expanded";
} catch { /* The menu still works when browser storage is unavailable. */ }

function renderSidebar(): void {
  root.dataset.sidebar = expanded ? "expanded" : "collapsed";
  toggle.setAttribute("aria-expanded", String(expanded));
  const action = expanded ? "Collapse menu" : "Expand menu";
  toggle.setAttribute("aria-label", action);
  toggle.title = action;
  // Hidden footer links must not receive focus while the icon rail is shown.
  footer.inert = !expanded;
}

function setExpanded(value: boolean): void {
  expanded = value;
  renderSidebar();
  try {
    localStorage.setItem(SIDEBAR_PREFERENCE, expanded ? "expanded" : "collapsed");
  } catch { /* Keep the current choice for this page when saving is denied. */ }
}

toggle.addEventListener("click", () => setExpanded(!expanded));
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !expanded || document.querySelector("dialog[open]")) return;
  if (sidebar.contains(document.activeElement)) {
    setExpanded(false);
    toggle.focus({ preventScroll: true });
  }
});
renderSidebar();
