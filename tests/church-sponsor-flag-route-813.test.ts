import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentSession: vi.fn(),
  clearChurchSponsorFlag: vi.fn(),
}));

vi.mock("@/modules/access/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/access/authorization")>();
  return { ...actual, requirePermission: dependencies.requirePermission };
});
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: dependencies.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: vi.fn() }));
vi.mock("@/modules/promo-codes/church-sponsor-lodging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/promo-codes/church-sponsor-lodging")>();
  return { ...actual, clearChurchSponsorFlag: dependencies.clearChurchSponsorFlag };
});
vi.mock("server-only", () => ({}));

import { AccessDeniedError } from "@/modules/access/authorization";
import { ChurchSponsorFlagError } from "@/modules/promo-codes/church-sponsor-lodging";
import { POST } from "@/app/api/events/[eventId]/church-sponsor-flags/[flagId]/route";

const context = { params: Promise.resolve({ eventId: "event_1", flagId: "flag_1" }) };
const post = (body: unknown, origin = "https://events.example.test") => new Request("https://events.example.test/api/events/event_1/church-sponsor-flags/flag_1", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Host: "events.example.test" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.requirePermission.mockResolvedValue({ user: { id: "user_1" }, membership: {} });
});

describe("POST /api/events/[eventId]/church-sponsor-flags/[flagId] (#813)", () => {
  it("needs MANAGE_FINANCE on the event in the URL, and clears the flag with the note", async () => {
    dependencies.clearChurchSponsorFlag.mockResolvedValue({ id: "flag_1" });
    const response = await POST(post({ note: "Handled" }), context);
    expect(response.status).toBe(200);
    expect(dependencies.requirePermission.mock.calls[0]![2]).toBe("MANAGE_FINANCE");
    expect(dependencies.requirePermission.mock.calls[0]![1]).toBe("event_1");
    expect(dependencies.clearChurchSponsorFlag).toHaveBeenCalledWith({ eventId: "event_1", flagId: "flag_1", actorUserId: "user_1", note: "Handled" });
  });

  it("refuses a user without the permission and clears nothing", async () => {
    dependencies.requirePermission.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    const response = await POST(post({}), context);
    expect(response.status).toBe(403);
    expect(dependencies.clearChurchSponsorFlag).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request before any permission check", async () => {
    const response = await POST(post({}, "https://evil.example.test"), context);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(dependencies.requirePermission).not.toHaveBeenCalled();
    expect(dependencies.clearChurchSponsorFlag).not.toHaveBeenCalled();
  });

  it("says not found for an unknown flag, conflict for a flag already cleared, and invalid for a long note", async () => {
    dependencies.clearChurchSponsorFlag.mockRejectedValueOnce(new ChurchSponsorFlagError("gone", "FLAG_NOT_FOUND"));
    expect((await POST(post({}), context)).status).toBe(404);
    dependencies.clearChurchSponsorFlag.mockRejectedValueOnce(new ChurchSponsorFlagError("again", "ALREADY_CLEARED"));
    expect((await POST(post({}), context)).status).toBe(409);
    expect((await POST(post({ note: "x".repeat(301) }), context)).status).toBe(400);
  });
});
