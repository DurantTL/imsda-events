import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildMoreDirectoryCards,
  matchesVisibility,
  mobileNavigationOrder,
  navigation,
  resolveClubsAndChurchesEntry,
} from "@/components/staff-navigation";
import { eventPermissions, eventRoles, rolePermissions, type EventPermission } from "@/modules/access/permissions";

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
};

const roleScenarios: Scenario[] = eventRoles.map((role) => ({
  name: role,
  permissions: rolePermissions[role],
  isSystemAdmin: false,
  clubOversight: false,
  clubEvent: false,
}));

const scenarios: Scenario[] = [
  ...roleScenarios,
  {
    name: "SYSTEM_ADMIN",
    permissions: eventPermissions,
    isSystemAdmin: true,
    clubOversight: false,
    clubEvent: false,
  },
  {
    name: "EVENT_ADMIN with club oversight on a club-billed event",
    permissions: rolePermissions.EVENT_ADMIN,
    isSystemAdmin: false,
    clubOversight: true,
    clubEvent: true,
  },
];

function moreDirectoryHrefs(scenario: Scenario): string[] {
  return buildMoreDirectoryCards({
    permissions: scenario.permissions,
    clubOversight: scenario.clubOversight,
    clubEvent: scenario.clubEvent,
    isSystemAdmin: scenario.isSystemAdmin,
    eventQuery: "",
  })
    .filter((card) => card.allowed)
    .map((card) => card.href);
}

/**
 * Destinations the desktop sidebar reaches for this scenario: every
 * sidebar-visible nav item (Dashboard, the grouped items, and the "/more"
 * gateway), "Clubs and churches" when it applies, and — since the sidebar's
 * own "More" link opens the very same page the phone's More tab opens —
 * every card that page shows.
 */
function sidebarDestinations(scenario: Scenario): Set<string> {
  const granted = new Set(scenario.permissions);
  const hrefs = navigation
    .filter((item) => matchesVisibility(item, granted))
    .map((item) => item.href);
  const clubsAndChurches = resolveClubsAndChurchesEntry(scenario);
  if (clubsAndChurches.visible) hrefs.push(clubsAndChurches.href);
  return new Set([...hrefs, ...moreDirectoryHrefs(scenario)]);
}

/** Destinations reachable from a phone: the bottom tabs plus every card the "More" directory shows. */
function phoneDestinations(scenario: Scenario): Set<string> {
  const granted = new Set(scenario.permissions);
  const tabHrefs = navigation
    .filter((item) => (mobileNavigationOrder as readonly string[]).includes(item.href))
    .filter((item) => matchesVisibility(item, granted))
    .map((item) => item.href);
  return new Set([...tabHrefs, ...moreDirectoryHrefs(scenario)]);
}

describe("phone navigation reaches every page the desktop sidebar reaches (#475)", () => {
  for (const scenario of scenarios) {
    it(`matches the desktop sidebar for ${scenario.name}`, () => {
      const desktop = sidebarDestinations(scenario);
      const phone = phoneDestinations(scenario);

      const missingOnPhone = [...desktop].filter((href) => !phone.has(href));
      const extraOnPhone = [...phone].filter((href) => !desktop.has(href));

      expect(missingOnPhone, `phone navigation is missing: ${missingOnPhone.join(", ")}`).toEqual([]);
      expect(extraOnPhone, `phone navigation shows destinations the role can't open: ${extraOnPhone.join(", ")}`).toEqual([]);
    });
  }

  it("shows no destination on phone that a read-only staff member can't open", () => {
    const scenario: Scenario = {
      name: "READ_ONLY_STAFF",
      permissions: rolePermissions.READ_ONLY_STAFF,
      isSystemAdmin: false,
      clubOversight: false,
      clubEvent: false,
    };
    const phone = phoneDestinations(scenario);

    // READ_ONLY_STAFF has only VIEW_EVENT: no configuration, finance, staff,
    // report, or club-oversight destination should be reachable.
    expect(phone).not.toContain("/more/event-settings");
    expect(phone).not.toContain("/more/attendee-configuration");
    expect(phone).not.toContain("/more/tags");
    expect(phone).not.toContain("/more/merchandise");
    expect(phone).not.toContain("/staff");
    expect(phone).not.toContain("/finance");
    expect(phone).not.toContain("/more/reports");
    expect(phone).not.toContain("/more/clubs");
    expect(phone).not.toContain("/admin/organizations");
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
    // Still exactly the six operational tabs plus More (#475 keeps them).
    for (const href of ["/overview?", "/people?", "/finance?", "/more/promo-codes?", "/check-in?", "/communications?", "/more?"]) {
      expect(mobileNav).toContain(`href="${href}`);
    }
    expect((mobileNav.match(/<a /g) ?? []).length).toBe(7);
  });
});
