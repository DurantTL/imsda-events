import type { AccountNavItem } from "@/components/account-section-nav";
import { isClubFormsRole } from "@/modules/club-forms/domain";
import type { ClubCapabilities } from "@/modules/organizations/director-grants-domain";

/**
 * The club portal's menu (#644), grouped People / Events / Records / Orders /
 * Club. Every destination keeps the capability check it always had; groups
 * with no visible item simply never appear because the heading is drawn from
 * the items themselves.
 */
export function clubPortalNavItems({
  base,
  role,
  capabilities,
}: {
  base: string;
  role: string;
  capabilities: ClubCapabilities;
}): AccountNavItem[] {
  // Honors, Orders (with supplies on hand) and Class tracking all open on the roster's own gate (#486, #531, #487, #497, #532).
  const roster = capabilities.roster;
  return [
    { href: base, label: "Home" },
    { href: `${base}/roster`, label: "Roster", group: "People", hideGroupLabel: true },
    // The honors and class exports live on these two pages (#701); the old reports page redirects to Honors.
    ...(roster ? [{ href: `${base}/honors`, label: "Honors", group: "People", hideGroupLabel: true }] : []),
    ...(roster ? [{ href: `${base}/class-tracking`, label: "Class tracking", group: "People", hideGroupLabel: true }] : []),
    { href: `${base}/events`, label: "Events", matchChildren: true, group: "Events", hideGroupLabel: true },
    // Club forms (#610) hold health and conduct answers: the club's director and deputy only.
    ...(isClubFormsRole(role) ? [{ href: `${base}/forms`, label: "Forms", matchChildren: true, group: "Events", hideGroupLabel: true }] : []),
    // Event health information (#658): the club's director and deputy, for their own club.
    ...(isClubFormsRole(role) ? [{ href: `${base}/health`, label: "Health", matchChildren: true, group: "Events", hideGroupLabel: true }] : []),
    ...(capabilities.submitReports ? [{ href: `${base}/records`, label: "Monthly Records", matchChildren: true, group: "Records", hideGroupLabel: true }] : []),
    // Supplies on hand live inside Orders (#654), so there is no separate Supplies entry.
    ...(roster ? [{ href: `${base}/orders`, label: "Orders", group: "Orders", hideGroupLabel: true }] : []),
    ...(capabilities.manageTeam || capabilities.editProfile
      ? [{ href: `${base}/club-info`, label: "Club info", group: "Club", hideGroupLabel: true }]
      : []),
  ];
}

/** A reporter with no roster access (#375, #377): Home and the two report screens only. */
export function clubReporterNavItems({ base, capabilities }: { base: string; capabilities: ClubCapabilities }): AccountNavItem[] {
  return [
    { href: base, label: "Home" },
    ...(capabilities.submitReports ? [{ href: `${base}/records`, label: "Monthly Records", matchChildren: true, group: "Records", hideGroupLabel: true }] : []),
  ];
}

/**
 * The Area Coordinator's view of one club (#722): the club portal's menu in
 * its view-only form. It lists only destinations a coordinator can already
 * open (each page still checks access on the server); the director's
 * editing-only screens (Class tracking, Club info, Health, Monthly Records
 * entry) are never listed. Every item stays inside this club: Roster, Events
 * and Monthly reports are sections of the club's Home page (ages only), and
 * the background-check counts are on its roster tile.
 *
 * Anchor items (`#open-club-...`) can't show an active state: the nav reads
 * `usePathname`, which has no hash. Monthly reports is active on the report
 * month pages through `alsoMatchPrefix`.
 */
export function areaClubPortalNavItems({ organizationId }: { organizationId: string }): AccountNavItem[] {
  const base = `/account/area/${encodeURIComponent(organizationId)}`;
  return [
    { href: base, label: "Home" },
    { href: `${base}#open-club-roster`, label: "Roster", group: "People", hideGroupLabel: true },
    { href: `${base}/honors`, label: "Honors", group: "People", hideGroupLabel: true },
    { href: `${base}#open-club-events`, label: "Events", group: "Events", hideGroupLabel: true },
    { href: `${base}/forms`, label: "Club forms", matchChildren: true, group: "Events", hideGroupLabel: true },
    { href: `${base}#open-club-reports`, label: "Monthly reports", alsoMatchPrefix: `${base}/reports`, group: "Records", hideGroupLabel: true },
    { href: `${base}/orders`, label: "Orders", group: "Orders", hideGroupLabel: true },
    { href: `${base}/awards`, label: "Earned awards", group: "Orders", hideGroupLabel: true },
  ];
}
