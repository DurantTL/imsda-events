import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildMoreDirectoryCards,
  canShowMoreLauncher,
  matchesVisibility,
  mobileNavigationOrder,
  navigation,
  resolveClubsAndChurchesEntry,
} from "@/components/staff-navigation";
import { eventPermissions, eventRoles, rolePermissions, type EventPermission } from "@/modules/access/permissions";
import { canManageClubAssignments } from "@/modules/club-registrations/assignments-access";
import { canAccessOperationalHealth } from "@/modules/operations/access";
import { canManageProgramAssignments } from "@/modules/program-assignments/access";

/**
 * #475: every page the desktop sidebar can reach for a role must be
 * reachable from phone navigation for that role, and nothing may appear on
 * phone that the role can't open. Both surfaces read
 * `components/staff-navigation.ts`, so this test builds the two reachable
 * sets from that single source and compares them per role, rather than
 * hand-listing pages (which is exactly what let the sidebar and the phone
 * "More" directory drift before #475).
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("event=event_1"),
}));

vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => createElement("button", { type: "button" }, "Sign out"),
}));

import { AppShell } from "@/components/app-shell";

const AppShellElement = AppShell as ComponentType<
  Omit<Parameters<typeof AppShell>[0], "children">
>;

type Scenario = {
  name: string;
  permissions: readonly EventPermission[];
  isSystemAdmin: boolean;
  clubOversight: boolean;
  clubEvent: boolean;
  /** System administrator, or Event Admin of a current event (#610). */
  clubFormsAccess: boolean;
};

const roleScenarios: Scenario[] = eventRoles.map((role) => ({
  name: role,
  permissions: rolePermissions[role],
  isSystemAdmin: false,
  clubOversight: false,
  clubEvent: false,
  clubFormsAccess: role === "EVENT_ADMIN",
}));

// `clubOversight` is only ever true on a CLUB-audience event (#481) for a
// system admin or an EVENT_ADMIN (`resolveClubOversight`), so the scenarios
// stay consistent with that rule. `clubEvent` means a CLUB audience, not a
// billing mode.
const specialScenarios: Scenario[] = [
  {
    name: "SYSTEM_ADMIN on a GENERAL event",
    permissions: eventPermissions,
    isSystemAdmin: true,
    clubOversight: false,
    clubEvent: false,
    clubFormsAccess: true,
  },
  {
    name: "SYSTEM_ADMIN with club oversight on a CLUB-audience event",
    permissions: eventPermissions,
    isSystemAdmin: true,
    clubOversight: true,
    clubEvent: true,
    clubFormsAccess: true,
  },
  {
    name: "EVENT_ADMIN with club oversight on a CLUB-audience event",
    permissions: rolePermissions.EVENT_ADMIN,
    isSystemAdmin: false,
    clubOversight: true,
    clubEvent: true,
    clubFormsAccess: true,
  },
  {
    name: "REGISTRATION_MANAGER on a CLUB-audience event (no oversight)",
    permissions: rolePermissions.REGISTRATION_MANAGER,
    isSystemAdmin: false,
    clubOversight: false,
    clubEvent: true,
    clubFormsAccess: false,
  },
  {
    name: "custom: CHECK_IN_STAFF plus CONFIGURE_EVENT",
    permissions: [...rolePermissions.CHECK_IN_STAFF, "CONFIGURE_EVENT"],
    isSystemAdmin: false,
    clubOversight: false,
    clubEvent: false,
    clubFormsAccess: false,
  },
  {
    name: "custom: READ_ONLY_STAFF plus VIEW_REPORTS",
    permissions: [...rolePermissions.READ_ONLY_STAFF, "VIEW_REPORTS"],
    isSystemAdmin: false,
    clubOversight: false,
    clubEvent: false,
    clubFormsAccess: false,
  },
  {
    name: "custom: CHECK_IN_STAFF plus MANAGE_REGISTRATION on a CLUB-audience event",
    permissions: [...rolePermissions.CHECK_IN_STAFF, "MANAGE_REGISTRATION"],
    isSystemAdmin: false,
    clubOversight: false,
    clubEvent: true,
    clubFormsAccess: false,
  },
  {
    // MANAGE_REGISTRATION without VIEW_SENSITIVE_DATA: seminar assignments need both.
    name: "custom: READ_ONLY_STAFF plus MANAGE_REGISTRATION",
    permissions: [...rolePermissions.READ_ONLY_STAFF, "MANAGE_REGISTRATION"],
    isSystemAdmin: false,
    clubOversight: false,
    clubEvent: false,
    clubFormsAccess: false,
  },
  {
    // The only extra grant is MANAGE_IMPORTS: More must show and reach its card (#737).
    name: "custom: READ_ONLY_STAFF plus MANAGE_IMPORTS",
    permissions: [...rolePermissions.READ_ONLY_STAFF, "MANAGE_IMPORTS"],
    isSystemAdmin: false,
    clubOversight: false,
    clubEvent: false,
    clubFormsAccess: false,
  },
  {
    // Check-in staff whose only extra grant is health information, on a club event (#737).
    name: "custom: CHECK_IN_STAFF plus VIEW_HEALTH_INFORMATION on a CLUB-audience event",
    permissions: [...rolePermissions.CHECK_IN_STAFF, "VIEW_HEALTH_INFORMATION"],
    isSystemAdmin: false,
    clubOversight: false,
    clubEvent: true,
    clubFormsAccess: false,
  },
];

