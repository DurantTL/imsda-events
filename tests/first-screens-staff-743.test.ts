import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #743 first screens, staff side: Check-in, Registrations, More, the form
 * builder's device hint and the Dashboard checklist. Synthetic data only.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/more",
}));
vi.mock("@/components/use-accessible-dialog", () => ({ useAccessibleDialog: () => ({ current: null }) }));
const mocks = vi.hoisted(() => ({
  resolveEventContext: vi.fn(),
  resolveClubOversight: vi.fn(),
  resolveStaffViewer: vi.fn(),
  moduleState: vi.fn(),
  listRecentAuditActivity: vi.fn(),
  getOperationalHealth: vi.fn(),
  getEventOverview: vi.fn(),
  listRegistrations: vi.fn(),
  listEventBackgroundFlags: vi.fn(),
  getSetupChecklistFacts: vi.fn(),
}));
vi.mock("@/modules/events/selection", () => ({ resolveEventContext: mocks.resolveEventContext }));
vi.mock("@/modules/club-rosters/event-oversight", () => ({ resolveClubOversight: mocks.resolveClubOversight }));
vi.mock("@/modules/club-forms/access", () => ({ resolveStaffViewer: mocks.resolveStaffViewer }));
vi.mock("@/modules/event-modules/service", () => ({ moduleState: mocks.moduleState }));
vi.mock("@/modules/audit/audit-service", () => ({ listRecentAuditActivity: mocks.listRecentAuditActivity }));
vi.mock("@/modules/operations/repository", () => ({ getOperationalHealth: mocks.getOperationalHealth }));
vi.mock("@/components/event-activity-panel", () => ({ EventActivityPanel: () => createElement("div", { "data-panel": "activity" }) }));
vi.mock("@/components/details-open-on-hash", () => ({
  DetailsOpenOnHash: (props: { children: React.ReactNode }) => createElement("details", null, props.children),
}));
vi.mock("@/modules/events/repository", () => ({ getEventOverview: mocks.getEventOverview }));
vi.mock("@/modules/registrations/repository", () => ({ listRegistrations: mocks.listRegistrations }));
vi.mock("@/modules/background-checks/repository", () => ({ listEventBackgroundFlags: mocks.listEventBackgroundFlags }));
vi.mock("@/modules/events/setup-checklist-repository", () => ({ getSetupChecklistFacts: mocks.getSetupChecklistFacts }));

import MorePage from "@/app/(workspace)/more/page";
import OverviewPage from "@/app/(workspace)/overview/page";
import { ActionsMenu } from "@/components/actions-menu";
import { BuilderDeviceHint } from "@/components/builder-device-hint";
import { CheckInWorkspace } from "@/components/check-in-workspace";
import { projectCheckInArrivals } from "@/modules/checkin/arrival-view";
import { filterTasks, taskNameMatches } from "@/components/event-modules-page-model";
import { MoreTaskSearch } from "@/components/more-task-search";
import { PeopleWorkspace } from "@/components/people-workspace";
import { eventPermissions, rolePermissions, type EventPermission } from "@/modules/access/permissions";
import type { RegistrationRecord } from "@/modules/registrations/repository";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const before = (html: string, first: string, second: string) => {
  const a = html.indexOf(first);
  const b = html.indexOf(second);
  expect(a, `missing: ${first}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing: ${second}`).toBeGreaterThanOrEqual(0);
  return a < b;
};

function registration(index: number): RegistrationRecord {
  return {
    id: `registration-${index}`,
    confirmationCode: `TEST-${String(index).padStart(4, "0")}`,
    status: "CONFIRMED",
    accountHolder: { firstName: "Pat", lastName: `Example${index}`, email: `pat${index}@example.test` },
    attendees: [{ id: `attendee-${index}`, firstName: "Casey", lastName: `Sample${index}`, attendeeType: "ATTENDEE", checkedIn: false, checkedInAt: null }],
    payments: [],
    totalAmountCents: 0,
    balanceCents: 0,
    attendeeCount: 1,
    checkedInCount: 0,
    messages: [],
    adjustments: [],
  } as unknown as RegistrationRecord;
}

