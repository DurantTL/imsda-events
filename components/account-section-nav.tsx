"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export type AccountNavItem = {
  href: string;
  label: string;
  /** Also active on pages below this one (e.g. every club screen for "My clubs"). */
  matchChildren?: boolean;
};

function isActive(pathname: string, item: AccountNavItem) {
  if (pathname === item.href) return true;
  return Boolean(item.matchChildren) && pathname.startsWith(`${item.href}/`);
}

/**
 * Tabs across the attendee and club-director pages. On a phone the row
 * scrolls sideways and keeps the current tab in view instead of wrapping into
 * a tall stack of buttons.
 */
export function AccountSectionNav({
  items,
  label,
  variant = "primary",
}: {
  items: AccountNavItem[];
  label: string;
  variant?: "primary" | "secondary";
}) {
  const pathname = usePathname();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const current = listRef.current?.querySelector<HTMLElement>("[aria-current=page]");
    current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <nav aria-label={label} className={`account-nav account-nav-${variant}`}>
      <ul ref={listRef}>
        {items.map((item) => (
          <li key={item.href}>
            <Link aria-current={isActive(pathname, item) ? "page" : undefined} href={item.href}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
