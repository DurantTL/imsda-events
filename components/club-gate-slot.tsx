"use client";

import { usePathname } from "next/navigation";

/**
 * Shows the roster's second-step gate everywhere in a club except monthly
 * reports (#377), which hold no birth dates and don't need it. Display only:
 * each page and route still checks access itself.
 */
export function ClubGateSlot({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (/\/reports(\/|$)/.test(pathname)) return null;
  return <>{children}</>;
}