const scenarios: Scenario[] = [...roleScenarios, ...specialScenarios];

const has = (scenario: Scenario, permission: EventPermission) => scenario.permissions.includes(permission);

/**
 * Pages the desktop sidebar has no link for, reached only through the "More"
 * page. Each predicate mirrors that page's own server guard (not the card's
 * `allowed` rule), so a card that leaks past its page's guard — or goes
 * missing while the page would open — fails here.
 */
const moreOnlyPages: Record<string, (scenario: Scenario) => boolean> = {
  // app/(workspace)/more/honors/page.tsx
  "/more/honors": (scenario) => has(scenario, "CONFIGURE_EVENT"),
  // app/(workspace)/more/event-content/page.tsx
  "/more/event-content": (scenario) => has(scenario, "CONFIGURE_EVENT"),
  // app/(workspace)/more/merchandise/page.tsx
  "/more/merchandise": (scenario) => has(scenario, "CONFIGURE_EVENT"),
  // app/(workspace)/more/program-assignments/page.tsx
  "/more/program-assignments": (scenario) => canManageProgramAssignments(scenario.permissions),
  // app/(workspace)/more/event-patches/page.tsx: CONFIGURE_EVENT, then a CLUB-audience event (#532)
  "/more/event-patches": (scenario) => has(scenario, "CONFIGURE_EVENT") && scenario.clubEvent,
  // app/(workspace)/more/club-assignments/page.tsx: permission, then a CLUB-audience event
  "/more/club-assignments": (scenario) => canManageClubAssignments(scenario.permissions) && scenario.clubEvent,
  // app/(workspace)/community/page.tsx
  "/community": (scenario) => has(scenario, "MANAGE_COMMUNICATIONS"),
  // app/(workspace)/more/reports/page.tsx
  "/more/reports": (scenario) => has(scenario, "VIEW_REPORTS"),
  // app/(workspace)/more/health/page.tsx
  "/more/health": (scenario) => canAccessOperationalHealth(scenario.permissions),
  // app/(workspace)/more/club-forms/page.tsx (#610): system administrators and Event Admins of a current event (`resolveStaffViewer`).
  "/more/club-forms": (scenario) => scenario.clubFormsAccess,
  // app/(workspace)/more/event-health/page.tsx (#658): the VIEW_HEALTH_INFORMATION permission (system administrators, or a grant), on a CLUB-audience event.
  "/more/event-health": (scenario) => has(scenario, "VIEW_HEALTH_INFORMATION") && scenario.clubEvent,
  // app/(workspace)/more/clubs/page.tsx (`resolveClubOversight().allowed`).
  // The sidebar links a system admin to the directory instead, so for them
  // this event view is reached only from "More".
  "/more/clubs": (scenario) => scenario.clubOversight,
};

