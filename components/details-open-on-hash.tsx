"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A collapsed `<details>` that opens itself when the page address points at it
 * or at an anchor inside it (for example `#two-step-verification` or
 * `#passkeys`), so older links still land on something visible.
 */
export function DetailsOpenOnHash({
  anchors,
  children,
  className,
  id,
}: {
  anchors: readonly string[];
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function openForHash() {
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash || !anchors.includes(hash)) return;
      const details = ref.current;
      if (!details) return;
      details.open = true;
      document.getElementById(hash)?.scrollIntoView();
    }
    openForHash();
    window.addEventListener("hashchange", openForHash);
    return () => window.removeEventListener("hashchange", openForHash);
  }, [anchors]);

  return <details className={className} id={id} ref={ref}>{children}</details>;
}
