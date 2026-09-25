import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

const events = [{
  id: "event_1",
  slug: "womens-retreat-2026",
  name: "Women’s Retreat 2026",
  permissions: [
    "VIEW_SENSITIVE_DATA",
    "MANAGE_FINANCE",
  ] as const,
}];

describe("application shell navigation", () => {
  it("places global system management before the event workspace", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events,
          user: {
            displayName: "Casey System Admin",
            email: "system@imsda-events.test",
            globalRole: "SYSTEM_ADMIN",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).toContain("Global administration");
    expect(markup).toContain("System management");
    expect(markup).toContain("Event workspace");
    expect(markup.indexOf("System management")).toBeLessThan(
      markup.indexOf("Event workspace"),
    );
    expect(markup).toContain("All events and integrations");
    expect(markup).toContain("Attendee experience");
    expect(markup).toContain(
      "/account/events/womens-retreat-2026?preview=staff",
    );
  });

  it("does not expose system management to event-only staff", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events,
          user: {
            displayName: "Riley Registration",
            email: "registration@imsda-events.test",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).not.toContain("Global administration");
    expect(markup).not.toContain("System management");
    expect(markup).toContain("Event workspace");
    expect(markup).toContain("Attendee experience");
  });

  function groupHeading(label: string) {
    return `nav-group-label">${label}<`;
  }

  it("groups sidebar destinations under labeled headings, in group order", () => {
    const groupedEvents = [{
      id: "event_1",
      slug: "womens-retreat-2026",
      name: "Women’s Retreat 2026",
      permissions: [
        "VIEW_SENSITIVE_DATA",
        "MANAGE_FINANCE",
        "MANAGE_CHECK_IN",
        "MANAGE_COMMUNICATIONS",
        "MANAGE_STAFF",
      ] as const,
    }];
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events: groupedEvents,
          user: {
            displayName: "Riley Registration",
            email: "registration@imsda-events.test",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).toContain(groupHeading("Events"));
    expect(markup).toContain(groupHeading("People"));
    expect(markup).toContain(groupHeading("Finance"));
    expect(markup).toContain(groupHeading("Communications"));
    // No club oversight and not a system admin: no Clubs and churches or System heading.
    expect(markup).not.toContain(groupHeading("Clubs and churches"));
    expect(markup).not.toContain(groupHeading("System"));
    // Group order: Events, then People, then Finance, then Communications.
    expect(markup.indexOf(groupHeading("Events"))).toBeLessThan(markup.indexOf(groupHeading("People")));
    expect(markup.indexOf(groupHeading("People"))).toBeLessThan(markup.indexOf(groupHeading("Finance")));
    expect(markup.indexOf(groupHeading("Finance"))).toBeLessThan(markup.indexOf(groupHeading("Communications")));
    // Every existing destination stays reachable.
    expect(markup).toContain("Check-in");
    expect(markup).toContain("Registrations");
    expect(markup).toContain("Team");
    expect(markup).toContain("Payments");
    expect(markup).toContain("Emails");
    expect(markup).toContain("More");
  });

  it("shows only the Events heading for a role with just MANAGE_CHECK_IN", () => {
    const checkInOnlyEvents = [{
      id: "event_1",
      slug: "womens-retreat-2026",
      name: "Women’s Retreat 2026",
      permissions: ["MANAGE_CHECK_IN"] as const,
    }];
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events: checkInOnlyEvents,
          user: {
            displayName: "Casey Check-in",
            email: "checkin@imsda-events.test",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).toContain(groupHeading("Events"));
    expect(markup).not.toContain(groupHeading("Clubs and churches"));
    expect(markup).not.toContain(groupHeading("People"));
    expect(markup).not.toContain(groupHeading("Finance"));
    expect(markup).not.toContain(groupHeading("Communications"));
    expect(markup).not.toContain(groupHeading("System"));
  });

  it("shows Clubs and churches, pointed at the directory, for a system admin", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events,
          user: {
            displayName: "Casey System Admin",
            email: "system@imsda-events.test",
            globalRole: "SYSTEM_ADMIN",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).toContain(groupHeading("Clubs and churches"));
    expect(markup).toContain('href="/admin/organizations"');
    expect(markup).toContain(groupHeading("System"));
  });

  it("shows Clubs and churches, pointed at club oversight, for an event manager with club oversight on the selected event", () => {
    const clubOversightEvents = [{
      id: "event_1",
      slug: "pathfinder-camporee-2026",
      name: "Pathfinder Camporee 2026",
      permissions: ["MANAGE_FINANCE"] as const,
      clubOversight: true,
    }];
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events: clubOversightEvents,
          user: {
            displayName: "Riley Event Admin",
            email: "eventadmin@imsda-events.test",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).toContain(groupHeading("Clubs and churches"));
    expect(markup).toContain('href="/more/clubs?event=event_1"');
    // Not a system admin: no System heading.
    expect(markup).not.toContain(groupHeading("System"));
  });

  it("does not show Clubs and churches when the selected event has no club oversight and the viewer isn't a system admin", () => {
    const noOversightEvents = [{
      id: "event_1",
      slug: "womens-retreat-2026",
      name: "Women’s Retreat 2026",
      permissions: ["MANAGE_FINANCE"] as const,
      clubOversight: false,
    }];
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events: noOversightEvents,
          user: {
            displayName: "Riley Registration",
            email: "registration@imsda-events.test",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).not.toContain(groupHeading("Clubs and churches"));
  });

  it("keeps the mobile tab bar's own order regardless of the sidebar's grouping", () => {
    const fullEvents = [{
      id: "event_1",
      slug: "womens-retreat-2026",
      name: "Women’s Retreat 2026",
      permissions: [
        "VIEW_SENSITIVE_DATA",
        "MANAGE_FINANCE",
        "MANAGE_CHECK_IN",
        "MANAGE_COMMUNICATIONS",
      ] as const,
    }];
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events: fullEvents,
          user: {
            displayName: "Riley Registration",
            email: "registration@imsda-events.test",
            globalRole: "SYSTEM_ADMIN",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    const mobileNav = markup.slice(markup.indexOf('<nav class="mobile-nav"'));
    // Home, People, Payments, Promos, Check-in, Emails, More — the old tab order,
    // unaffected by the sidebar's Events/People/Finance/… grouping or by the new
    // Clubs and churches / System entries (neither ever appears in the mobile bar).
    const order = ["/overview?", "/people?", "/finance?", "/more/promo-codes?", "/check-in?", "/communications?", "/more?"];
    let lastIndex = -1;
    for (const href of order) {
      const index = mobileNav.indexOf(`href="${href}`);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
    expect(mobileNav).not.toContain("/admin/organizations");
    expect(mobileNav).not.toContain('href="/admin"');
  });

  it("offers a real attendee-session switch when the staff email has an account", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          attendeeAccountAvailable: true,
          events,
          user: {
            displayName: "Riley Registration",
            email: "registration@imsda-events.test",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).toContain('action="/api/auth/switch-to-attendee"');
    expect(markup).toContain("My attendee account");
    expect(markup).toContain("Switch to your matching attendee account");
  });
});
