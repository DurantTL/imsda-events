"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import {
  isPlainClick,
  launcherFooterLinks,
  launcherGroups,
  nextLauncherIndex,
  returnsFocusToTrigger,
  type LauncherCloseReason,
} from "@/components/more-launcher-model";
import type { MoreDirectoryCard } from "@/components/staff-navigation";

/**
 * The More launcher (#741 slice 2). On desktop it is a popover anchored to the
 * sidebar's More item, about 560px wide in two columns; on a phone the same panel
 * is a bottom sheet above the tab bar. It lists every destination the signed-in
 * staff member may open (the universal tools plus the event's enabled modules),
 * grouped Setup / Content & sales / People & access / Reports.
 *
 * The trigger is a real link to `/more` (the Event modules page), so a browser
 * without scripts, or a modified click, still gets somewhere useful. A plain
 * click opens the launcher instead. The launcher only lists links: every page
 * and route handler keeps its own authorization.
 */

/**
 * While the phone sheet is open the page behind it is inert (and the sheet is
 * `aria-modal`), so a screen reader or Tab cannot wander into content the sheet
 * covers. The tab bar is left out, so the trigger can take focus back and other
 * tabs still work.
 */
function setBackgroundInert(inert: boolean) {
  // The sidebar and the main content only: the phone tab bar stays live, so a tap on another tab navigates.
  for (const element of document.querySelectorAll<HTMLElement>(".app-shell > .sidebar, .app-shell > .workspace")) {
    element.inert = inert;
  }
}

export function MoreLauncherPanel({
  cards,
  isSystemAdmin,
  eventQuery,
  id,
  panelRef,
  onNavigate,
  variant,
  style,
}: {
  cards: readonly MoreDirectoryCard[];
  isSystemAdmin: boolean;
  eventQuery: string;
  id?: string;
  panelRef?: Ref<HTMLDivElement>;
  onNavigate?: () => void;
  variant: "sidebar" | "tab";
  style?: HTMLAttributes<HTMLDivElement>["style"];
}) {
  const groups = launcherGroups(cards);
  const footer = launcherFooterLinks({ isSystemAdmin, eventQuery });
  return (
    <div
      className={`more-launcher more-launcher-${variant}`}
      id={id}
      ref={panelRef}
      role="dialog"
      aria-modal={variant === "tab" ? "true" : undefined}
      aria-label="More tools"
      style={style}
    >
      <div className="more-launcher-columns">
        {groups.map(({ group, label, cards: groupCards }) => (
          <section className="more-launcher-group" aria-label={label} key={group} data-group={group}>
            <h2 className="more-launcher-group-label">{label}</h2>
            <ul>
              {groupCards.map((card) => (
                <li key={card.key}>
                  <Link className="more-launcher-item" href={card.href} onClick={onNavigate} data-card={card.key}>
                    <card.icon aria-hidden="true" size={18} strokeWidth={1.9} />
                    <span>{card.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {footer.length > 0 && (
        <div className="more-launcher-footer">
          {footer.map((link) => (
            <Link className="more-launcher-item more-launcher-footer-link" href={link.href} key={link.key} onClick={onNavigate} data-footer={link.key}>
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function MoreLauncher({
  variant,
  href,
  className,
  isActive,
  cards,
  isSystemAdmin,
  eventQuery,
  tipProps = {},
  children,
}: {
  variant: "sidebar" | "tab";
  /** The trigger's own destination (`/more`, with the event), used without scripts or for a modified click. */
  href: string;
  className?: string;
  isActive: boolean;
  cards: readonly MoreDirectoryCard[];
  isSystemAdmin: boolean;
  eventQuery: string;
  tipProps?: HTMLAttributes<HTMLElement>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Close when the route changes (a followed link, or browser Back/Forward that lands on another page).
  const [openedOn, setOpenedOn] = useState(pathname);
  if (open && openedOn !== pathname) setOpen(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((reason: LauncherCloseReason) => {
    setBackgroundInert(false);
    setOpen(false);
    if (returnsFocusToTrigger(reason)) triggerRef.current?.focus();
  }, []);

  // Open: move focus to the first item. Outside press: close without taking focus.
  useEffect(() => {
    if (!open) return;
    if (variant === "tab") setBackgroundInert(true);
    panelRef.current?.querySelector<HTMLElement>("a[href]")?.focus();
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      close("outside");
    }
    // Back/Forward within the same page (a hash or query change) does not change the pathname.
    function onPopState() {
      close("navigate");
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("popstate", onPopState);
      setBackgroundInert(false);
    };
  }, [open, close, variant]);

  function openFromTrigger() {
    if (variant === "sidebar" && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Anchored beside the item, bottom edges aligned, kept inside the viewport.
      setAnchor({ left: Math.round(rect.right + 12), bottom: Math.max(12, Math.round(window.innerHeight - rect.bottom)) });
    }
    setOpenedOn(pathname);
    setOpen(true);
  }

  function onPanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close("escape");
      return;
    }
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("a[href]") ?? []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    // The panel is drawn at the end of <body>, so Tab and Shift+Tab walk its links in a loop.
    const key = event.key === "Tab" ? (event.shiftKey ? "ArrowUp" : "ArrowDown") : event.key;
    const next = nextLauncherIndex(current, items.length, key);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <>
      <Link
        ref={triggerRef}
        className={className}
        href={href}
        aria-current={isActive ? "page" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        {...tipProps}
        onClick={(event) => {
          if (!isPlainClick(event.nativeEvent)) return;
          event.preventDefault();
          if (open) close("toggle");
          else openFromTrigger();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            close("escape");
          } else if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openFromTrigger();
          }
        }}
      >
        {children}
      </Link>
      {open && createPortal(
        <>
          {variant === "tab" && <div className="more-launcher-scrim" aria-hidden="true" />}
          <div className="more-launcher-region" onKeyDown={onPanelKeyDown}>
            <MoreLauncherPanel
              cards={cards}
              eventQuery={eventQuery}
              id={panelId}
              isSystemAdmin={isSystemAdmin}
              onNavigate={() => close("navigate")}
              panelRef={panelRef}
              style={variant === "sidebar" && anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined}
              variant={variant}
            />
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