const moreItem = navigation.find((item) => item.href === "/more");
if (!moreItem) throw new Error("navigation has no /more entry");

/** What the shell renders: the More launcher follows the cards the user may open (#737). */
function moreLauncherVisible(scenario: Scenario): boolean {
  return canShowMoreLauncher({
    item: moreItem!,
    permissions: scenario.permissions,
    clubOversight: scenario.clubOversight,
    clubEvent: scenario.clubEvent,
    isSystemAdmin: scenario.isSystemAdmin,
    clubFormsAccess: false,
  });
}

function allowedMoreCardHrefs(scenario: Scenario): string[] {
  return buildMoreDirectoryCards({
    permissions: scenario.permissions,
    clubOversight: scenario.clubOversight,
    clubEvent: scenario.clubEvent,
    isSystemAdmin: scenario.isSystemAdmin,
    clubFormsAccess: scenario.clubFormsAccess,
    eventQuery: "",
  })
    .filter((card) => card.allowed)
    .map((card) => card.href);
}

/**
 * Destinations the desktop sidebar links to for this scenario: every
 * sidebar-visible nav item (Dashboard, the grouped items, and the "/more"
 * gateway) and "Clubs and churches" when it applies. The More page's cards
 * are deliberately not included, so they are checked independently below.
 */
function sidebarDestinations(scenario: Scenario): Set<string> {
  const granted = new Set(scenario.permissions);
  const hrefs = navigation
    .filter((item) => matchesVisibility(item, granted))
    .map((item) => item.href);
  const clubsAndChurches = resolveClubsAndChurchesEntry(scenario);
  if (clubsAndChurches.visible) hrefs.push(clubsAndChurches.href);
  return new Set(hrefs);
}

/**
 * Destinations reachable from a phone: the visible bottom tabs, plus every
 * card the "More" directory shows — but only when the More tab itself is
 * visible, since otherwise the phone has no way to open that page.
 */
function phoneDestinations(scenario: Scenario): Set<string> {
  const granted = new Set(scenario.permissions);
  const tabHrefs = navigation
    .filter((item) => (mobileNavigationOrder as readonly string[]).includes(item.href))
    .filter((item) => matchesVisibility(item, granted))
    .map((item) => item.href);
  const moreHrefs = moreLauncherVisible(scenario) ? allowedMoreCardHrefs(scenario) : [];
  return new Set([...tabHrefs, ...moreHrefs]);
}

/**
 * Hand-written pages each scenario must never reach on phone, independent of
 * the navigation source, so a loosened card or tab rule fails for every role
 * (not only READ_ONLY_STAFF).
 */
