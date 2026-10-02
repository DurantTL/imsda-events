"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  Eye,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { EventAutoSelectNotice } from "@/components/event-auto-select-notice";
import { rememberLastUsedEvent } from "@/components/remember-last-event";
import { guardedNavigate } from "@/components/unsaved-changes-registry";
import { eventToRemember, resolveShellEvent, switchEvent } from "@/components/shell-event-selection";
import {
  applySidebarAttribute,
  getSidebarCollapsedServerSnapshot,
  getSidebarCollapsedSnapshot,
  setSidebarCollapsed,
  subscribeSidebarCollapsed,
} from "@/components/sidebar-collapse";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { StaffAccountMenu } from "@/components/staff-account-menu";
import type { EventPermission } from "@/modules/access/permissions";
import { otherWorkspaceContextsForStaff } from "@/modules/access/workspace-contexts";
import {
  matchesVisibility,
  mobileNavigationLabels,
  mobileNavigationOrder,
  navigation,
  navigationGroupLabels,
  resolveClubsAndChurchesEntry,
  staffSubpageTitle,
  systemNavigation,
  withCurrentEvent,
  type NavigationItem,
} from "@/components/staff-navigation";

type ShellEvent = {
  id: string;
  slug: string;
  name: string;
  permissions: readonly EventPermission[];
  /** Whether this event's club oversight (#387) is open to the signed-in user, computed server-side. */
  clubOversight?: boolean;
};
type ShellUser = { displayName: string; email: string; globalRole?: "SYSTEM_ADMIN" | null };

