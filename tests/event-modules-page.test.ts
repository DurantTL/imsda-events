import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #741 slice 2: `/more` is the Event modules page. Visibility rules per role,
 * the health strip, and that devices no longer live here. Synthetic data only.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const mocks = vi.hoisted(() => ({
  resolveEventContext: vi.fn(),
  resolveClubOversight: vi.fn(),
  resolveStaffViewer: vi.fn(),
  enabledModules: vi.fn(),
  listRecentAuditActivity: vi.fn(),
  getOperationalHealth: vi.fn(),
}));
vi.mock("@/modules/events/selection", () => ({ resolveEventContext: mocks.resolveEventContext }));
vi.mock("@/modules/club-rosters/event-oversight", () => ({ resolveClubOversight: mocks.resolveClubOversight }));
vi.mock("@/modules/club-forms/access", () => ({ resolveStaffViewer: mocks.resolveStaffViewer }));
vi.mock("@/modules/event-modules/service", () => ({ enabledModules: mocks.enabledModules }));
vi.mock("@/modules/audit/audit-service", () => ({ listRecentAuditActivity: mocks.listRecentAuditActivity }));
vi.mock("@/modules/operations/repository", () => ({ getOperationalHealth: mocks.getOperationalHealth }));
vi.mock("@/components/event-activity-panel", () => ({ EventActivityPanel: () => createElement("div", { "data-panel": "activity" }) }));
vi.mock("@/components/details-open-on-hash", () => ({
  DetailsOpenOnHash: (props: { children: React.ReactNode }) => createElement("details", null, props.children),
}));

import MorePage from "@/app/(workspace)/more/page";
import { buildEventModulesView, healthStripState } from "@/components/event-modules-page-model";
import { buildMoreDirectoryCards } from "@/components/staff-navigation";
import { eventPermissions, type EventPermission } from "@/modules/access/permissions";
import { eventModuleKeys, type EventModuleKey } from "@/modules/event-modules/catalog";

const event = { id: "event_1", name: "Synthetic Camporee", slug: "synthetic-camporee" };
const noIssues = { summary: { total: 0, urgent: 0, watch: 0 } };

function signIn(input: { globalRole: "SYSTEM_ADMIN" | null; permissions: readonly EventPermission[]; enabled: readonly EventModuleKey[]; clubEvent?: boolean }) {
  mocks.resolveEventContext.mockResolvedValue({
    event,
    permissions: input.permissions,
    user: { id: "user-1", displayName: "Riley Staff", email: "riley@imsda-events.test", globalRole: input.globalRole },
  });
  mocks.resolveClubOversight.mockResolvedValue({ allowed: Boolean(input.clubEvent), clubEvent: Boolean(input.clubEvent) });
  mocks.resolveStaffViewer.mockResolvedValue(input.globalRole === "SYSTEM_ADMIN" ? { kind: "STAFF" } : null);
  mocks.enabledModules.mockResolvedValue(new Set(["public-content", ...input.enabled]));
}