const configPages = ["/more/event-settings", "/more/attendee-configuration", "/more/tags", "/more/honors", "/more/event-content", "/more/merchandise"];
const clubPages = ["/more/clubs", "/admin/organizations", "/more/club-assignments"];
const deniedOnPhone: Record<string, readonly string[]> = {
  EVENT_ADMIN: ["/admin/organizations", "/more/clubs", "/more/club-assignments", "/admin", "/more/event-health"],
  REGISTRATION_MANAGER: [...configPages, "/more/event-health", "/check-in", "/finance", "/more/promo-codes", "/communications", "/community", "/staff", "/imports", ...clubPages],
  FINANCE_MANAGER: [...configPages, "/more/event-health", "/check-in", "/registration-builder", "/more/program-assignments", "/communications", "/community", "/staff", "/imports", ...clubPages],
  COMMUNICATIONS_MANAGER: [...configPages, "/people", "/check-in", "/registration-builder", "/more/program-assignments", "/finance", "/more/promo-codes", "/more/reports", "/staff", "/imports", ...clubPages],
  CHECK_IN_STAFF: [...configPages, "/more", "/more/health", "/more/reports", "/registration-builder", "/more/program-assignments", "/finance", "/more/promo-codes", "/communications", "/community", "/staff", "/imports", ...clubPages],
  READ_ONLY_STAFF: [...configPages, "/more", "/more/health", "/more/reports", "/people", "/check-in", "/registration-builder", "/more/program-assignments", "/finance", "/more/promo-codes", "/communications", "/community", "/staff", "/imports", ...clubPages],
  // #481: a GENERAL event shows no club features, even for a system admin
  // (who still reaches the directory from System management, not the phone).
  "SYSTEM_ADMIN on a GENERAL event": ["/admin/organizations", "/more/clubs", "/more/club-assignments"],
  "EVENT_ADMIN with club oversight on a CLUB-audience event": ["/admin/organizations", "/more/event-health"],
  "REGISTRATION_MANAGER on a CLUB-audience event (no oversight)": ["/more/clubs", "/admin/organizations", "/more/event-health", ...configPages],
  "custom: CHECK_IN_STAFF plus CONFIGURE_EVENT": ["/more/reports", "/more/program-assignments", "/finance", "/staff", "/imports", "/community", ...clubPages],
  "custom: READ_ONLY_STAFF plus VIEW_REPORTS": [...configPages, "/more/health", "/people", "/finance", "/staff", "/imports", "/community", ...clubPages],
  "custom: CHECK_IN_STAFF plus MANAGE_REGISTRATION on a CLUB-audience event": [...configPages, "/more/clubs", "/admin/organizations", "/more/reports", "/finance", "/staff"],
  "custom: READ_ONLY_STAFF plus MANAGE_REGISTRATION": [...configPages, "/more/program-assignments", "/finance", "/staff", "/community", ...clubPages],
  "custom: READ_ONLY_STAFF plus MANAGE_IMPORTS": [...configPages, "/more/event-health", "/more/reports", "/finance", "/staff", "/community", ...clubPages],
  "custom: CHECK_IN_STAFF plus VIEW_HEALTH_INFORMATION on a CLUB-audience event": [...configPages, "/more/reports", "/more/health", "/finance", "/staff", "/imports", "/community", "/more/clubs", "/admin/organizations", "/more/club-assignments"],
};

