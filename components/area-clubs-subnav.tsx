import { AccountSectionNav, type AccountNavItem } from "@/components/account-section-nav";

export const areaClubsNavItems: AccountNavItem[] = [
  { href: "/account/clubs", label: "All clubs" },
  { href: "/account/area-clubs/overview", label: "Overview" },
  { href: "/account/area-clubs/reports", label: "Monthly reports" },
  { href: "/account/area-clubs/points", label: "Points" },
  { href: "/account/area-clubs/events", label: "Club events" },
  { href: "/account/area-clubs/team-permissions", label: "Team permissions" },
  { href: "/account/area-clubs/applications", label: "New clubs" },
];

/**
 * The Area Coordinator's Clubs menu (#657), shared by "All clubs" and the
 * area-clubs pages. The secondary tab row has no margin or width of its own,
 * so it sits in the same 1180px column as the hero and the page body (#722):
 * on its own it hugged the window's left edge.
 */
export function AreaClubsSubNav() {
  return (
    <div className="account-page-body account-page-subnav">
      <AccountSectionNav items={areaClubsNavItems} label="Clubs" variant="secondary" />
    </div>
  );
}