async function render() {
  return renderToStaticMarkup(await MorePage({ searchParams: Promise.resolve({ event: event.id }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRecentAuditActivity.mockResolvedValue([]);
  mocks.getOperationalHealth.mockResolvedValue(noIssues);
});

describe("/more as the Event modules page", () => {
  it("is headed Customize this event, with the event name in the subline", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: [] });
    const markup = await render();
    expect(markup).toContain(">Customize this event<");
    expect(markup).toContain("Turn features on or off for Synthetic Camporee");
  });

  it("shows a system administrator the enabled modules with Turn off and a collapsed Not used by this event with Enable", async () => {
    signIn({ globalRole: "SYSTEM_ADMIN", permissions: eventPermissions, enabled: ["merchandise"] });
    const markup = await render();
    expect(markup).toContain('data-module="merchandise"');
    expect(markup).toContain('aria-label="Turn off Merchandise"');
    expect(markup).toContain("Not used by this event");
    expect(markup).toContain('aria-label="Enable Honors classes"');
    expect(markup).toContain('aria-label="Enable Attendee community"');
    // Collapsed by default: a <details> with no open attribute.
    expect(markup).toMatch(/<details class="panel activity-disclosure event-modules-off"(?! open)/);
    // Public content is on for every event and cannot be turned off.
    expect(markup).toContain('data-module="public-content"');
    expect(markup).not.toContain('aria-label="Turn off Public content"');
  });

  it("shows an event admin only the enabled modules: no disabled card, no Enable, no Turn off", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: ["merchandise"] });
    const markup = await render();
    expect(markup).toContain('data-module="merchandise"');
    expect(markup).toContain('data-module="public-content"');
    expect(markup).not.toContain("Not used by this event");
    expect(markup).not.toContain("Enable ");
    expect(markup).not.toContain(">Enable<");
    expect(markup).not.toContain("Turn off");
    expect(markup).not.toContain('data-module="honors"');
    expect(markup).not.toContain('data-module="attendee-community"');
    expect(markup).toContain("A system administrator turns features on or off");
  });

  it("shows staff only the enabled modules they may open, and still no switch", async () => {
    signIn({ globalRole: null, permissions: ["MANAGE_FINANCE"], enabled: ["merchandise", "attendee-community"] });
    const markup = await render();
    // Merchandise and community need CONFIGURE_EVENT / MANAGE_COMMUNICATIONS, which this role lacks.
    expect(markup).not.toContain('data-module="merchandise"');
    expect(markup).not.toContain('data-module="attendee-community"');
    expect(markup).not.toContain("Not used by this event");
    expect(markup).not.toContain(">Enable<");
  });

  it("hides a card when the module is on but the event type does not apply (club modules on a general event)", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: ["event-patches", "club-assignments"], clubEvent: false });
    const markup = await render();
    expect(markup).not.toContain('data-module="event-patches"');
    expect(markup).not.toContain('data-module="club-assignments"');
  });

  it("shows the club modules on a club event", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: ["event-patches", "club-assignments"], clubEvent: true });
    const markup = await render();
    expect(markup).toContain('data-module="event-patches"');
    expect(markup).toContain('data-module="club-assignments"');
  });

  it("no longer lists signed-in devices; they live on the Profile page", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: [] });
    const markup = await render();
    expect(markup).not.toContain("Your signed-in devices");
    expect(markup).not.toContain("Sign out 1 other device");
    expect(markup).toContain("review your signed-in devices, on your profile page");
  });

  it("keeps the universal tools on the page for a phone, with club forms for conference staff", async () => {
    signIn({ globalRole: "SYSTEM_ADMIN", permissions: eventPermissions, enabled: [] });
    const markup = await render();
    expect(markup).toContain('aria-label="All tools"');
    for (const href of ["/more/event-settings", "/imports", "/finance", "/more/reports", "/more/club-forms", "/staff"]) {
      expect(markup).toContain(`href="${href}?event=event_1"`);
    }
  });
});

describe("health strip", () => {
  it("reads all clear from the existing operational health summary", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: [] });
    const markup = await render();
    expect(markup).toContain('data-state="clear"');
    expect(markup).toContain("All clear");
    expect(markup).toContain('href="/more/health?event=event_1"');
  });

  it("flags attention with the counts when something is open", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: [] });
    mocks.getOperationalHealth.mockResolvedValue({ summary: { total: 3, urgent: 1, watch: 2 } });
    const markup = await render();
    expect(markup).toContain('data-state="attention"');
    expect(markup).toContain("3 items need attention (1 need action, 2 to watch).");
  });

  it("is left out, and reads no health data, for staff who cannot open Operational health", async () => {
    signIn({ globalRole: null, permissions: ["MANAGE_CHECK_IN"], enabled: [] });
    const markup = await render();
    expect(markup).not.toContain("event-modules-health");
    expect(mocks.getOperationalHealth).not.toHaveBeenCalled();
  });

  it("derives its message from the summary alone", () => {
    expect(healthStripState({ total: 0, urgent: 0, watch: 0 }).state).toBe("clear");
    expect(healthStripState({ total: 1, urgent: 0, watch: 1 }).message).toBe("1 item needs attention (1 to watch).");
  });
});

describe("page view rules", () => {
  const cards = buildMoreDirectoryCards({
    permissions: eventPermissions,
    clubOversight: false,
    clubEvent: false,
    isSystemAdmin: false,
    clubFormsAccess: false,
    eventQuery: "?event=event_1",
  });

  it("gives only a system administrator the disabled modules and the right to toggle", () => {
    const enabled = new Set<EventModuleKey>(["public-content"]);
    const admin = buildEventModulesView({ cards, enabled, isSystemAdmin: true });
    const other = buildEventModulesView({ cards, enabled, isSystemAdmin: false });
    expect(admin.canToggle).toBe(true);
    expect(admin.disabled.map((entry) => entry.key)).toEqual(eventModuleKeys.filter((key) => key !== "public-content"));
    expect(other.canToggle).toBe(false);
    expect(other.disabled).toEqual([]);
  });

  it("keeps ordinary staff tools out of the module lists", () => {
    const view = buildEventModulesView({ cards, enabled: new Set(eventModuleKeys), isSystemAdmin: false });
    expect(view.tools.map((card) => card.key)).toContain("event-settings");
    expect(view.enabled.map((entry) => entry.card.key)).not.toContain("event-settings");
  });
});