describe("phone navigation reaches every page the desktop sidebar reaches (#475)", () => {
  for (const scenario of scenarios) {
    describe(scenario.name, () => {
      it("reaches every sidebar destination on phone", () => {
        const desktop = sidebarDestinations(scenario);
        const phone = phoneDestinations(scenario);
        const missingOnPhone = [...desktop].filter((href) => !phone.has(href));
        expect(missingOnPhone, `phone navigation is missing: ${missingOnPhone.join(", ")}`).toEqual([]);
      });

      it("shows only More cards the sidebar reaches or whose page guard admits the scenario", () => {
        const desktop = sidebarDestinations(scenario);
        const unexplained = allowedMoreCardHrefs(scenario).filter((href) => {
          if (desktop.has(href)) return false;
          const guard = moreOnlyPages[href];
          return !guard || !guard(scenario);
        });
        expect(unexplained, `More shows cards the role can't open: ${unexplained.join(", ")}`).toEqual([]);
      });

      it("shows a More card for every More-only page its guard admits", () => {
        const phone = phoneDestinations(scenario);
        const moreVisible = moreLauncherVisible(scenario);
        for (const [href, guard] of Object.entries(moreOnlyPages)) {
          const expected = moreVisible && guard(scenario);
          expect(phone.has(href), `${href} on phone`).toBe(expected);
        }
      });

      it("never reaches the pages the scenario is denied", () => {
        const denied = deniedOnPhone[scenario.name] ?? [];
        const phone = phoneDestinations(scenario);
        const leaked = denied.filter((href) => phone.has(href));
        expect(leaked, `phone reaches denied pages: ${leaked.join(", ")}`).toEqual([]);
      });
    });
  }

  it("has a hand-written denial list for every role and non-full-access scenario", () => {
    for (const scenario of scenarios) {
      if (scenario.name === "SYSTEM_ADMIN with club oversight on a CLUB-audience event") continue;
      expect(deniedOnPhone[scenario.name]?.length ?? 0, scenario.name).toBeGreaterThan(0);
    }
  });

  it("gives a system admin on a GENERAL event neither club destination on phone (#481)", () => {
    const scenario: Scenario = {
      name: "SYSTEM_ADMIN on a GENERAL event billed to an organization",
      permissions: eventPermissions,
      isSystemAdmin: true,
      clubOversight: false,
      clubEvent: false,
      clubFormsAccess: true,
    };
    const phone = phoneDestinations(scenario);
    expect(phone.has("/admin/organizations")).toBe(false);
    expect(phone.has("/more/clubs")).toBe(false);
    expect(sidebarDestinations(scenario).has("/admin/organizations")).toBe(false);
    expect(resolveClubsAndChurchesEntry(scenario).visible).toBe(false);
  });

  it("keeps the event's club oversight card for a system admin with club oversight, alongside the directory", () => {
    const hrefs = allowedMoreCardHrefs({
      name: "SYSTEM_ADMIN with club oversight",
      permissions: eventPermissions,
      isSystemAdmin: true,
      clubOversight: true,
      clubEvent: true,
      clubFormsAccess: true,
    });
    expect(hrefs).toContain("/more/clubs");
    expect(hrefs).toContain("/admin/organizations");
  });

  it("renders the phone bottom tabs from the same source as the sidebar for a full-access role", () => {
    const events = [{
      id: "event_1",
      slug: "womens-retreat-2026",
      name: "Women's Retreat 2026",
      permissions: eventPermissions,
    }];
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events,
          user: { displayName: "Casey Full Access", email: "full@imsda-events.test" },
        },
        createElement("p", null, "Workspace content"),
      ),
    );
    const mobileNav = markup.slice(markup.indexOf('<nav class="mobile-nav"'));
    // At most five tabs (#711); Payments and Promo codes live in More.
    const hrefs = [...mobileNav.matchAll(/<a [^>]*href="([^"?]+)\?/g)].map((match) => match[1]);
    expect(hrefs).toEqual(["/overview", "/people", "/check-in", "/communications", "/more"]);
    const labels = [...mobileNav.matchAll(/<span>([^<]+)<\/span>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Home", "People", "Check-in", "Emails", "More"]);
    expect(mobileNav).not.toContain("/finance");
    expect(mobileNav).not.toContain("promo-codes");
  });

  it("keeps Payments and Promo codes one tap from More, behind MANAGE_FINANCE (#711)", () => {
    const base = { clubOversight: false, clubEvent: false, isSystemAdmin: false, clubFormsAccess: false, eventQuery: "?event=e1" };
    const withFinance = buildMoreDirectoryCards({ ...base, permissions: ["MANAGE_FINANCE"] }).filter((card) => card.allowed);
    expect(withFinance.map((card) => card.href)).toEqual(expect.arrayContaining(["/finance?event=e1", "/more/promo-codes?event=e1"]));
    const without = buildMoreDirectoryCards({ ...base, permissions: ["VIEW_REPORTS"] }).filter((card) => card.allowed);
    expect(without.map((card) => card.href)).not.toContain("/finance?event=e1");
    expect(without.map((card) => card.href)).not.toContain("/more/promo-codes?event=e1");
  });
});
