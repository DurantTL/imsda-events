"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";

/**
 * A column-header sort link in a `table-cards` table. Under 600px the header row
 * is visually hidden (the cards replace it) but stays in the accessibility tree
 * so each cell keeps its column name; the link inside it must not be a stray,
 * invisible Tab stop there. The phone gets Sort and Direction selects in the
 * filter form instead (docs/RESPONSIVE.md). The first server render is
 * focusable, and the media query takes it out of the tab order once mounted.
 */
const phoneQuery = "(max-width: 600px)";

function subscribe(onChange: () => void) {
  const list = window.matchMedia(phoneQuery);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

export function PhoneHiddenSortLink({ href, children }: { href: string; children: React.ReactNode }) {
  const onPhone = useSyncExternalStore(subscribe, () => window.matchMedia(phoneQuery).matches, () => false);
  return <Link href={href} tabIndex={onPhone ? -1 : undefined}>{children}</Link>;
}
