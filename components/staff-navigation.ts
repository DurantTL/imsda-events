import type { LucideIcon } from "lucide-react";
import {
  Award,
  CheckCircle2,
  ChartNoAxesCombined,
  FileText,
  FileUp,
  HeartPulse,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  MessagesSquare,
  MoreHorizontal,
  PanelsTopLeft,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  Tag,
  Tags,
  Tent,
  TicketPercent,
  Trophy,
  UserCog,
  UsersRound,
  WalletCards,
} from "lucide-react";
import type { EventPermission } from "@/modules/access/permissions";
import { canManageClubAssignments } from "@/modules/club-registrations/assignments-access";
import { canAccessOperationalHealth, operationalHealthEntryPermissions } from "@/modules/operations/access";
import { canManageProgramAssignments } from "@/modules/program-assignments/access";

/**
 * The single source of the destinations a signed-in staff member may reach:
 * the desktop sidebar (`components/app-shell.tsx`), the phone bottom tabs,
 * and the phone "More" directory (`app/(workspace)/more/page.tsx`) all read
 * this list, so which pages a role can open can't drift between desktop and
 * phone (#475).
 *
 * Groups for the sidebar (#428): items with no group render above any
 * heading (Dashboard) or after every group (More, a catch-all that spans
 * several of them). "Clubs and churches" and "System" are computed per
 * render, not statically, since their destination and visibility depend on
 * the signed-in user's role and (for Clubs and churches) the selected
 * event's club oversight.
 */
export type NavigationGroup = "events" | "clubs" | "people" | "finance" | "communications" | "system";

export const navigationGroupLabels: Record<NavigationGroup, string> = {
  events: "Events",
  clubs: "Clubs and churches",
  people: "People",
  finance: "Finance",
  communications: "Communications",
  system: "System",
};

export type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  desktopOnly?: boolean;
  requiredPermission?: EventPermission;
  requiredAnyPermissions?: readonly EventPermission[];
  group?: NavigationGroup;
};

/**
 * Adds the current event to a staff link so moving between areas (dashboard,
 * System management, Clubs and churches) keeps it (#616). Replaces any
 * `event` already on the href; leaves the href alone with no event.
 */
