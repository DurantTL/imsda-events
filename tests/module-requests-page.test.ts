import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #741 slice 3: the Request a feature panel on `/more` and the System management
 * queue. Who sees the panel, what each request status shows, and the re-request
 * rule in the UI. Synthetic data only.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const mocks = vi.hoisted(() => ({
  resolveEventContext: vi.fn(),
  resolveClubOversight: vi.fn(),
  resolveStaffViewer: vi.fn(),
  moduleState: vi.fn(),
  listRecentAuditActivity: vi.fn(),
  getOperationalHealth: vi.fn(),
  listModuleRequestsForEvent: vi.fn(),
}));
vi.mock("@/modules/events/selection", () => ({ resolveEventContext: mocks.resolveEventContext }));
vi.mock("@/modules/club-rosters/event-oversight", () => ({ resolveClubOversight: mocks.resolveClubOversight }));
vi.mock("@/modules/club-forms/access", () => ({ resolveStaffViewer: mocks.resolveStaffViewer }));
vi.mock("@/modules/event-modules/service", () => ({ moduleState: mocks.moduleState }));
vi.mock("@/modules/event-modules/requests", () => ({ listModuleRequestsForEvent: mocks.listModuleRequestsForEvent }));
vi.mock("@/modules/audit/audit-service", () => ({ listRecentAuditActivity: mocks.listRecentAuditActivity }));
vi.mock("@/modules/operations/repository", () => ({ getOperationalHealth: mocks.getOperationalHealth }));
vi.mock("@/components/event-activity-panel", () => ({ EventActivityPanel: () => createElement("div", { "data-panel": "activity" }) }));
vi.mock("@/components/details-open-on-hash", () => ({
  DetailsOpenOnHash: (props: { children: React.ReactNode }) => createElement("details", null, props.children),
}));

import MorePage from "@/app/(workspace)/more/page";
import { buildRequestPanel } from "@/components/event-modules-page-model";
import { ModuleRequestQueue } from "@/components/module-request-queue";
import { eventPermissions, type EventPermission } from "@/modules/access/permissions";
import { type EventModuleKey } from "@/modules/event-modules/catalog";

const event = { id: "event_1", name: "Synthetic Camporee", slug: "synthetic-camporee" };
const noIssues = { summary: { total: 0, urgent: 0, watch: 0 } };

function signIn(input: { globalRole: "SYSTEM_ADMIN" | null; permissions: readonly EventPermission[]; enabled: readonly EventModuleKey[]; dataNeeds?: readonly EventModuleKey[]; honorsData?: boolean; clubEvent?: boolean }) {
  mocks.resolveEventContext.mockResolvedValue({
    event,
    permissions: input.permissions,
    user: { id: "user-1", displayName: "Riley Staff", email: "riley@imsda-events.test", globalRole: input.globalRole },
  });
  mocks.resolveClubOversight.mockResolvedValue({ allowed: Boolean(input.clubEvent), clubEvent: Boolean(input.clubEvent) });
  mocks.resolveStaffViewer.mockResolvedValue(input.globalRole === "SYSTEM_ADMIN" ? { kind: "STAFF" } : null);
  const stored = new Set<EventModuleKey>(["public-content", ...input.enabled]);
  const dataForced = new Set<EventModuleKey>(input.dataNeeds ?? []);
  mocks.moduleState.mockResolvedValue({
    stored,
    effective: new Set<EventModuleKey>([...stored, ...dataForced]),
    dataPresent: new Set<EventModuleKey>([...dataForced, ...(input.honorsData ? ["honors" as const] : [])]),
    dataForced,
  });
}

