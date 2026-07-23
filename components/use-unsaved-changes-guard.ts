"use client";

import { useCallback, useEffect, useRef } from "react";

const defaultMessage = "You have unsaved changes. Leave this page and discard them?";

export function useUnsavedChangesGuard(
  hasUnsavedChanges: boolean,
  message = defaultMessage,
) {
  const allowNavigationRef = useRef(false);

  useEffect(() => {
    if (!hasUnsavedChanges) {
      allowNavigationRef.current = false;
      return;
    }

    function beforeUnload(event: BeforeUnloadEvent) {
      if (allowNavigationRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }

    function beforeLinkNavigation(event: MouseEvent) {
      if (
        allowNavigationRef.current
        || event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;

      const href = link.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      const destination = new URL(link.href, window.location.href);
      if (destination.href === window.location.href) return;
      if (window.confirm(message)) return;

      event.preventDefault();
      event.stopPropagation();
    }

    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeLinkNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", beforeLinkNavigation, true);
    };
  }, [hasUnsavedChanges, message]);

  return useCallback(() => {
    allowNavigationRef.current = true;
  }, []);
}
