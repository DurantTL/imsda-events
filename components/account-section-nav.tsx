"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useLayoutEffect, useRef } from "react";

export type AccountNavItem = {
  href: string;
  label: string;
  /** Also active on pages below this one (e.g. every club screen for "My clubs"). */
  matchChildren?: boolean;
  /** Another section this tab owns, itself and anything below it (e.g. Area Coordinator club pages under "Clubs", or a club's export page under its tab). */
  alsoMatchPrefix?: string;
  /** A heading shown before the first item of each run of items sharing it (e.g. "People"). Items without one sit ungrouped. */
  group?: string;
  /**
   * Leave the group's heading off the screen (the list keeps the name for
   * assistive tech). Set it when the group's own tab already says it, e.g.
   * "Events" above an "Events" tab: a scrolling row can't spare the width.
   */
  hideGroupLabel?: boolean;
};

export function isAccountNavItemActive(pathname: string, item: AccountNavItem) {
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
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Open with the current tab centred in the row (the row scrolls sideways on
  // a phone) before the first paint, then keep the edge fades in step with how
  // far the row is scrolled. Only the row itself scrolls: scrollIntoView could
  // also move the page.
  useLayoutEffect(() => {
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
    const setFade = (name: "fadeStart" | "fadeEnd", on: boolean) => {
      const value = String(on);
      if (nav.dataset[name] !== value) nav.dataset[name] = value;
    };
    const updateFades = () => {
      setFade("fadeStart", list.scrollLeft > 1);
      setFade("fadeEnd", list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
    };
    updateFades();
    list.addEventListener("scroll", updateFades, { passive: true });
    // The row's width changes without it resizing when the tabs reflow (web fonts
    // arriving, a tab label changing), so watch the tabs too and re-check once
    // fonts are ready.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateFades);
    if (observer) {
      observer.observe(list);
      for (const child of Array.from(list.children)) observer.observe(child);
    }
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) updateFades();
    });
    return () => {
      cancelled = true;
      list.removeEventListener("scroll", updateFades);
      observer?.disconnect();
    };
  }, [pathname, items]);

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
      <Link aria-current={isAccountNavItemActive(pathname, item) ? "page" : undefined} href={item.href}>
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
              {section.items.some((item) => item.hideGroupLabel)
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
