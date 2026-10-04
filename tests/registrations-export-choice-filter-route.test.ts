import { beforeEach, describe, expect, it, vi } from "vitest";
import { formTemplates } from "@/modules/forms/definition";

const dependencies = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listRegistrations: vi.fn(),
}));

vi.mock("@/modules/access/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/access/authorization")>();
  return { ...actual, requirePermission: dependencies.requirePermission };
});
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: vi.fn(async () => ({ user: { id: "user_one" } })) }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: vi.fn() }));
vi.mock("@/modules/event-locations/filter", () => ({
  resolveLocationFilter: vi.fn(async () => ({ locations: [], locationId: null, selected: null })),
  locationParam: () => null,
}));
vi.mock("@/modules/registrations/repository", () => ({ listRegistrations: dependencies.listRegistrations }));
vi.mock("@/modules/notes/repository", () => ({ listNotesForRegistration: vi.fn(async () => []) }));

import { GET } from "@/app/api/events/[eventId]/exports/registrations/route";

const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;

function registration(id: string, meal: string, status = "CONFIRMED") {
  return {
    id,
    confirmationCode: `WR26-${id}`,
    status,
    accountHolder: { id: `p-${id}`, firstName: "Holder", lastName: id, email: `${id}@example.test`, phone: "" },
    attendees: [{ id: `at-${id}`, firstName: "Guest", lastName: id, email: "", phone: "", responses: { meal_preference: meal, dietary_needs: "synthetic note" } }],
    publicSubmission: { definition, responses: {}, attendeeResponses: [] },
  };
}

function call(search: string) {
  return GET(new Request(`http://localhost/api/events/evt/exports/registrations${search}`), { params: Promise.resolve({ eventId: "evt" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.requirePermission.mockResolvedValue({ user: { globalRole: "SYSTEM_ADMIN" }, membership: null });
  dependencies.listRegistrations.mockResolvedValue([registration("X1", "Vegan"), registration("X2", "Standard"), registration("X3", "Vegan")]);
});

describe("registrations export with a choice-answer filter", () => {
  it("keeps the same permission check as the unfiltered export", async () => {
    await call("?answerQuestion=ATTENDEE:meal_preference&answerValue=Vegan");
    expect(dependencies.requirePermission).toHaveBeenCalledWith(expect.anything(), "evt", "VIEW_REPORTS", expect.anything());
  });

  it("exports only the people with that answer", async () => {
    const response = await call("?answerQuestion=ATTENDEE:meal_preference&answerValue=Vegan");
    expect(response.status).toBe(200);
    const lines = (await response.text()).trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"WR26-X1"');
    expect(lines[2]).toContain('"WR26-X3"');
    expect(lines.join("\n")).not.toContain("synthetic note");
  });

  it("refuses to export by a free-text or sensitive question", async () => {
    const response = await call("?answerQuestion=ATTENDEE:dietary_needs&answerValue=synthetic%20note");
    expect(response.status).toBe(400);
  });

  it("exports the other bucket without ever writing the stored text", async () => {
    dependencies.listRegistrations.mockResolvedValue([registration("X1", "synthetic secret text"), registration("X2", "Vegan")]);
    const response = await call("?answerQuestion=ATTENDEE:meal_preference&answerValue=__other");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.trim().split("\r\n")).toHaveLength(2);
    expect(text).toContain('"WR26-X1"');
    expect(text).toContain("Other / no longer offered");
    expect(text).not.toContain("synthetic secret text");
  });

  it("refuses the other bucket without VIEW_SENSITIVE_DATA", async () => {
    dependencies.requirePermission.mockResolvedValue({ user: { globalRole: null }, membership: { role: "READ_ONLY_STAFF", permissions: ["VIEW_REPORTS"] } });
    const response = await call("?answerQuestion=ATTENDEE:meal_preference&answerValue=__other");
    expect(response.status).toBe(403);
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
  });

  it("without a filter still returns the general export", async () => {
    const response = await call("");
    expect((await response.text()).split("\r\n")[0]).toContain("Account holder");
  });

  it("refuses a user who can view reports but not sensitive data, without reading registrations", async () => {
    dependencies.requirePermission.mockResolvedValue({ user: { globalRole: null }, membership: { role: "READ_ONLY_STAFF", permissions: ["VIEW_REPORTS"] } });
    const response = await call("?answerQuestion=ATTENDEE:meal_preference&answerValue=Vegan");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("WR26-");
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
  });

  it("still lets that user take the general export, whose permission is unchanged", async () => {
    dependencies.requirePermission.mockResolvedValue({ user: { globalRole: null }, membership: { role: "READ_ONLY_STAFF", permissions: ["VIEW_REPORTS"] } });
    expect((await call("")).status).toBe(200);
  });

  it("refuses a legacy question that is not offered by default (is_minor), even for a full-access user", async () => {
    const manCamp = formTemplates.find((template) => template.key === "man_camp_export")!.definition;
    dependencies.listRegistrations.mockResolvedValue([{ ...registration("M1", "x"), publicSubmission: { definition: manCamp, responses: {}, attendeeResponses: [] } }]);
    expect((await call("?answerQuestion=ATTENDEE:is_minor&answerValue=Yes")).status).toBe(400);
  });
});
