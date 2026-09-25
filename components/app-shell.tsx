"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import {
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  CircleUserRound,
  LayoutDashboard,
  FileUp,
  Eye,
  Megaphone,
  MoreHorizontal,
  PanelsTopLeft,
  Settings2,
  ShieldCheck,
  TicketPercent,
  Tags,
  Tag,
  type LucideIcon,
  UserCog,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { SignOutButton } from "@/components/sign-out-button";
import type { EventPermission } from "@/modules/access/permissions";
import { operationalHealthEntryPermissions } from "@/modules/operations/access";

/**
 * Groups for the sidebar (#428): items with no group render above any
 * heading (Dashboard) or after every group (More, a catch-all that spans
 * several of them). "Clubs and churches" and "System" are computed per
 * render, not statically, since their destination and visibility depend on
 * the signed-in user's role and (for Clubs and churches) the selected
 * event's club oversight — see docs/NAVIGATION.md.
 */
type NavigationGroup = "events" | "clubs" | "people" | "finance" | "communications" | "system";

const navigationGroupLabels: Record<NavigationGroup, string> = {
  events: "Events",
  clubs: "Clubs and churches",
  people: "People",
  finance: "Finance",
  communications: "Communications",
  system: "System",
};

type NavigationItem = {
  href: string;
  label: string;
  mobileLabel: string;
  icon: LucideIcon;
  desktopOnly?: boolean;
  requiredPermission?: EventPermission;
  requiredAnyPermissions?: readonly EventPermission[];
  group?: NavigationGroup;
};

const systemNavigation: NavigationItem = {
  href: "/admin",
  label: "System management",
  mobileLabel: "System",
  icon: ShieldCheck,
};

const navigation: readonly NavigationItem[] = [
  { href: "/overview", label: "Dashboard", mobileLabel: "Home", icon: LayoutDashboard },
  { href: "/check-in", label: "Check-in", mobileLabel: "Check-in", icon: CheckCircle2, requiredPermission: "MANAGE_CHECK_IN", group: "events" },
  { href: "/registration-builder", label: "Registration form", mobileLabel: "Form", icon: PanelsTopLeft, desktopOnly: true, requiredPermission: "MANAGE_FORMS", group: "events" },
  { href: "/more/attendee-configuration", label: "Attendee setup", mobileLabel: "Types", icon: Tags, desktopOnly: true, requiredPermission: "CONFIGURE_EVENT", group: "events" },
  { href: "/more/tags", label: "Tags", mobileLabel: "Tags", icon: Tag, desktopOnly: true, requiredPermission: "CONFIGURE_EVENT", group: "events" },
  { href: "/more/event-settings", label: "Event settings", mobileLabel: "Settings", icon: Settings2, desktopOnly: true, requiredPermission: "CONFIGURE_EVENT", group: "events" },
  { href: "/people", label: "Registrations", mobileLabel: "People", icon: UsersRound, requiredPermission: "VIEW_SENSITIVE_DATA", group: "people" },
  { href: "/imports", label: "Imports", mobileLabel: "Imports", icon: FileUp, desktopOnly: true, requiredPermission: "MANAGE_IMPORTS", group: "people" },
  { href: "/staff", label: "Team", mobileLabel: "Team", icon: UserCog, desktopOnly: true, requiredPermission: "MANAGE_STAFF", group: "people" },
  { href: "/finance", label: "Payments", mobileLabel: "Payments", icon: WalletCards, requiredPermission: "MANAGE_FINANCE", group: "finance" },
  { href: "/more/promo-codes", label: "Promo codes", mobileLabel: "Promos", icon: TicketPercent, requiredPermission: "MANAGE_FINANCE", group: "finance" },
  { href: "/communications", label: "Emails", mobileLabel: "Emails", icon: Megaphone, requiredPermission: "MANAGE_COMMUNICATIONS", group: "communications" },
  {
    href: "/more",
    label: "More",
    mobileLabel: "More",
    icon: MoreHorizontal,
    requiredAnyPermissions: [
      "VIEW_REPORTS",
      "MANAGE_STAFF",
      "MANAGE_FINANCE",
      ...operationalHealthEntryPermissions,
    ],
  },
];

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
  children,
  events,
  user,
}: {
  attendeeAccountAvailable?: boolean;
  children: React.ReactNode;
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
  const selectedEventId = events.some((event) => event.id === searchParams.get("event"))
    ? searchParams.get("event")!
    : events[0]?.id ?? "";
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0];
  const selectedPermissions = new Set(
    events.find((event) => event.id === selectedEventId)?.permissions ?? [],
  );
  const isSystemAdmin = user.globalRole === "SYSTEM_ADMIN";
  const matchesVisibility = (item: NavigationItem) => {
    if (item.requiredPermission && !selectedPermissions.has(item.requiredPermission)) return false;
    if (
      item.requiredAnyPermissions
      && !item.requiredAnyPermissions.some((permission) => selectedPermissions.has(permission))
    ) return false;
    return true;
  };
  const eventQuery = selectedEventId ? `?event=${encodeURIComponent(selectedEventId)}` : "";
  const visibleStatic = navigation.filter(matchesVisibility);
  const dashboardItem = visibleStatic.find((item) => !item.group && item.href !== "/more");
  const moreItem = visibleStatic.find((item) => item.href === "/more");
  // Nobody sees a link here they couldn't already reach before this group
  // existed (#428 review): system admins reach every club through the
  // churches-and-clubs directory; an EVENT_ADMIN on a club-billed event
  // reaches theirs through club oversight, exactly as `more/page.tsx` gates it.
  const clubsVisible = isSystemAdmin || Boolean(selectedEvent?.clubOversight);
  const clubsEntry: NavigationItem | null = clubsVisible ? {
    href: isSystemAdmin ? "/admin/organizations" : "/more/clubs",
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
  // than deriving from the sidebar's grouping: Home, People, Payments,
  // Promos, Check-in, Emails, More.
  const mobileNavigationOrder = ["/overview", "/people", "/finance", "/more/promo-codes", "/check-in", "/communications", "/more"];
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
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace-content">Skip to main content</a>
      <aside className="sidebar" aria-label="Application navigation">
        <Link className="brand" href={`/overview${eventQuery}`} aria-label="IMSDA Events home">
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
                {events.map((event) => <option value={event.id} key={event.id}>{event.name}</option>)}
              </select>
              <ChevronDown aria-hidden="true" size={15} />
            </label>
          )}
          <div className="header-actions">
            {attendeeAccountAvailable
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
                  {user.globalRole === "SYSTEM_ADMIN" && (
                    <Link className="account-system-link" href="/admin" onClick={() => setOpenMenu(null)}>
                      <ShieldCheck aria-hidden="true" size={17} />
                      System management
                    </Link>
                  )}
                  {attendeeAccountAvailable && (
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
        <div className="workspace-content" id="workspace-content">{children}</div>
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
