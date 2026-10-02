/** Per-viewer choice to show the staff sidebar as icons only (#446). */
export const sidebarCollapsedStorageKey = "imsda-staff-sidebar-collapsed";

/** Reads the saved choice. Storage can be missing or throw; the sidebar then stays expanded. */
export function readSidebarCollapsed(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const target = storage ?? window.localStorage;
    return target.getItem(sidebarCollapsedStorageKey) === "1";
  } catch {
    return false;
  }
}

/** Saves the choice. A failure is ignored: the choice still applies until the page is closed. */
export function writeSidebarCollapsed(collapsed: boolean, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const target = storage ?? window.localStorage;
    if (collapsed) target.setItem(sidebarCollapsedStorageKey, "1");
    else target.removeItem(sidebarCollapsedStorageKey);
  } catch {
    // Private windows or blocked site data: nothing to remember.
  }
}

// A small external store so the saved choice is read after hydration (the server
// always renders expanded) and still works when storage is unavailable.
let choice: boolean | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

/** Mirrors the choice on <html>, where the stylesheet reads it (the act-as banner sits outside the shell). */
export function applySidebarAttribute(collapsed: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.sidebar = collapsed ? "collapsed" : "expanded";
}

export function subscribeSidebarCollapsed(listener: () => void) {
  listeners.add(listener);
  // Another tab changed the choice: drop the cached value and re-read storage.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== sidebarCollapsedStorageKey) return;
    choice = null;
    notify();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function getSidebarCollapsedSnapshot(): boolean {
  return choice ?? readSidebarCollapsed();
}

export function getSidebarCollapsedServerSnapshot(): boolean {
  return false;
}

export function setSidebarCollapsed(collapsed: boolean): void {
  choice = collapsed;
  writeSidebarCollapsed(collapsed);
  applySidebarAttribute(collapsed);
  notify();
}

/** Runs before hydration so a full page load never flashes the expanded sidebar. */
export const sidebarCollapseInitScript = `try{document.documentElement.dataset.sidebar=window.localStorage.getItem(${JSON.stringify(sidebarCollapsedStorageKey)})==="1"?"collapsed":"expanded"}catch(e){}`;
