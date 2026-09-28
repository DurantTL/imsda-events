"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  CircleUserRound,
  Eye,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { EventAutoSelectNotice } from "@/components/event-auto-select-notice";
import { rememberLastUsedEvent } from "@/components/remember-last-event";
import { SignOutButton } from "@/components/sign-out-button";
import type { EventPermission } from "@/modules/access/permissions";
import { otherWorkspaceContextsForStaff } from "@/modules/access/workspace-contexts";
import {
  matchesVisibility,
  mobileNavigationOrder,
  navigation,
  navigationGroupLabels,
  resolveClubsAndChurchesEntry,
  systemNavigation,
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
  const searchParams = useSearchParams();
  const [openMenu, setOpenMenu] = useState<"account" | null>(null);
  const isSystemRoute = pathname.startsWith(systemNavigation.href);
  const current = isSystemRoute
    ? systemNavigation
    : navigation.find((item) => pathname.startsWith(item.href)) ?? navigation[0];
  const requestedEventId = searchParams.get("event");
  const requestedEvent = requestedEventId
    ? events.find((event) => event.id === requestedEventId)
    : undefined;
  const defaultEvent = defaultEventId
    ? events.find((event) => event.id === defaultEventId)
    : undefined;
  // A `?event=` that matches nothing selects nothing, rather than quietly
  // showing the default on pages that don't validate the id themselves.
  const selectedEvent = requestedEventId ? requestedEvent : defaultEvent;
  const selectedEventId = selectedEvent?.id ?? "";
  // Same rule as the page (#465): no `?event=` and an automatic choice. Not on
  // pages that aren't event-scoped (/admin, the global duplicate review).
  const showAutoSelectNotice = !requestedEventId && autoSelected && Boolean(defaultEvent)
    && !pathname.startsWith(systemNavigation.href) && !pathname.startsWith("/people/matches");
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
    mobileLabel: "Clubs",
    icon: UsersRound,
    desktopOnly: true,
    group: "clubs",
  } : null;
  const systemEntry: NavigationItem | null = isSystemAdmin ? {
    href: systemNavigation.href,
    label: "System management",
    mobileLabel: "System",
    icon: ShieldCheck,
    desktopOnly: true,
    group: "system",
  } : null;
  const visibleNavigation: NavigationItem[] = [
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

  function selectEvent(eventId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("event", eventId);
    for (const resourceParam of ["q", "status", "template", "version", "message", "new"]) {
      params.delete(resourceParam);
    }
    // Remembered for the next sign-in (#108 queue 1); never blocks the switch.
    rememberLastUsedEvent(eventId);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace-content">Skip to main content</a>
      <aside className="sidebar" aria-label="Application navigation">
        <Link className="brand" href="/" aria-label="IMSDA Events home">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </Link>

        {user.globalRole === "SYSTEM_ADMIN" && (
          <div className="system-navigation">
            <span className="system-navigation-label">Global administration</span>
            <Link
              className={isSystemRoute ? "system-navigation-link active" : "system-navigation-link"}
              href={systemNavigation.href}
              aria-current={isSystemRoute ? "page" : undefined}
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

        <span className="event-workspace-label">Event workspace</span>
        <div className="event-picker-wrap">
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
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          {visibleNavigation.map(({ href, icon: Icon, label, group }, index) => {
            // /admin routes aren't event-scoped, so they never carry the event query.
            const isActive = href.startsWith("/admin") ? pathname.startsWith(href) : current.href === href;
            const previousGroup = index > 0 ? visibleNavigation[index - 1].group : undefined;
            const startsGroup = group && group !== previousGroup;
            return (
              <Fragment key={href}>
                {startsGroup && <span className="nav-group-label">{navigationGroupLabels[group]}</span>}
                <Link className={isActive ? "nav-item active" : "nav-item"} href={href.startsWith("/admin") ? href : `${href}${eventQuery}`} aria-current={isActive ? "page" : undefined}>
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

      <main className="workspace">
        <header className="workspace-header">
          <div><p className="eyebrow">Staff workspace</p><h1>{current.label}</h1></div>
          {!isSystemRoute && (
            <label className="mobile-event-picker">
              <span className="sr-only">Current event</span>
              <select value={selectedEventId} onChange={(event) => selectEvent(event.target.value)}>
                {!selectedEventId && <option value="" disabled>Choose an event</option>}
                {events.map((event) => <option value={event.id} key={event.id}>{event.name}</option>)}
              </select>
              <ChevronDown aria-hidden="true" size={15} />
            </label>
          )}
          <div className="header-actions">
            {canSwitchToAttendee
              ? (
                <form action="/api/auth/switch-to-attendee" method="post">
                  <button
                    className="attendee-preview-switch"
                    title="Switch to your matching attendee account"
                    type="submit"
                  >
                    <ArrowRightLeft aria-hidden="true" size={16} />
                    <span>My attendee account</span>
                  </button>
                </form>
              )
              : (
                <Link
                  className="attendee-preview-switch"
                  href={attendeePreviewHref}
                  title={`Preview ${selectedEvent?.name ?? "this event"} as an attendee`}
                >
                  <Eye aria-hidden="true" size={16} />
                  <span>Attendee experience</span>
                </Link>
              )}
            <span className="staff-pill">Staff mode</span>
            <div className="menu-anchor">
              <button className="avatar" type="button" aria-label="Staff account" aria-expanded={openMenu === "account"} onClick={() => setOpenMenu(openMenu === "account" ? null : "account")}> 
                <CircleUserRound aria-hidden="true" size={19} />
              </button>
              {openMenu === "account" && (
                <div className="header-popover account-popover" role="status">
                  <strong>{user.displayName}</strong><p>{user.email}</p><small>Database-backed staff session</small>
                  {systemAdminContext && (
                    <Link className="account-system-link" href={systemAdminContext.href} onClick={() => setOpenMenu(null)}>
                      <ShieldCheck aria-hidden="true" size={17} />
                      {systemAdminContext.label}
                    </Link>
                  )}
                  {canSwitchToAttendee && (
                    <form
                      action="/api/auth/switch-to-attendee"
                      className="account-switch-form"
                      method="post"
                    >
                      <button
                        className="account-system-link account-switch-button"
                        type="submit"
                      >
                        <ArrowRightLeft aria-hidden="true" size={17} />
                        Switch to my attendee account
                      </button>
                    </form>
                  )}
                  <Link
                    className="account-system-link"
                    href={attendeePreviewHref}
                    onClick={() => setOpenMenu(null)}
                  >
                    <Eye aria-hidden="true" size={17} />
                    Preview attendee experience
                  </Link>
                  <SignOutButton />
                </div>
              )}
            </div>
          </div>
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

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {mobileNavigation.map(({ href, icon: Icon, mobileLabel }) => {
          const isActive = current.href === href;
          return (
            <Link className={isActive ? "active" : undefined} href={`${href}${eventQuery}`} key={href} aria-current={isActive ? "page" : undefined}>
              <Icon aria-hidden="true" size={20} /><span>{mobileLabel}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
