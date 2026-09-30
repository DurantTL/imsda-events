"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef } from "react";

export type AccountNavItem = {
  href: string;
  label: string;
  /** Also active on pages below this one (e.g. every club screen for "My clubs"). */
  matchChildren?: boolean;
  /** Another section this tab owns (e.g. Area Coordinator club pages under "Clubs"). */
  alsoMatchPrefix?: string;
  /** A heading shown before the first item of each run of items sharing it (e.g. "People"). Items without one sit ungrouped. */
  group?: string;
};

function isActive(pathname: string, item: AccountNavItem) {
  if (pathname === item.href) return true;
  if (item.alsoMatchPrefix && pathname.startsWith(item.alsoMatchPrefix)) return true;
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

  const groupIdBase = useId();
  // Consecutive items sharing a group become one section; ungrouped items stay top level.
  const sections: Array<{ group?: string; items: AccountNavItem[] }> = [];
  for (const item of items) {
    const last = sections[sections.length - 1];
    if (last && last.group === item.group && item.group) last.items.push(item);
    else sections.push({ group: item.group, items: [item] });
  }
  const renderItem = (item: AccountNavItem) => (
    <li key={item.href}>
      <Link aria-current={isActive(pathname, item) ? "page" : undefined} href={item.href}>
        {item.label}
      </Link>
    </li>
  );

  return (
    <nav aria-label={label} className={`account-nav account-nav-${variant}`}>
      <ul ref={listRef}>
        {sections.map((section, index) =>
          section.group ? (
            <li className="account-nav-group" key={`${section.group}-${index}`}>
              <span className="account-nav-group-label" id={`${groupIdBase}-${index}`}>{section.group}</span>
              <ul aria-labelledby={`${groupIdBase}-${index}`}>{section.items.map(renderItem)}</ul>
            </li>
          ) : (
            section.items.map(renderItem)
          ),
        )}
      </ul>
    </nav>
  );
}
