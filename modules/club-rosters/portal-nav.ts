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
  // Honors, Supplies, Orders and Class tracking all open on the roster's own gate (#486, #531, #487, #497, #532).
  const roster = capabilities.roster;
  return [
    { href: base, label: "Home" },
    { href: `${base}/roster`, label: "Roster", group: "People" },
    ...(roster ? [{ href: `${base}/honors`, label: "Honors", group: "People" }] : []),
    ...(roster ? [{ href: `${base}/class-tracking`, label: "Class tracking", group: "People" }] : []),
    ...(roster ? [{ href: `${base}/exports`, label: "Honors & class reports", matchChildren: true, group: "People" }] : []),
    { href: `${base}/events`, label: "Events", matchChildren: true, group: "Events" },
    // Club forms (#610) hold health and conduct answers: the club's director and deputy only.
    ...(isClubFormsRole(role) ? [{ href: `${base}/forms`, label: "Forms", matchChildren: true, group: "Events" }] : []),
    ...(capabilities.submitReports ? [
      { href: `${base}/notes`, label: "Meeting notes", matchChildren: true, group: "Records" },
      { href: `${base}/reports`, label: "Monthly reports", matchChildren: true, group: "Records" },
    ] : []),
    ...(roster ? [
      { href: `${base}/supplies`, label: "Supplies", group: "Orders" },
      { href: `${base}/orders`, label: "Orders", group: "Orders" },
    ] : []),
    ...(capabilities.manageTeam || capabilities.editProfile
      ? [{ href: `${base}/club-info`, label: "Club info", group: "Club" }]
      : []),
  ];
}

/** A reporter with no roster access (#375, #377): Home and the two report screens only. */
export function clubReporterNavItems({ base, capabilities }: { base: string; capabilities: ClubCapabilities }): AccountNavItem[] {
  return [
    { href: base, label: "Home" },
    ...(capabilities.submitReports ? [
      { href: `${base}/notes`, label: "Meeting notes", matchChildren: true, group: "Records" },
      { href: `${base}/reports`, label: "Monthly reports", matchChildren: true, group: "Records" },
    ] : []),
  ];
}
