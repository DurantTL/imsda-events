import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formTemplates } from "@/modules/forms/definition";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  resolveEventContext: vi.fn(),
  listRegistrations: vi.fn(),
  areaGrantFindUnique: vi.fn(),
  eventFindUnique: vi.fn(),
  getCurrentAttendee: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  currentStaffActingContext: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ areaCoordinatorGrant: { findUnique: mocks.areaGrantFindUnique }, event: { findUnique: mocks.eventFindUnique } }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/access/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/access/authorization")>();
  return { ...actual, requirePermission: mocks.requirePermission };
});
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: vi.fn(async () => ({ user: { id: "user_one" } })) }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: vi.fn() }));
vi.mock("@/modules/events/selection", () => ({ resolveEventContext: mocks.resolveEventContext }));
vi.mock("@/modules/registrations/repository", () => ({ listRegistrations: mocks.listRegistrations }));

import { AccessDeniedError } from "@/modules/access/authorization";
import { GET as staffCsv } from "@/app/api/events/[eventId]/exports/kitchen/route";
import { GET as areaCsv } from "@/app/api/attendee/area-clubs/kitchen/[eventId]/route";
import StaffPage from "@/app/(workspace)/more/kitchen-report/page";
import AreaPage from "@/app/(public)/account/(portal)/area-clubs/kitchen/[eventId]/page";

const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;
const synthetic = {
  id: "r1", confirmationCode: "SYNTH-R1", status: "CONFIRMED",
  accountHolder: { id: "p1", firstName: "Holder", lastName: "Surname", email: "holder@example.test", phone: "" },
  attendees: [{ id: "a1", firstName: "Guest", lastName: "Family", email: "", phone: "", attendeeType: "Adult", responses: { meal_preference: "Vegan", dietary_needs: "Peanut allergy" } }],
  publicSubmission: { definition, responses: {}, attendeeResponses: [] },
};
const params = { params: Promise.resolve({ eventId: "evt" }) };
const request = new Request("http://localhost/x");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRegistrations.mockResolvedValue([synthetic]);
  mocks.requirePermission.mockResolvedValue({ user: { globalRole: null }, membership: { role: "READ_ONLY_STAFF", permissions: ["VIEW_REPORTS"] } });
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" }, via: "attendee", sessionId: "s1" });
  mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: null });
  mocks.accountNeedsSecondStep.mockResolvedValue("OK");
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.eventFindUnique.mockResolvedValue({ name: "Synthetic Camporee", audience: "CLUB", isPublished: true });
});

describe("kitchen report: conference staff", () => {
  it("asks for VIEW_REPORTS only, and returns anonymous CSV", async () => {
    const response = await staffCsv(request, params);
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "evt", "VIEW_REPORTS", expect.anything());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Peanut allergy");
    expect(text).not.toMatch(/SYNTH-|Surname|Family|example\.test/);
  });

  it("is refused for a role without VIEW_REPORTS, before reading registrations", async () => {
    mocks.requirePermission.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await staffCsv(request, params)).status).toBe(403);
    expect(mocks.listRegistrations).not.toHaveBeenCalled();
  });

  it("page renders for VIEW_REPORTS without sensitive or health access, with no personal data", async () => {
    mocks.resolveEventContext.mockResolvedValue({ event: { id: "evt", name: "Synthetic Retreat" }, permissions: ["VIEW_REPORTS"] });
    const html = renderToStaticMarkup(await StaffPage({ searchParams: Promise.resolve({ event: "evt" }) }));
    expect(html).toContain("Peanut allergy");
    expect(html).toContain("Download CSV");
    expect(html).not.toMatch(/SYNTH-|Surname|Family|example\.test/);
  });

  it("page is restricted without VIEW_REPORTS and reads nothing", async () => {
    mocks.resolveEventContext.mockResolvedValue({ event: { id: "evt", name: "Synthetic Retreat" }, permissions: ["VIEW_EVENT", "VIEW_SENSITIVE_DATA"] });
    const html = renderToStaticMarkup(await StaffPage({ searchParams: Promise.resolve({ event: "evt" }) }));
    expect(html).toContain("restricted");
    expect(html).not.toContain("Peanut allergy");
    expect(mocks.listRegistrations).not.toHaveBeenCalled();
  });
});

describe("kitchen report: Area Coordinator path", () => {
  it("page and CSV work for an active coordinator on a club event", async () => {
    const html = renderToStaticMarkup(await AreaPage(params));
    expect(html).toContain("Synthetic Camporee");
    expect(html).toContain("Peanut allergy");
    expect(html).not.toMatch(/SYNTH-|Surname|Family|example\.test/);
    const response = await areaCsv(request, params);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Peanut allergy");
  });

  it("works for a system administrator acting as an Area Coordinator", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    mocks.currentStaffActingContext.mockResolvedValue({ role: "AREA_COORDINATOR" });
    expect((await areaCsv(request, params)).status).toBe(200);
  });

  it.each([
    ["a non-coordinator (attendee or club director)", () => mocks.areaGrantFindUnique.mockResolvedValue(null)],
    ["a revoked grant", () => mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: new Date("2026-01-01"), expiresAt: null })],
    ["a pending second step", () => mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY")],
    ["a signed-out visitor", () => mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null })],
    ["staff acting as a club director", () => {
      mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
      mocks.currentStaffActingContext.mockResolvedValue({ role: "CLUB_DIRECTOR" });
    }],
  ])("is not found for %s, reading no registrations", async (_label, arrange) => {
    arrange();
    await expect(AreaPage(params)).rejects.toThrow("NOT_FOUND");
    expect((await areaCsv(request, params)).status).toBe(404);
    expect(mocks.listRegistrations).not.toHaveBeenCalled();
  });

  it.each([
    ["a conference event", { name: "Synthetic Retreat", audience: "PUBLIC", isPublished: true }],
    ["an unpublished club event", { name: "Synthetic Camporee", audience: "CLUB", isPublished: false }],
    ["an unknown event", null],
  ])("is not found for %s even for a coordinator", async (_label, event) => {
    mocks.eventFindUnique.mockResolvedValue(event);
    await expect(AreaPage(params)).rejects.toThrow("NOT_FOUND");
    expect((await areaCsv(request, params)).status).toBe(404);
    expect(mocks.listRegistrations).not.toHaveBeenCalled();
  });

  it("reads a real club-event form template (Spring Camporee) on the coordinator path", async () => {
    const clubDefinition = formTemplates.find((template) => template.key === "spring_camporee_export")!.definition;
    mocks.listRegistrations.mockResolvedValue([{
      ...synthetic,
      attendees: [
        { ...synthetic.attendees[0], responses: { dietary_needs: "Gluten free" } },
        { ...synthetic.attendees[0], id: "a2", responses: { dietary_needs: "gluten  FREE" } },
        { ...synthetic.attendees[0], id: "a3", responses: { dietary_needs: "None" } },
      ],
      publicSubmission: { definition: clubDefinition, responses: {}, attendeeResponses: [] },
    }]);
    const response = await areaCsv(request, params);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"Gluten free","2"');
    expect(text).toContain('"People with any dietary need","2"');
    expect(text).not.toMatch(/SYNTH-|Surname|Family|example\.test/);
  });
});
