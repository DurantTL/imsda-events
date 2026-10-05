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
vi.mock("@/modules/registrations/repository", () => ({ listRegistrations: dependencies.listRegistrations }));

import { GET } from "@/app/api/events/[eventId]/exports/attendees/route";

const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;

function registration(id: string, meal: string, status = "CONFIRMED") {
  return {
    id,
    confirmationCode: `WR26-${id}`,
    status,
    accountHolder: { id: `p-${id}`, firstName: "Holder", lastName: id, email: `${id}@example.test`, phone: "" },
    attendees: [{ id: `at-${id}`, firstName: "Guest", lastName: id, email: "", phone: "", attendeeType: "Adult", responses: { meal_preference: meal, dietary_needs: "synthetic note" } }],
    publicSubmission: { definition, responses: {}, attendeeResponses: [] },
  };
}

/** `Response.text()` drops a leading BOM, so read the raw bytes and decode without stripping it. */
async function rawBody(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bom: [...bytes.slice(0, 3)], text: new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes.slice(3)) };
}

function call(search = "") {
  return GET(new Request(`http://localhost/api/events/evt/exports/attendees${search}`), { params: Promise.resolve({ eventId: "evt" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.requirePermission.mockResolvedValue({ user: { globalRole: "SYSTEM_ADMIN" }, membership: null });
  dependencies.listRegistrations.mockResolvedValue([registration("X1", "Vegan"), registration("X2", "Standard"), registration("X3", "Vegan", "CANCELLED")]);
});

describe("attendees export route", () => {
  it("requires the registrations export permission", async () => {
    await call();
    expect(dependencies.requirePermission).toHaveBeenCalledWith(expect.anything(), "evt", "VIEW_REPORTS", expect.anything());
  });

  it("refuses without VIEW_SENSITIVE_DATA before reading anything", async () => {
    dependencies.requirePermission.mockResolvedValue({ user: { globalRole: null }, membership: { role: "READ_ONLY_STAFF", permissions: ["VIEW_REPORTS"] } });
    const response = await call();
    expect(response.status).toBe(403);
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
  });

  it("returns the permission error from requirePermission", async () => {
    const { AccessDeniedError } = await import("@/modules/access/authorization");
    dependencies.requirePermission.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await call()).status).toBe(403);
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
  });

  it("exports a BOM-prefixed CSV of confirmed attendees by default", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(dependencies.listRegistrations).toHaveBeenCalledWith("evt", { statuses: ["CONFIRMED"] });
    const { bom, text } = await rawBody(response);
    expect(bom).toEqual([0xef, 0xbb, 0xbf]);
    // The mocked repository returns a cancelled row too; the default filter drops it.
    expect(text.trim().split("\r\n")).toHaveLength(3);
    expect(text).not.toContain("WR26-X3");
  });

  it("honours the active filters", async () => {
    const response = await call("?meal=vegan&statuses=CONFIRMED,CANCELLED");
    const lines = (await rawBody(response)).text.trim().split("\r\n");
    expect(dependencies.listRegistrations).toHaveBeenCalledWith("evt", { statuses: ["CONFIRMED", "CANCELLED"] });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"WR26-X1"');
    expect(lines[2]).toContain('"WR26-X3"');
  });
});
