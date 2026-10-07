"use client";

import { useEffect } from "react";

/**
 * A Content-Security-Policy belongs to the document, and a client-side
 * navigation keeps the policy of the page it left. The public event page's
 * policy admits the video and map frames (next.config.ts), so a visitor who
 * reached it through a `<Link>` from a page with the locked policy would see
 * blank frames. This asks for one full load of the page in that case; a visitor
 * who arrived by a normal page load is never reloaded.
 */
export function EventEmbedFullLoad() {
  useEffect(() => {
    try {
      const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (!entry) return;
      const trim = (path: string) => path.replace(/\/+$/, "") || "/";
      if (trim(new URL(entry.name).pathname) === trim(window.location.pathname)) return;
      const key = `event-embed-reload:${window.location.pathname}`;
      // One attempt per tab and page, so a surprise can never become a loop.
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
      window.location.reload();
    } catch {
      // Without these APIs the page still works; the frames may need a refresh.
    }
  }, []);
  return null;
}
