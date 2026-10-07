"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import {
  desktopBreakpointQuery,
  isPlainClick,
  launcherFooterLinks,
  launcherGroups,
  nextLauncherIndex,
  forgetLauncherPosition,
  recallLauncherPosition,
  rememberLauncherPosition,
  returnsFocusToTrigger,
  type LauncherCloseReason,
} from "@/components/more-launcher-model";
import type { MoreDirectoryCard } from "@/components/staff-navigation";
import { eventModuleDefinition, moduleForCard } from "@/modules/event-modules/catalog";

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
  canRequestFeature = false,
  eventQuery,
  eventId,
  removableModules,
  id,
  panelRef,
  onNavigate,
  variant,
  style,
}: {
  cards: readonly MoreDirectoryCard[];
  isSystemAdmin: boolean;
  /** An Event Admin who is not a system administrator: shows "Request a feature" (#741). */
  canRequestFeature?: boolean;
  eventQuery: string;
  /** The selected event; with a system administrator it adds a "Turn off" control to each module card (#810). */
  eventId?: string;
  /**
   * Module keys the server will let a system administrator turn off for this event
   * (stored row, not always on, not kept on by its data), the same set the Event
   * modules page uses. Without it no card gets a Turn off control.
   */
  removableModules?: readonly string[];
  id?: string;
  panelRef?: Ref<HTMLDivElement>;
  onNavigate?: (card?: { key: string; href: string }) => void;
  variant: "sidebar" | "tab";
  style?: HTMLAttributes<HTMLDivElement>["style"];
}) {
  const groups = launcherGroups(cards);
  const footer = launcherFooterLinks({ isSystemAdmin, canRequestFeature, eventQuery });
  const router = useRouter();
  const [confirming, setConfirming] = useState<{ moduleKey: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const turnOffRef = useRef<HTMLButtonElement>(null);
  // Only a system administrator sees a toggle; the route and service check the role again (#741, #810).
  const canToggle = isSystemAdmin && Boolean(eventId) && Boolean(removableModules?.length);
  const removable = new Set(removableModules ?? []);
  const confirmRef = useRef<HTMLDivElement>(null);
  // The Turn off button that opened the confirm, and where focus goes once the confirm is gone.
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<{ kind: "opener" } | { kind: "card"; key: string | null } | null>(null);

  // Runs after the render that clears `confirming`, so the rest of the panel is no longer inert when focus moves back.
  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus();
      return;
    }
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (!target) return;
    const panel = openerRef.current?.closest<HTMLElement>(".more-launcher") ?? null;
    if (target.kind === "opener" && openerRef.current?.isConnected) {
      openerRef.current.focus();
    } else {
      const card = target.kind === "card" && target.key ? panel?.querySelector<HTMLElement>(`a[data-card="${target.key}"]`) : null;
      (card ?? panel)?.focus();
    }
  }, [confirming]);

  function cancelConfirm() {
    pendingFocus.current = { kind: "opener" };
    setConfirming(null);
  }

  async function turnOff() {
    if (!confirming || !eventId) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/modules/${encodeURIComponent(confirming.moduleKey)}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message ?? "The module could not be turned off.");
      }
      // The turned-off card goes away on refresh, so focus its neighbour (or the panel).
      const row = openerRef.current?.closest("li");
      const neighbour = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector<HTMLElement>("a[data-card]") ?? null;
      pendingFocus.current = { kind: "card", key: neighbour?.dataset.card ?? null };
      setConfirming(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The module could not be turned off.");
    } finally {
      setBusy(false);
    }
  }

  function onConfirmKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // The confirm owns the keyboard while it is open: Escape cancels it only, and Tab stays between its two buttons.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      cancelConfirm();
    } else if (event.key === "Tab") {
      event.preventDefault();
      (document.activeElement === cancelRef.current ? turnOffRef.current : cancelRef.current)?.focus();
    }
  }

  return (
    <div
      className={`more-launcher more-launcher-${variant}`}
      id={id}
      ref={panelRef}
      role="dialog"
      aria-modal={variant === "tab" ? "true" : undefined}
      aria-label="More tools"
      style={style}
      tabIndex={-1}
    >
      {/* While the confirm is open the rest of the panel is inert, to match aria-modal. */}
      <div className="more-launcher-columns" inert={confirming ? true : undefined}>
        {groups.map(({ group, label, cards: groupCards }) => (
          <section className="more-launcher-group" aria-label={label} key={group} data-group={group}>
            <h2 className="more-launcher-group-label">{label}</h2>
            <ul>
              {groupCards.map((card) => {
                const definition = canToggle ? moduleForCard(card.key) : undefined;
                const switchable = definition && !definition.alwaysOn && removable.has(definition.key) ? definition : undefined;
                return (
                  <li key={card.key} className={switchable ? "more-launcher-row" : undefined}>
                    <Link className="more-launcher-item" href={card.href} onClick={() => onNavigate?.({ key: card.key, href: card.href })} data-card={card.key}>
                      <card.icon aria-hidden="true" size={18} strokeWidth={1.9} />
                      <span>{card.title}</span>
                    </Link>
                    {switchable && (
                      <button
                        className="more-launcher-toggle"
                        type="button"
                        data-module-toggle={switchable.key}
                        aria-label={`Turn off ${switchable.title}`}
                        onClick={(event) => { openerRef.current = event.currentTarget; setError(""); setConfirming({ moduleKey: switchable.key, title: switchable.title }); }}
                      >
                        Turn off
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {confirming && (
        <div
          className="more-launcher-confirm"
          ref={confirmRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="more-launcher-confirm-title"
          aria-describedby="more-launcher-confirm-body"
          onKeyDown={onConfirmKeyDown}
        >
          <h3 id="more-launcher-confirm-title">Turn off {eventModuleDefinition(confirming.moduleKey as Parameters<typeof eventModuleDefinition>[0]).title}?</h3>
          <p id="more-launcher-confirm-body">Its pages and links are hidden for this event. The data is kept, and you can turn it back on from Event modules.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="more-launcher-confirm-actions">
            <button className="secondary-button" type="button" ref={cancelRef} onClick={cancelConfirm} disabled={busy}>Cancel</button>
            <button className="primary-button" type="button" ref={turnOffRef} onClick={turnOff} disabled={busy}>{busy ? "Turning off…" : "Turn off"}</button>
          </div>
        </div>
      )}
      {footer.length > 0 && (
        <div className="more-launcher-footer" inert={confirming ? true : undefined}>
          {footer.map((link) => (
            <Link className="more-launcher-item more-launcher-footer-link" href={link.href} key={link.key} onClick={() => onNavigate?.()} data-footer={link.key}>
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
  canRequestFeature = false,
  eventQuery,
  eventId,
  removableModules,
  userId = "",
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
  canRequestFeature?: boolean;
  eventQuery: string;
  eventId?: string;
  removableModules?: readonly string[];
  /** The signed-in user, so a remembered position never carries to another person on a shared tab. */
  userId?: string;
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
    // Escape means "start over": the next open begins at the first card.
    if (reason === "escape") forgetLauncherPosition();
    if (returnsFocusToTrigger(reason)) triggerRef.current?.focus();
  }, []);

  // Open: move focus to the first item. Outside press: close without taking focus.
  useEffect(() => {
    if (!open) return;
    if (variant === "tab") setBackgroundInert(true);
    // Coming back: focus the card last opened and restore the scroll (#741 slice 4); otherwise the first item.
    const panel = panelRef.current;
    // The memory applies only back on the page it opened (or a child); otherwise first card, top.
    const remembered = recallLauncherPosition({ userId, eventQuery, pathname });
    const rememberedCard = remembered?.cardKey ? panel?.querySelector<HTMLElement>(`a[data-card="${remembered.cardKey}"]`) : null;
    (rememberedCard ?? panel?.querySelector<HTMLElement>("a[href]"))?.focus({ preventScroll: Boolean(rememberedCard) });
    if (panel) panel.scrollTop = rememberedCard && remembered ? remembered.scrollTop : 0;
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
    // A rotation or resize past the phone breakpoint hides the sheet and its tab bar, so close it and lift `inert`.
    const desktop = variant === "tab" && typeof window.matchMedia === "function" ? window.matchMedia(desktopBreakpointQuery) : null;
    function onDesktop(event: MediaQueryListEvent) {
      if (event.matches) close("outside");
    }
    desktop?.addEventListener("change", onDesktop);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("popstate", onPopState);
      desktop?.removeEventListener("change", onDesktop);
      setBackgroundInert(false);
    };
  }, [open, close, variant, eventQuery, userId, pathname]);

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
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("a[href], button.more-launcher-toggle:not([disabled])") ?? []);
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
              eventId={eventId}
              removableModules={removableModules}
              id={panelId}
              isSystemAdmin={isSystemAdmin}
              canRequestFeature={canRequestFeature}
              onNavigate={(card) => {
                if (card) rememberLauncherPosition({ userId, eventQuery, cardKey: card.key, href: card.href, scrollTop: panelRef.current?.scrollTop ?? 0 });
                close("navigate");
              }}
              panelRef={panelRef}
              style={variant === "sidebar" && anchor ? { left: anchor.left, bottom: anchor.bottom, maxHeight: `calc(100vh - ${anchor.bottom + 12}px)` } : undefined}
              variant={variant}
            />
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
