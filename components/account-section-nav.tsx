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
 * A group heading that one of its own tabs already says ("Events" above
 * "Events", "Club" above "Club info") only takes up room in a row that scrolls,
 * so it is left off the screen; the list keeps the name for assistive tech.
 */
function groupLabelIsRedundant(group: string, items: AccountNavItem[]) {
  const name = group.trim().toLowerCase();
  return items.some((item) => item.label.toLowerCase().includes(name));
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
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Open with the current tab centred in the row (the row scrolls sideways on
  // a phone), then keep the edge fades in step with how far the row is scrolled.
  // Only the row itself scrolls: scrollIntoView could also move the page.
  useEffect(() => {
    const nav = navRef.current;
    const list = listRef.current;
    if (!nav || !list) return;
    const current = list.querySelector<HTMLElement>("[aria-current=page]");
    if (current) {
      const listBox = list.getBoundingClientRect();
      const currentBox = current.getBoundingClientRect();
      const offset = currentBox.left - listBox.left + list.scrollLeft;
      list.scrollLeft = Math.max(0, offset - (list.clientWidth - currentBox.width) / 2);
    }
    const updateFades = () => {
      nav.dataset.fadeStart = String(list.scrollLeft > 1);
      nav.dataset.fadeEnd = String(list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
    };
    updateFades();
    list.addEventListener("scroll", updateFades, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateFades);
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", updateFades);
      observer?.disconnect();
    };
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
    <nav aria-label={label} className={`account-nav account-nav-${variant}`} ref={navRef}>
      <ul ref={listRef}>
        {sections.map((section, index) =>
          section.group ? (
            <li className="account-nav-group" key={`${section.group}-${index}`}>
              {groupLabelIsRedundant(section.group, section.items)
                ? <ul aria-label={section.group}>{section.items.map(renderItem)}</ul>
                : (
                  <>
                    <span className="account-nav-group-label" id={`${groupIdBase}-${index}`}>{section.group}</span>
                    <ul aria-labelledby={`${groupIdBase}-${index}`}>{section.items.map(renderItem)}</ul>
                  </>
                )}
            </li>
          ) : (
            section.items.map(renderItem)
          ),
        )}
      </ul>
    </nav>
  );
}
