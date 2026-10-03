"use client";

import { useEffect, useSyncExternalStore } from "react";
import { PHONE_SHEET_QUERY } from "@/modules/forms/roster-cards";

/** True at phone width. The server and the first client render say false, so markup matches. */
export function usePhoneViewport(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const query = window.matchMedia(PHONE_SHEET_QUERY);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(PHONE_SHEET_QUERY).matches,
    () => false,
  );
}

/**
 * Makes everything outside `sheet` inert while it is a modal (the same approach
 * as the More launcher): every sibling of the sheet and of each of its
 * ancestors, up to <body>. Only elements this call changed are restored.
 * Returns the restore function.
 */
export function makeBackgroundInert(sheet: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  let node: HTMLElement | null = sheet;
  while (node && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue;
      if (["SCRIPT", "STYLE", "LINK", "TEMPLATE"].includes(sibling.tagName)) continue;
      sibling.inert = true;
      changed.push(sibling);
    }
    node = parent;
  }
  return () => {
    for (const element of changed) element.inert = false;
  };
}

/** While `sheetKey` is set (the open sheet's id), the background is inert and the page behind it does not scroll. */
export function useInertBackground(sheetKey: string | null, sheetRef: { current: HTMLElement | null }) {
  useEffect(() => {
    const sheet = sheetRef.current;
    if (sheetKey === null || !sheet) return;
    const restore = makeBackgroundInert(sheet);
    document.documentElement.classList.add("has-attendee-sheet");
    return () => {
      restore();
      document.documentElement.classList.remove("has-attendee-sheet");
    };
  }, [sheetKey, sheetRef]);
}