async function render() {
  return renderToStaticMarkup(await MorePage({ searchParams: Promise.resolve({ event: event.id }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRecentAuditActivity.mockResolvedValue([]);
  mocks.getOperationalHealth.mockResolvedValue(noIssues);
  mocks.listModuleRequestsForEvent.mockResolvedValue([]);
});


function requestsFor(rows: Array<{ moduleKey: string; status: "PENDING" | "APPROVED" | "DECLINED"; declineReason?: string | null }>) {
  mocks.listModuleRequestsForEvent.mockResolvedValue(rows.map((row, index) => ({
    moduleKey: row.moduleKey,
    status: row.status,
    createdAt: new Date(Date.UTC(2026, 9, 1 + index)),
    decidedAt: row.status === "PENDING" ? null : new Date(Date.UTC(2026, 9, 2 + index)),
    declineReason: row.declineReason ?? null,
  })));
}

describe("Request a feature on /more", () => {
  it("shows an Event Admin every module that is off with its description and a why box", async () => {
    signIn({ globalRole: null, permissions: eventPermissions.filter((p) => p !== "VIEW_HEALTH_INFORMATION"), enabled: ["merchandise"] });
    const markup = await render();
    expect(markup).toContain('id="request-a-feature"');
    expect(markup).toContain(">Request a feature<");
    // Off and applicable on a general event: community and seminar assignments. Merchandise is on; club modules do not apply.
    expect(markup).toContain('data-request-module="attendee-community"');
    expect(markup).toContain("Open or pause discussion, review attendee reports, and moderate posts and replies.");
    expect(markup).toContain('data-request-module="seminar-assignments"');
    expect(markup).not.toContain('data-request-module="merchandise"');
    expect(markup).not.toContain('data-request-module="honors"');
    expect(markup).toContain("Why does this event need it?");
    expect(markup).toContain('maxLength="500"');
    expect(markup).toContain('aria-label="Request Attendee community"');
    // Still no switch for them.
    expect(markup).not.toContain("Enable ");
  });

  it("shows a pending request as waiting, with no form to ask again", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: [] });
    requestsFor([{ moduleKey: "attendee-community", status: "PENDING" }]);
    const markup = await render();
    expect(markup).toContain('data-status="PENDING"');
    expect(markup).toContain("Waiting for a system administrator");
    expect(markup).not.toContain('aria-label="Request Attendee community"');
    expect(markup).toContain('aria-label="Request Merchandise"');
  });

  it("shows a declined request with its reason and lets them ask again", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: [] });
    requestsFor([{ moduleKey: "attendee-community", status: "DECLINED", declineReason: "Use the event app instead." }]);
    const markup = await render();
    expect(markup).toContain('data-status="DECLINED"');
    expect(markup).toContain("Use the event app instead.");
    expect(markup).toContain("You can ask again.");
    expect(markup).toContain('aria-label="Request Attendee community"');
  });

  it("shows an approved request as approved and now on, with nothing to request", async () => {
    signIn({ globalRole: null, permissions: eventPermissions, enabled: ["attendee-community"] });
    requestsFor([{ moduleKey: "attendee-community", status: "APPROVED" }]);
    const markup = await render();
    expect(markup).toContain('data-status="APPROVED"');
    expect(markup).toContain("Attendee community: approved");
    expect(markup).not.toContain('data-request-module="attendee-community"');
    expect(markup).toContain('data-module="attendee-community"');
  });

  it("shows no request panel to a system administrator or to staff who are not Event Admins", async () => {
    signIn({ globalRole: "SYSTEM_ADMIN", permissions: eventPermissions, enabled: [] });
    expect(await render()).not.toContain('id="request-a-feature"');
    signIn({ globalRole: null, permissions: ["VIEW_EVENT", "MANAGE_FINANCE", "VIEW_REPORTS"], enabled: [] });
    const markup = await render();
    expect(markup).not.toContain('id="request-a-feature"');
    expect(mocks.listModuleRequestsForEvent).not.toHaveBeenCalled();
  });

  it("builds the panel from pure inputs: nothing for a viewer who cannot request", () => {
    const entries = buildRequestPanel({ effective: new Set<EventModuleKey>(["public-content"]), dataPresent: new Set(), audience: "CLUB", requests: [], canRequest: true });
    expect(entries.map((entry) => entry.definition.key)).toEqual(["honors", "event-patches", "club-assignments", "seminar-assignments", "merchandise", "attendee-community"]);
    expect(buildRequestPanel({ effective: new Set(), dataPresent: new Set(), audience: "CLUB", requests: [], canRequest: false })).toEqual([]);
  });
});

describe("the System management queue", () => {
  it("shows each pending request with Approve and Decline", () => {
    const markup = renderToStaticMarkup(createElement(ModuleRequestQueue, {
      requests: [{ id: "req-1", eventId: "event_1", eventName: "Synthetic Camporee", moduleTitle: "Merchandise", requesterName: "Eli EventAdmin", reason: "We sell shirts.", createdLabel: "Oct 3, 2026" }],
    }));
    expect(markup).toContain("Merchandise");
    expect(markup).toContain("Synthetic Camporee");
    expect(markup).toContain("We sell shirts.");
    expect(markup).toContain('aria-label="Approve Merchandise for Synthetic Camporee"');
    expect(markup).toContain('aria-label="Decline Merchandise for Synthetic Camporee"');
  });
});