describe("Check-in opens on Search and Scan", () => {
  const html = renderToStaticMarkup(createElement(CheckInWorkspace, {
    eventName: "Synthetic Event",
    eventId: "event-1",
    initialArrivals: projectCheckInArrivals([registration(1), registration(2)], { showBalances: false }),
    canCheckIn: true,
  }));

  it("puts the scan and search tools before the heading, the status line and the roster", () => {
    expect(html.startsWith('<section class="page-stack"><div class="checkin-tools">')).toBe(true);
    expect(before(html, 'class="checkin-tools"', 'class="checkin-hero"')).toBe(true);
    expect(before(html, "Search arrivals", "Ready for arrivals")).toBe(true);
    expect(before(html, "Search arrivals", "Expected attendees")).toBe(true);
    expect(before(html, "Search arrivals", "check-in-network-status")).toBe(true);
  });

  it("keeps the scanner before the search box", () => {
    expect(before(html, "Scan", "Search arrivals")).toBe(true);
  });
});

describe("Registrations: search, then Start registration, then Actions", () => {
  const render = (props: { canEdit: boolean; canEmail: boolean }) => renderToStaticMarkup(createElement(PeopleWorkspace, {
    eventId: "event-1",
    eventSlug: "synthetic-retreat",
    eventTimezone: "America/Chicago",
    waitlistEnabled: false,
    initialRegistrations: [registration(1), registration(2)],
    ...props,
  }));

  it("orders the search box, the one primary button, and the Actions menu", () => {
    const html = render({ canEdit: true, canEmail: true });
    expect(before(html, "Search people", "Start registration")).toBe(true);
    expect(before(html, "Start registration", 'class="actions-menu"')).toBe(true);
    // Exactly one filled primary button on the screen.
    expect(html.match(/class="primary-button/g)).toHaveLength(1);
  });

  it("groups exports, duplicates, directory review and bulk email under one Actions menu", () => {
    const html = render({ canEdit: true, canEmail: true });
    const menu = html.slice(html.indexOf('class="actions-menu"'), html.indexOf("</details>", html.indexOf('class="actions-menu"')));
    expect(menu).toContain("Actions");
    expect(menu).toContain("Find duplicates");
    expect(menu).toContain("Directory review");
    expect(menu).toContain("Export CSV");
    expect(menu).toContain("Email selected");
    // Nothing is ticked, so bulk email is present but cannot be used.
    expect(menu).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Email selected/);
    // None of those sit outside the menu any more.
    const outside = html.replace(menu, "");
    expect(outside).not.toContain("Find duplicates");
    expect(outside).not.toContain("Export CSV");
    expect(outside).not.toContain("Directory review");
  });

  it("leaves out what the viewer cannot use, and keeps the Actions menu for the exports", () => {
    const html = render({ canEdit: false, canEmail: false });
    expect(html).not.toContain("Start registration");
    expect(html).not.toContain("Directory review");
    expect(html).not.toContain("Email selected");
    expect(html).toContain("Export CSV");
    expect(html).not.toContain("primary-button");
  });

  it("the Actions menu is an outlined disclosure, so it never adds a second filled button", () => {
    const html = renderToStaticMarkup(createElement(ActionsMenu, null, createElement("li", null, createElement("a", { href: "/x" }, "Do it"))));
    expect(html).toContain("<details");
    expect(html).toContain("secondary-button actions-menu-trigger");
    expect(html).not.toContain("primary-button");
  });
});

describe("More: compact groups and the optional task search", () => {
  it("matches a card or tool by name, every word, ignoring case", () => {
    expect(taskNameMatches("Registration forms", "")).toBe(true);
    expect(taskNameMatches("Registration forms", "   ")).toBe(true);
    expect(taskNameMatches("Registration forms", "forms")).toBe(true);
    expect(taskNameMatches("Registration forms", "REG form")).toBe(true);
    expect(taskNameMatches("Registration forms", "payments")).toBe(false);
    expect(taskNameMatches("Registration forms", "forms payments")).toBe(false);
  });

  it("keeps the count right when a query that hid a group is followed by one that matches in it", () => {
    const cards = [
      { id: "1", name: "Tags", groupIds: ["setup"], drawn: true },
      { id: "2", name: "Event settings", groupIds: ["setup"], drawn: true },
      { id: "3", name: "Merchandise", groupIds: ["sales"], drawn: true },
      { id: "4", name: "Payments", groupIds: ["tools", "tools-sales"], drawn: false },
    ];
    const miss = filterTasks({ cards, query: "tagsx" });
    expect(miss.count).toBe(0);
    expect([...miss.shownGroupIds]).toEqual([]);
    // Typing on: the group the first query hid is shown again and the card counts.
    const hit = filterTasks({ cards, query: "tags" });
    expect([...hit.shownCardIds]).toEqual(["1"]);
    expect([...hit.shownGroupIds]).toEqual(["setup"]);
    expect(hit.count).toBe(1);
    // Blank: every card and group again. A card the screen does not draw is shown but never counted.
    const blank = filterTasks({ cards, query: "" });
    expect(blank.shownCardIds.size).toBe(4);
    expect([...blank.shownGroupIds].sort()).toEqual(["sales", "setup", "tools", "tools-sales"]);
    expect(filterTasks({ cards, query: "payments" }).count).toBe(0);
    // A nested group shows when a card inside it does.
    expect([...filterTasks({ cards, query: "payments" }).shownGroupIds].sort()).toEqual(["tools", "tools-sales"]);
  });

  it("renders a labelled search box that filters the named container", () => {
    const html = renderToStaticMarkup(createElement(MoreTaskSearch, { containerId: "more-task-groups" }));
    expect(html).toContain('role="search"');
    expect(html).toContain("Find a task or tool");
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-live="polite"');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRecentAuditActivity.mockResolvedValue([]);
    mocks.getOperationalHealth.mockResolvedValue({ summary: { total: 0, urgent: 0, watch: 0 } });
    mocks.resolveEventContext.mockResolvedValue({
      event: { id: "event_1", name: "Synthetic Camporee", slug: "synthetic-camporee" },
      permissions: eventPermissions,
      user: { id: "user-1", displayName: "Riley Staff", email: "riley@imsda-events.test", globalRole: "SYSTEM_ADMIN" },
    });
    mocks.resolveClubOversight.mockResolvedValue({ allowed: false, clubEvent: false });
    mocks.resolveStaffViewer.mockResolvedValue({ kind: "STAFF" });
    const stored = new Set(["public-content", "merchandise"]);
    mocks.moduleState.mockResolvedValue({ stored, effective: stored, dataPresent: new Set(), dataForced: new Set() });
  });

  it("puts the search before the groups and names every card and tool for the filter", async () => {
    const html = renderToStaticMarkup(await MorePage({ searchParams: Promise.resolve({ event: "event_1" }) }));
    expect(before(html, 'role="search"', 'id="more-task-groups"')).toBe(true);
    const container = html.slice(html.indexOf('id="more-task-groups"'));
    expect(container).toContain('data-task-group="true"');
    expect(container).toMatch(/data-task-name="Public content"/);
    expect(container).toMatch(/data-task-name="Merchandise"/);
    // Tools (the phone list) are filterable too, and a viewer-allowed set only: a card that is not shown has no name here.
    expect(container).toMatch(/<a class="panel foundation-card" data-task-name="Event settings"/);
  });

  it("renders no search when the viewer has no card or tool to search", async () => {
    mocks.resolveEventContext.mockResolvedValue({
      event: { id: "event_1", name: "Synthetic Camporee", slug: "synthetic-camporee" },
      permissions: ["VIEW_EVENT"] as EventPermission[],
      user: { id: "user-2", displayName: "Sam Staff", email: "sam@imsda-events.test", globalRole: null },
    });
    mocks.resolveStaffViewer.mockResolvedValue(null);
    const html = renderToStaticMarkup(await MorePage({ searchParams: Promise.resolve({ event: "event_1" }) }));
    expect(html).not.toContain('role="search"');
  });

  it("decides in the browser, from drawn tasks only, whether the search is worth showing", () => {
    const source = read("components/more-task-search.tsx");
    expect(source).toContain("getClientRects().length > 0");
    expect(source).toContain("MORE_SEARCH_MIN_TASKS = 7");
    expect(source).toContain("drawn: isRendered(card)");
    // The server no longer counts the desktop-hidden phone list toward a threshold.
    expect(read("app/(workspace)/more/page.tsx")).not.toContain("> 6 &&");
  });

  it("styles hidden cards away and keeps compact groups in one commented block at the end of the stylesheet", () => {
    const css = read("app/globals.css");
    const marker = "#743 slice: First screens.";
    expect(css.split(marker)).toHaveLength(2);
    const block = css.slice(css.indexOf(marker));
    expect(block).toContain("[data-task-name][hidden]");
    expect(block).toContain(".event-modules-page .foundation-grid");
    let depth = 0;
    for (const character of css) depth += character === "{" ? 1 : character === "}" ? -1 : 0;
    expect(depth).toBe(0);
  });
});

describe("Form builder marks Computer or tablet before any click", () => {
  it("pre-selects Computer or tablet and shows Phone as not suited", () => {
    const html = renderToStaticMarkup(createElement(BuilderDeviceHint));
    expect(html).toContain('<li class="is-selected">');
    expect(html).toContain("Computer or tablet");
    expect(html).toContain("Recommended");
    expect(html).toMatch(/<li class="is-muted">[\s\S]*Phone[\s\S]*Not suited/);
    expect(before(html, "Computer or tablet", "Phone")).toBe(true);
  });

  it("sits first inside the builder, beside the phone-only notice that still replaces it on phones", () => {
    const page = read("app/(workspace)/registration-builder/page.tsx");
    expect(page).toContain('<div className="builder-phone-hidden"><BuilderDeviceHint /><RegistrationBuilderWorkspace');
    expect(page.indexOf("<BuilderPhoneNotice")).toBeLessThan(page.indexOf("<BuilderDeviceHint"));
  });
});

describe("Dashboard setup checklist is gated by permission", () => {
  const facts = {
    eventId: "event_1", slug: "synthetic-camporee", name: "Synthetic Camporee", startsOn: "2027-10-08", endsOn: "2027-10-10",
    isPublished: false, activeAttendeeTypeCount: 0, formCount: 0, testSubmissionCount: 0, publishedFormCount: 0,
  };
  const overview = {
    metrics: { registrations: 0, people: 0, checkedIn: 0, pendingPaymentCount: 0, outstandingCents: 0, churchBilledCents: 0, churchSponsoredCents: 0, groupBilledCents: 0, isDeferredOrganizationBilling: false },
    lifecycle: { remainingSpots: null },
  };
  const event = {
    id: "event_1", name: "Synthetic Camporee", slug: "synthetic-camporee", timezone: "America/Chicago", location: "Camp Fixture",
    capacity: 100, isPublished: false, startsAt: new Date("2027-10-08T12:00:00Z"), endsAt: new Date("2027-10-10T12:00:00Z"),
    registrationOpensOn: null, registrationClosesOn: null, waitlistEnabled: false,
  };
  async function render(permissions: readonly EventPermission[]) {
    mocks.resolveEventContext.mockResolvedValue({ event, permissions });
    mocks.getEventOverview.mockResolvedValue(overview);
    mocks.listRegistrations.mockResolvedValue([]);
    mocks.listEventBackgroundFlags.mockResolvedValue(null);
    mocks.getSetupChecklistFacts.mockResolvedValue(facts);
    return renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({ event: "event_1" }) }));
  }

  it("shows an event administrator the checklist right after the event header, before the metrics", async () => {
    const html = await render(eventPermissions);
    expect(html).toContain("Set up this event");
    expect(before(html, 'class="event-hero"', "Set up this event")).toBe(true);
    expect(before(html, "Set up this event", 'aria-label="Event metrics"')).toBe(true);
    expect(html).toContain('href="/more/event-settings?event=event_1#event-settings-block-basics"');
    expect(html).toContain('href="/registration-builder?event=event_1"');
  });

  it("shows a registration manager only the steps and links for the forms", async () => {
    const html = await render(rolePermissions.REGISTRATION_MANAGER);
    expect(html).toContain("Set up this event");
    expect(html).toContain('href="/registration-builder?event=event_1"');
    expect(html).not.toContain("/more/event-settings");
    expect(html).not.toContain("/more/attendee-configuration");
    expect(html).not.toContain("Event basics");
  });

  it("reads nothing and shows nothing to staff who cannot act on a step", async () => {
    mocks.getSetupChecklistFacts.mockClear();
    const html = await render(rolePermissions.FINANCE_MANAGER);
    expect(html).not.toContain("Set up this event");
    expect(mocks.getSetupChecklistFacts).not.toHaveBeenCalled();
  });
});