export function AppShell({
  attendeeAccountAvailable = false,
  autoSelected = false,
  children,
  defaultEventId = null,
  events,
  user,
}: {
  attendeeAccountAvailable?: boolean;
  /** The default event was chosen automatically (#465): show the notice on pages without `?event=`. */
  autoSelected?: boolean;
  children: React.ReactNode;
  /**
   * The event a page with no `?event=` shows, from the same
   * `selectEventContext` decision the page makes (#465); `null` when nothing
   * can be chosen automatically. Never `events[0]` by position.
   */
  defaultEventId?: string | null;
  events: ShellEvent[];
  user: ShellUser;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // Icons-only sidebar (#446). Starts expanded so the server and first client
  // render match; the saved choice is applied after mount.
  const collapsed = useSyncExternalStore(subscribeSidebarCollapsed, getSidebarCollapsedSnapshot, getSidebarCollapsedServerSnapshot);
  const [tooltip, setTooltip] = useState<{ label: string; top: number; left: number } | null>(null);
  // Keep <html> in step with the choice, for the stylesheet (and when the inline script did not run).
  useEffect(() => { applySidebarAttribute(collapsed); }, [collapsed]);
  function toggleCollapsed() {
    setTooltip(null);
    setSidebarCollapsed(!collapsed);
  }
  // A tooltip for the icon-only sidebar, on hover and keyboard focus. It is
  // drawn outside the sidebar, whose overflow would clip it.
  function showTip(element: HTMLElement, label: string) {
    const rect = element.getBoundingClientRect();
    setTooltip({ label, top: rect.top + rect.height / 2, left: rect.right + 10 });
  }
  const tipProps = (label: string) => collapsed ? {
    onMouseEnter: (event: { currentTarget: HTMLElement }) => showTip(event.currentTarget, label),
    onFocus: (event: { currentTarget: HTMLElement }) => showTip(event.currentTarget, label),
    onMouseLeave: () => setTooltip(null),
    onBlur: () => setTooltip(null),
  } : {};
  const searchParams = useSearchParams();
  // The staff-only profile page (#623) lives inside the shell but is no nav item.
  const isProfileRoute = pathname === "/profile" || pathname.startsWith("/profile/");
  const isSystemRoute = pathname.startsWith(systemNavigation.href);
  const current = isSystemRoute
    ? systemNavigation
    : navigation.find((item) => pathname.startsWith(item.href)) ?? navigation[0];
  // The header names the page the staff member is on (#685): a `/more/*`
  // page that isn't a nav item names itself instead of reading "More".
  const pageTitle = isProfileRoute ? "Your account" : staffSubpageTitle(pathname) ?? current.label;
  const requestedEventId = searchParams.get("event");
  const defaultEvent = defaultEventId
    ? events.find((event) => event.id === defaultEventId)
    : undefined;
  // The layout (and so `defaultEventId`) doesn't re-render on client
  // navigation, so keep the last valid event seen and fall back to the
  // default only when none has been seen (#616).
  const [seenEventId, setSeenEventId] = useState<string | null>(null);
  // Adjusting state during render (not in an effect) so the very render that
  // sees a new `?event=` also records it.
  if (requestedEventId && requestedEventId !== seenEventId && events.some((event) => event.id === requestedEventId)) {
    setSeenEventId(requestedEventId);
  }
  const selectedEvent = resolveShellEvent({ requestedEventId, events, seenEventId, defaultEventId });
  const selectedEventId = selectedEvent?.id ?? "";
  // Same rule as the page (#465): no `?event=` and an automatic choice. Not on
  // pages that aren't event-scoped (/admin, the global duplicate review).
  const showAutoSelectNotice = !requestedEventId && !seenEventId && autoSelected && Boolean(defaultEvent)
    && !pathname.startsWith(systemNavigation.href) && !pathname.startsWith("/people/matches")
    && !isProfileRoute;
  const selectedPermissions = new Set(
    events.find((event) => event.id === selectedEventId)?.permissions ?? [],
  );
  const isSystemAdmin = user.globalRole === "SYSTEM_ADMIN";
  // The other workspaces this staff identity may switch into (#108): the
  // account popover's System management link and both attendee switch
  // buttons read this, so they always agree with each other.
  const workspaceContexts = otherWorkspaceContextsForStaff({ isSystemAdmin, attendeeAccountAvailable });
  const systemAdminContext = workspaceContexts.find((context) => context.kind === "system_admin");
  const canSwitchToAttendee = workspaceContexts.some((context) => context.kind === "attendee");
  // Staff with no events can still open their profile (#623); every event
  // control and event-scoped nav item would dead-end for them, so hide them.
  const eventlessProfile = isProfileRoute && events.length === 0 && !isSystemAdmin;
  const eventQuery = selectedEventId ? `?event=${encodeURIComponent(selectedEventId)}` : "";
  const visibleStatic = navigation.filter((item) => matchesVisibility(item, selectedPermissions));
  const dashboardItem = visibleStatic.find((item) => !item.group && item.href !== "/more");
  const moreItem = visibleStatic.find((item) => item.href === "/more");
  // Audience, not billing mode, decides club features (#481): `clubOversight`
  // (computed server-side in the layout) is true only for a CLUB-audience
  // selected event, for a system admin or an EVENT_ADMIN, exactly as
  // `more/page.tsx` gates it. A GENERAL event never shows this, even for a
  // system admin (who still reaches the directory from System management).
  const clubsAndChurches = resolveClubsAndChurchesEntry({
    clubOversight: Boolean(selectedEvent?.clubOversight),
    isSystemAdmin,
  });
  const clubsEntry: NavigationItem | null = clubsAndChurches.visible ? {
    href: clubsAndChurches.href,
    label: "Clubs and churches",
    icon: UsersRound,
    desktopOnly: true,
    group: "clubs",
  } : null;
  const systemEntry: NavigationItem | null = isSystemAdmin ? {
    href: systemNavigation.href,
    label: "System management",
    icon: ShieldCheck,
    desktopOnly: true,
    group: "system",
  } : null;
  const visibleNavigation: NavigationItem[] = eventlessProfile ? [] : [
    ...(dashboardItem ? [dashboardItem] : []),
    ...visibleStatic.filter((item) => item.group === "events"),
    ...(clubsEntry ? [clubsEntry] : []),
    ...visibleStatic.filter((item) => item.group === "people"),
    ...visibleStatic.filter((item) => item.group === "finance"),
    ...visibleStatic.filter((item) => item.group === "communications"),
    ...(systemEntry ? [systemEntry] : []),
    ...(moreItem ? [moreItem] : []),
  ];
  // The mobile tab bar keeps its own, unrelated order (#428 review) rather
  // than deriving from the sidebar's grouping — see `mobileNavigationOrder`.
  const mobileNavigation = mobileNavigationOrder
    .map((href) => visibleNavigation.find((item) => item.href === href))
    .filter((item): item is NavigationItem => Boolean(item));
  const attendeePreviewHref = selectedEvent
    ? `/account/events/${encodeURIComponent(selectedEvent.slug)}?preview=staff`
    : "/account";

  // An event named in the URL becomes the remembered selection (#616), so the
  // next page without `?event=` keeps it instead of falling back to the default.
  const lastRememberedId = useRef<string | null>(defaultEventId);
  const knownEventIds = events.map((event) => event.id).join("|");
  useEffect(() => {
    const toRemember = eventToRemember({
      requestedEventId,
      knownEventIds: knownEventIds ? knownEventIds.split("|") : [],
      lastRememberedId: lastRememberedId.current,
    });
    if (toRemember) {
      lastRememberedId.current = toRemember;
      // Refresh once the cookie is set so the server default catches up.
      void rememberLastUsedEvent(toRemember).then(() => router.refresh());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedEventId, knownEventIds]);

  function selectEvent(eventId: string) {
    // Guarded (#647): a dirty form prompts first; Cancel changes nothing.
    switchEvent({
      eventId,
      pathname,
      currentSearch: searchParams.toString(),
      guard: guardedNavigate,
      commit: (id) => {
        // Remembered for the next sign-in (#108 queue 1); never blocks the switch.
        lastRememberedId.current = id;
        setSeenEventId(id);
        void rememberLastUsedEvent(id).then(() => router.refresh());
      },
      push: (href) => router.push(href),
    });
  }

  return (
    <div className="app-shell" 
      onKeyDown={(event) => { if (event.key === "Escape" && tooltip) setTooltip(null); }}>
      <a className="skip-link" href="#workspace-content">Skip to main content</a>
      <aside className="sidebar" aria-label="Application navigation" onScrollCapture={() => setTooltip(null)}>
        <Link className="brand" href="/" aria-label="IMSDA Events home" {...tipProps("IMSDA Events home")}>
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </Link>

        <SidebarToggle collapsed={collapsed} onToggle={toggleCollapsed} tipProps={tipProps("Expand sidebar")} />

        {user.globalRole === "SYSTEM_ADMIN" && (
          <div className="system-navigation">
            <span className="system-navigation-label">Global administration</span>
            <Link
              className={isSystemRoute ? "system-navigation-link active" : "system-navigation-link"}
              href={withCurrentEvent(systemNavigation.href, selectedEventId)}
              aria-current={isSystemRoute ? "page" : undefined}
              {...tipProps("System management")}
            >
              <span className="system-navigation-icon">
                <ShieldCheck aria-hidden="true" size={19} strokeWidth={1.9} />
              </span>
              <span>
                <strong>System management</strong>
                <small>All events and integrations</small>
              </span>
            </Link>
          </div>
        )}

        {!eventlessProfile && <span className="event-workspace-label">Event workspace</span>}
        {!eventlessProfile && <div className="event-picker-wrap">
          <label htmlFor="event-picker">Current event</label>
          <div className="select-shell">
            <select
              id="event-picker"
              value={selectedEventId}
              onChange={(event) => selectEvent(event.target.value)}
              aria-label="Current event"
            >
              {!selectedEventId && <option value="" disabled>Choose an event</option>}
              {events.map((event) => <option value={event.id} key={event.id}>{event.name}</option>)}
            </select>
            <ChevronDown aria-hidden="true" size={16} />
          </div>
        </div>}

        <nav className="primary-nav" id="primary-navigation" aria-label="Primary navigation">
          {visibleNavigation.map(({ href, icon: Icon, label, group }, index) => {
            // Every link carries the current event, /admin included (#616).
            const isActive = isProfileRoute ? false : href.startsWith("/admin") ? pathname.startsWith(href) : current.href === href;
            const previousGroup = index > 0 ? visibleNavigation[index - 1].group : undefined;
            const startsGroup = group && group !== previousGroup;
            return (
              <Fragment key={href}>
                {startsGroup && <span className="nav-group-label">{navigationGroupLabels[group]}</span>}
                <Link className={isActive ? "nav-item active" : "nav-item"} href={withCurrentEvent(href, selectedEventId)} aria-current={isActive ? "page" : undefined} {...tipProps(label)}>
                  <Icon aria-hidden="true" size={19} strokeWidth={1.9} />
                  <span>{label}</span>
                </Link>
              </Fragment>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <span className="sync-dot" aria-hidden="true" />
          <span><strong>Event database</strong><small>Access controlled</small></span>
        </div>
      </aside>
      {collapsed && tooltip && <div className="sidebar-tooltip" aria-hidden="true" style={{ top: tooltip.top, left: tooltip.left }}>{tooltip.label}</div>}

      <main className="workspace">
        <header className="workspace-header">
          <div><p className="eyebrow">Staff workspace</p><h1>{pageTitle}</h1></div>
          <div className="header-actions">
            {canSwitchToAttendee
              ? (
                <form action="/api/auth/switch-to-attendee" method="post">
                  <button
                    aria-label="My attendee account"
                    className="attendee-preview-switch"
                    title="Switch to your matching attendee account"
                    type="submit"
                  >
                    <ArrowRightLeft aria-hidden="true" size={16} />
                    <span>My attendee account</span>
                  </button>
                </form>
              )
              : !eventlessProfile && (
                <Link
                  aria-label="Attendee experience"
                  className="attendee-preview-switch"
                  href={attendeePreviewHref}
                  title={`Preview ${selectedEvent?.name ?? "this event"} as an attendee`}
                >
                  <Eye aria-hidden="true" size={16} />
                  <span>Attendee experience</span>
                </Link>
              )}
            <span className="staff-pill">Staff mode</span>
            <StaffAccountMenu
              attendeePreviewHref={attendeePreviewHref}
              canSwitchToAttendee={canSwitchToAttendee}
              displayName={user.displayName}
              email={user.email}
              systemAdminContext={systemAdminContext ? { ...systemAdminContext, href: withCurrentEvent(systemAdminContext.href, selectedEventId) } : systemAdminContext}
            />
          </div>
          {!isSystemRoute && !eventlessProfile && (
            <label className="mobile-event-picker">
              <span className="sr-only">Current event</span>
              <select value={selectedEventId} onChange={(event) => selectEvent(event.target.value)}>
                {!selectedEventId && <option value="" disabled>Choose an event</option>}
                {events.map((event) => <option value={event.id} key={event.id}>{event.name}</option>)}
              </select>
              <ChevronDown aria-hidden="true" size={15} />
            </label>
          )}
        </header>
        <div className="workspace-content" id="workspace-content">
          {showAutoSelectNotice && defaultEvent && (
            <EventAutoSelectNotice
              eventName={defaultEvent.name}
              switchHref={isSystemAdmin ? "/admin" : "/select-event"}
            />
          )}
          {children}
        </div>
      </main>

      {mobileNavigation.length > 0 && <nav className="mobile-nav" aria-label="Mobile navigation">
        {mobileNavigation.map(({ href, icon: Icon, label }) => {
          const isActive = !isProfileRoute && current.href === href;
          return (
            <Link className={isActive ? "active" : undefined} href={`${href}${eventQuery}`} key={href} aria-current={isActive ? "page" : undefined}>
              <Icon aria-hidden="true" size={22} /><span>{mobileNavigationLabels[href] ?? label}</span>
            </Link>
          );
        })}
      </nav>}
    </div>
  );
}
