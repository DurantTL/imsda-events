"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CircleUserRound,
  LayoutDashboard,
  FileUp,
  Megaphone,
  MoreHorizontal,
  PanelsTopLeft,
  Settings2,
  type LucideIcon,
  UserCog,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { SignOutButton } from "@/components/sign-out-button";
import type { EventPermission } from "@/modules/access/permissions";
import { operationalHealthEntryPermissions } from "@/modules/operations/access";

type NavigationItem = {
  href: string;
  label: string;
  mobileLabel: string;
  icon: LucideIcon;
  desktopOnly?: boolean;
  requiredPermission?: EventPermission;
  requiredAnyPermissions?: readonly EventPermission[];
};

const navigation: readonly NavigationItem[] = [
  { href: "/overview", label: "Dashboard", mobileLabel: "Home", icon: LayoutDashboard },
  { href: "/people", label: "Registrations", mobileLabel: "People", icon: UsersRound, requiredPermission: "VIEW_SENSITIVE_DATA" },
  { href: "/finance", label: "Payments", mobileLabel: "Payments", icon: WalletCards, requiredPermission: "MANAGE_FINANCE" },
  { href: "/check-in", label: "Check-in", mobileLabel: "Check-in", icon: CheckCircle2, requiredPermission: "MANAGE_CHECK_IN" },
  { href: "/communications", label: "Emails", mobileLabel: "Emails", icon: Megaphone, requiredPermission: "MANAGE_COMMUNICATIONS" },
  { href: "/registration-builder", label: "Registration form", mobileLabel: "Form", icon: PanelsTopLeft, desktopOnly: true, requiredPermission: "MANAGE_FORMS" },
  { href: "/more/event-settings", label: "Event settings", mobileLabel: "Settings", icon: Settings2, desktopOnly: true, requiredPermission: "CONFIGURE_EVENT" },
  { href: "/imports", label: "Imports", mobileLabel: "Imports", icon: FileUp, desktopOnly: true, requiredPermission: "MANAGE_IMPORTS" },
  { href: "/staff", label: "Team", mobileLabel: "Team", icon: UserCog, desktopOnly: true, requiredPermission: "MANAGE_STAFF" },
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

type ShellEvent = { id: string; name: string; permissions: readonly EventPermission[] };
type ShellUser = { displayName: string; email: string };

export function AppShell({
  children,
  events,
  user,
}: {
  children: React.ReactNode;
  events: ShellEvent[];
  user: ShellUser;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [openMenu, setOpenMenu] = useState<"account" | null>(null);
  const current = navigation.find((item) => pathname.startsWith(item.href)) ?? navigation[0];
  const selectedEventId = events.some((event) => event.id === searchParams.get("event"))
    ? searchParams.get("event")!
    : events[0]?.id ?? "";
  const selectedPermissions = new Set(
    events.find((event) => event.id === selectedEventId)?.permissions ?? [],
  );
  const visibleNavigation = navigation.filter((item) => {
    if (item.requiredPermission && !selectedPermissions.has(item.requiredPermission)) return false;
    if (
      item.requiredAnyPermissions
      && !item.requiredAnyPermissions.some((permission) => selectedPermissions.has(permission))
    ) return false;
    return true;
  });
  const eventQuery = selectedEventId ? `?event=${encodeURIComponent(selectedEventId)}` : "";

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
          {visibleNavigation.map(({ href, icon: Icon, label }) => {
            const isActive = current.href === href;
            return (
              <Link className={isActive ? "nav-item active" : "nav-item"} href={`${href}${eventQuery}`} key={href} aria-current={isActive ? "page" : undefined}>
                <Icon aria-hidden="true" size={19} strokeWidth={1.9} />
                <span>{label}</span>
              </Link>
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
          <label className="mobile-event-picker">
            <span className="sr-only">Current event</span>
            <select value={selectedEventId} onChange={(event) => selectEvent(event.target.value)}>
              {events.map((event) => <option value={event.id} key={event.id}>{event.name}</option>)}
            </select>
            <ChevronDown aria-hidden="true" size={15} />
          </label>
          <div className="header-actions">
            <span className="staff-pill">Staff mode</span>
            <div className="menu-anchor">
              <button className="avatar" type="button" aria-label="Staff account" aria-expanded={openMenu === "account"} onClick={() => setOpenMenu(openMenu === "account" ? null : "account")}> 
                <CircleUserRound aria-hidden="true" size={19} />
              </button>
              {openMenu === "account" && (
                <div className="header-popover account-popover" role="status">
                  <strong>{user.displayName}</strong><p>{user.email}</p><small>Database-backed staff session</small><SignOutButton />
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="workspace-content" id="workspace-content">{children}</div>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {visibleNavigation.filter((item) => !item.desktopOnly).map(({ href, icon: Icon, mobileLabel }) => {
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