export function withCurrentEvent(href: string, eventId: string | null | undefined): string {
  if (!eventId) return href;
  const [pathAndQuery, hash] = href.split("#");
  const [path, query = ""] = pathAndQuery.split("?");
  const params = new URLSearchParams(query);
  params.set("event", eventId);
  return `${path}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

/**
 * One name per staff destination (#685). The nav label, the workspace header
 * title, the page's own title and its `<title>` all read the name defined here,
 * so a section can't be "People" in one place and "Registrations" in another.
 * `staffSubpageTitle` also names the `/more/*` pages that aren't nav items,
 * which the header used to call "More".
 */
export const staffPageTitles = {
  overview: "Dashboard",
  checkIn: "Check-in",
  registrationForm: "Registration form",
  attendeeSetup: "Attendee setup",
  tags: "Tags",
  eventSettings: "Event settings",
  registrations: "Registrations",
  imports: "Imports",
  team: "Team",
  payments: "Payments",
  promoCodes: "Promo codes",
  emails: "Emails",
  more: "More",
  systemManagement: "System management",
  honorsRosters: "Honors Weekend rosters",
  honors: "Honors Weekend classes",
  clubPacket: "Club packet",
  checkInBook: "Check-in book",
  clubReports: "Camporee club reports",
  groupedPackets: "Grouped retreat packets",
  operationalReports: "Operational reports",
  clubMonthlyReport: "Club monthly report",
  clubMonthlyReports: "Club monthly reports",
  clubs: "Clubs",
  club: "Club",
  clubForm: "Club form",
  clubForms: "Club forms",
  clubAssignments: "Club assignments",
  eventContent: "Public content",
  eventPatches: "Event patches",
  operationalHealth: "Operational health",
  merchandise: "Merchandise catalog",
  assignmentRoster: "Assignment roster",
  programAssignments: "Seminar assignments",
} as const;

type SubpageRule = readonly [path: string, match: "exact" | "prefix" | "under", title: string];

/**
 * Checked in order, so a longer or more specific path comes before the path it
 * sits under. `exact` is that path alone, `under` is anything below it, and
 * `prefix` is both.
 */
const subpageRules: readonly SubpageRule[] = [
  ["/more/honors/rosters", "prefix", staffPageTitles.honorsRosters],
  ["/more/honors", "prefix", staffPageTitles.honors],
  ["/more/reports/clubs/packet", "prefix", staffPageTitles.clubPacket],
  ["/more/reports/clubs/check-in-book", "prefix", staffPageTitles.checkInBook],
  ["/more/reports/clubs", "prefix", staffPageTitles.clubReports],
  ["/more/reports/packets", "prefix", staffPageTitles.groupedPackets],
  ["/more/reports", "prefix", staffPageTitles.operationalReports],
  ["/more/clubs/reports/", "under", staffPageTitles.clubMonthlyReport],
  ["/more/clubs/reports", "exact", staffPageTitles.clubMonthlyReports],
  ["/more/clubs", "exact", staffPageTitles.clubs],
  ["/more/clubs/", "under", staffPageTitles.club],
  ["/more/club-forms/", "under", staffPageTitles.clubForm],
  ["/more/club-forms", "exact", staffPageTitles.clubForms],
  ["/more/club-assignments", "prefix", staffPageTitles.clubAssignments],
  ["/more/event-content", "prefix", staffPageTitles.eventContent],
  ["/more/event-patches", "prefix", staffPageTitles.eventPatches],
  ["/more/health", "prefix", staffPageTitles.operationalHealth],
  ["/more/merchandise", "prefix", staffPageTitles.merchandise],
  ["/more/program-assignments/", "under", staffPageTitles.assignmentRoster],
  ["/more/program-assignments", "exact", staffPageTitles.programAssignments],
];

/** The title a staff page shows in the workspace header, or `null` to use its nav label. */
export function staffSubpageTitle(pathname: string): string | null {
  for (const [path, match, title] of subpageRules) {
    const isExact = pathname === path;
    const isUnder = pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
    if (match === "exact" ? isExact : match === "under" ? isUnder : isExact || isUnder) return title;
  }
  return null;
}

export const systemNavigation: NavigationItem = {
  href: "/admin",
  label: staffPageTitles.systemManagement,
  icon: ShieldCheck,
};

export const navigation: readonly NavigationItem[] = [
  { href: "/overview", label: staffPageTitles.overview, icon: LayoutDashboard },
  { href: "/check-in", label: staffPageTitles.checkIn, icon: CheckCircle2, requiredPermission: "MANAGE_CHECK_IN", group: "events" },
  { href: "/registration-builder", label: staffPageTitles.registrationForm, icon: PanelsTopLeft, desktopOnly: true, requiredPermission: "MANAGE_FORMS", group: "events" },
  { href: "/more/attendee-configuration", label: staffPageTitles.attendeeSetup, icon: Tags, desktopOnly: true, requiredPermission: "CONFIGURE_EVENT", group: "events" },
  { href: "/more/tags", label: staffPageTitles.tags, icon: Tag, desktopOnly: true, requiredPermission: "CONFIGURE_EVENT", group: "events" },
  { href: "/more/event-settings", label: staffPageTitles.eventSettings, icon: Settings2, desktopOnly: true, requiredPermission: "CONFIGURE_EVENT", group: "events" },
  { href: "/people", label: staffPageTitles.registrations, icon: UsersRound, requiredPermission: "VIEW_SENSITIVE_DATA", group: "people" },
  { href: "/imports", label: staffPageTitles.imports, icon: FileUp, desktopOnly: true, requiredPermission: "MANAGE_IMPORTS", group: "people" },
  { href: "/staff", label: staffPageTitles.team, icon: UserCog, desktopOnly: true, requiredPermission: "MANAGE_STAFF", group: "people" },
  { href: "/finance", label: staffPageTitles.payments, icon: WalletCards, requiredPermission: "MANAGE_FINANCE", group: "finance" },
  { href: "/more/promo-codes", label: staffPageTitles.promoCodes, icon: TicketPercent, requiredPermission: "MANAGE_FINANCE", group: "finance" },
  { href: "/communications", label: staffPageTitles.emails, icon: Megaphone, requiredPermission: "MANAGE_COMMUNICATIONS", group: "communications" },
  {
    href: "/more",
    label: staffPageTitles.more,
    icon: MoreHorizontal,
    requiredAnyPermissions: [
      "VIEW_REPORTS",
      "MANAGE_STAFF",
      "MANAGE_FINANCE",
      ...operationalHealthEntryPermissions,
    ],
  },
];

export function matchesVisibility(
  item: Pick<NavigationItem, "requiredPermission" | "requiredAnyPermissions">,
  selectedPermissions: ReadonlySet<EventPermission>,
) {
  if (item.requiredPermission && !selectedPermissions.has(item.requiredPermission)) return false;
  if (
    item.requiredAnyPermissions
    && !item.requiredAnyPermissions.some((permission) => selectedPermissions.has(permission))
  ) return false;
  return true;
}

/**
 * A sidebar destination's required permission, looked up by its `href`
 * (without a query string). Lets the phone "More" directory reuse the exact
 * permission the desktop sidebar already requires for the same page,
 * instead of naming it a second time (#475).
 */
export function requiredPermissionFor(href: string): EventPermission | undefined {
  return navigation.find((item) => item.href === href)?.requiredPermission;
}

/**
 * The mobile tab bar keeps its own, unrelated order (#428 review) rather
 * than deriving from the sidebar's grouping: Home, People, Payments,
 * Promos, Check-in, Emails, More.
 */
export const mobileNavigationOrder = [
  "/overview",
  "/people",
  "/finance",
  "/more/promo-codes",
  "/check-in",
  "/communications",
  "/more",
] as const;

/**
 * "Clubs and churches" is a club feature, so it shows only when the selected
 * event has a CLUB audience (#481) — that is, when `clubOversight` (from
 * `resolveClubOversight`, true only for a system admin or an EVENT_ADMIN on a
 * CLUB-audience event) is true, exactly as `more/page.tsx` gates it. A GENERAL
 * event never shows it, even for a system admin, who still reaches the
 * churches-and-clubs directory from System management. The href differs by
 * role: system admins get the full directory, event admins the event's club
 * oversight page. Both the sidebar and the phone "More" directory call this
 * so the two destinations can't drift (#475).
 */
export function resolveClubsAndChurchesEntry({
  clubOversight,
  isSystemAdmin,
}: {
  clubOversight: boolean;
  isSystemAdmin: boolean;
}): { href: string; visible: boolean } {
  return {
    href: isSystemAdmin ? "/admin/organizations" : "/more/clubs",
    visible: clubOversight,
  };
}

/**
 * The phone "More" directory (#475): every staff destination that isn't one
 * of the six bottom tabs, grouped the way the mobile review asked for
 * (Setup, Content & sales, People & access, Reports) — a different grouping
 * from the sidebar's, matched to how staff described the tasks they look
 * for on a phone. `buildMoreDirectoryCards` is a pure function of the
 * signed-in user's access, kept in this shared module (rather than inline
 * in `app/(workspace)/more/page.tsx`) so both the page and
 * `tests/mobile-directory-parity.test.ts` can build the same list without
 * duplicating a card's visibility rule. Two cards reuse the sidebar's own
 * required permission via `requiredPermissionFor` instead of naming it a
 * second time. On a CLUB-audience event (#481), "Clubs and churches" shows
 * the directory for system admins and the event's club oversight page for
 * anyone with club oversight (a system admin on a CLUB event sees both); on a
 * GENERAL event neither shows, for any role. The parity test checks
 * both against `resolveClubsAndChurchesEntry` and `/more/clubs`'s own guard.
 */
export type MoreDirectoryGroup = "setup" | "content-sales" | "people-access" | "reports";

export const moreDirectoryGroupOrder: readonly MoreDirectoryGroup[] = [
  "setup",
  "content-sales",
  "people-access",
  "reports",
];

export const moreDirectoryGroupLabels: Record<MoreDirectoryGroup, string> = {
  setup: "Setup",
  "content-sales": "Content & sales",
  "people-access": "People & access",
  reports: "Reports",
};

export type MoreDirectoryCard = {
  key: string;
  group: MoreDirectoryGroup;
  allowed: boolean;
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  cta: string;
};

export type MoreDirectoryContext = {
  permissions: readonly EventPermission[];
  /** From `resolveClubOversight` (`modules/club-rosters/event-oversight.ts`), the same call `more/page.tsx` already made. */
  clubOversight: boolean;
  /** Whether the selected event has a CLUB audience (#481), from the same `resolveClubOversight` result. */
  clubEvent: boolean;
  isSystemAdmin: boolean;
  /**
   * Club forms (#610) belong to no event: only system administrators and Event
   * Admins of a current event may open them (`resolveStaffViewer`), so the card
   * follows that rule rather than any event permission.
   */
  clubFormsAccess: boolean;
  /** `?event=<id>` (or `""` when nothing is selected), appended to every event-scoped href. */
  eventQuery: string;
};

export function buildMoreDirectoryCards({
  permissions,
  clubOversight,
  clubEvent,
  isSystemAdmin,
  clubFormsAccess,
  eventQuery,
}: MoreDirectoryContext): readonly MoreDirectoryCard[] {
  const granted = new Set(permissions);
  const has = (permission: EventPermission) => granted.has(permission);
  const attendeeConfigurationPermission = requiredPermissionFor("/more/attendee-configuration");
  const tagsPermission = requiredPermissionFor("/more/tags");

  return [
    { key: "event-settings", group: "setup", allowed: has("CONFIGURE_EVENT"), href: `/more/event-settings${eventQuery}`, icon: Settings2, title: "Event settings", description: "Edit dates, location, capacity, registration availability, and publishing.", cta: "Open settings" },
    { key: "attendee-configuration", group: "setup", allowed: Boolean(attendeeConfigurationPermission && has(attendeeConfigurationPermission)), href: `/more/attendee-configuration${eventQuery}`, icon: Tags, title: "Attendee setup", description: "Define the attendee types and per-type pricing this event registers.", cta: "Open attendee setup" },
    { key: "tags", group: "setup", allowed: Boolean(tagsPermission && has(tagsPermission)), href: `/more/tags${eventQuery}`, icon: Tag, title: "Tags", description: "Create and color-code the tags staff use to mark and filter registrations.", cta: "Manage tags" },
    { key: "honors", group: "setup", allowed: has("CONFIGURE_EVENT"), href: `/more/honors${eventQuery}`, icon: Award, title: "Honors Weekend classes", description: "Name this site's sessions and set the honor classes, seats, and age limits it offers.", cta: "Set up classes" },
    { key: "registration-builder", group: "setup", allowed: has("MANAGE_FORMS"), href: `/registration-builder${eventQuery}`, icon: PanelsTopLeft, title: "Registration forms", description: "Build, test, and publish the form people use to register.", cta: "Open form builder" },
    { key: "program-assignments", group: "setup", allowed: canManageProgramAssignments(permissions), href: `/more/program-assignments${eventQuery}`, icon: ListChecks, title: "Seminar assignments", description: "Turn attendee rankings and room limits into reviewed, printable session rosters.", cta: "Preview assignments" },
    { key: "event-content", group: "content-sales", allowed: has("CONFIGURE_EVENT"), href: `/more/event-content${eventQuery}`, icon: FileText, title: "Public content", description: "Speaker bios, seminar descriptions, lodging, schedules, and downloads shown publicly.", cta: "Edit page" },
    { key: "merchandise", group: "content-sales", allowed: has("CONFIGURE_EVENT"), href: `/more/merchandise${eventQuery}`, icon: ShoppingBag, title: "Merchandise", description: "Add products, set artwork and pricing, and control what's available at registration.", cta: "Open merchandise" },
    { key: "promo-codes", group: "content-sales", allowed: has("MANAGE_FINANCE"), href: `/more/promo-codes${eventQuery}`, icon: TicketPercent, title: "Promo codes", description: "Create bounded registration discounts, schedule dates, and review use limits.", cta: "Manage discounts" },
    { key: "community", group: "content-sales", allowed: has("MANAGE_COMMUNICATIONS"), href: `/community${eventQuery}`, icon: MessagesSquare, title: "Attendee community", description: "Open or pause discussion, review attendee reports, and moderate posts and replies.", cta: "Moderate community" },
    { key: "staff", group: "people-access", allowed: has("MANAGE_STAFF"), href: `/staff${eventQuery}`, icon: UserCog, title: "Staff", description: "Add staff and choose what each person can do for this event.", cta: "Manage team" },
    // On a CLUB-audience event (#481), system admins reach the
    // churches-and-clubs directory (the sidebar's "Clubs and churches" link
    // for them); on a GENERAL event it stays in System management only...
    {
      key: "clubs-and-churches",
      group: "people-access",
      allowed: isSystemAdmin && clubOversight,
      href: "/admin/organizations",
      icon: UsersRound,
      title: "Clubs and churches",
      description: "The full churches-and-clubs directory: every organization, its directors, and its registrations.",
      cta: "Open directory",
    },
    // ...and anyone with club oversight of this CLUB-audience event — system
    // admins included — keeps the event's own club rosters and monthly
    // reports, gated exactly as on main and by `/more/clubs` itself.
    {
      key: "clubs",
      group: "people-access",
      allowed: clubOversight,
      href: `/more/clubs${eventQuery}`,
      icon: UsersRound,
      title: isSystemAdmin ? "This event's clubs" : "Clubs and churches",
      description: "Every registered club's roster (ages only) and all clubs' monthly reports, view only.",
      cta: "Open clubs",
    },
    { key: "club-assignments", group: "people-access", allowed: clubEvent && canManageClubAssignments(permissions), href: `/more/club-assignments${eventQuery}`, icon: Tent, title: "Club assignments", description: "Set each registered club's campsite, duty, and activity, then email directors after review.", cta: "Assign clubs" },
    { key: "event-patches", group: "setup", allowed: clubEvent && has("CONFIGURE_EVENT"), href: `/more/event-patches${eventQuery}`, icon: Trophy, title: "Event patches", description: "Link the patch or pin a club event gives, so directors are suggested it for every member who attended.", cta: "Link patches" },
    // Club forms (#610) belong to no event: system administrators and Event Admins of a current event only.
    { key: "club-forms", group: "people-access", allowed: clubFormsAccess, href: `/more/club-forms${eventQuery}`, icon: FileText, title: "Club forms", description: "Membership applications, staff service forms, permission slips, and passenger lists clubs have filled in.", cta: "Open club forms" },
    { key: "imports", group: "people-access", allowed: has("MANAGE_IMPORTS"), href: `/imports${eventQuery}`, icon: FileUp, title: "Import registrations", description: "Preview a CSV, review every change, then import approved records.", cta: "Open imports" },
    { key: "reports", group: "reports", allowed: has("VIEW_REPORTS"), href: `/more/reports${eventQuery}`, icon: ChartNoAxesCombined, title: "Operational reports", description: "Print active attendee rosters and review meal, housing, and ranked seminar totals.", cta: "Open reports" },
    { key: "health", group: "reports", allowed: canAccessOperationalHealth(permissions), href: `/more/health${eventQuery}`, icon: HeartPulse, title: "Operational health", description: "Review failed or delayed work, open balances, import exceptions, and capacity warnings.", cta: "Review exceptions" },
  ];
}
