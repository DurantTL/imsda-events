import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  checkPublicRegistrationRateLimit: vi.fn(),
  checkPublicManageRateLimit: vi.fn(),
  getGroupRegistrationExperience: vi.fn(),
  submitGroupRegistration: vi.fn(),
  getGroupRegistrationWorkspace: vi.fn(),
  amendGroupRegistration: vi.fn(),
  setGroupClassesByToken: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicRegistrationRateLimit: mocks.checkPublicRegistrationRateLimit,
  checkPublicManageRateLimit: mocks.checkPublicManageRateLimit,
}));
vi.mock("@/modules/communications/messaging-repository", () => ({ processQueuedMessageIdsAfterCommit: mocks.processQueuedMessageIdsAfterCommit }));
vi.mock("@/modules/group-registrations/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/group-registrations/repository")>("@/modules/group-registrations/repository");
  return {
    ...actual,
    getGroupRegistrationExperience: mocks.getGroupRegistrationExperience,
    submitGroupRegistration: mocks.submitGroupRegistration,
    getGroupRegistrationWorkspace: mocks.getGroupRegistrationWorkspace,
    amendGroupRegistration: mocks.amendGroupRegistration,
    setGroupClassesByToken: mocks.setGroupClassesByToken,
  };
});

import { GET as publicGet, POST as publicPost } from "@/app/api/public/events/[eventSlug]/group-registrations/route";
import { GET as manageGet, PATCH as managePatch } from "@/app/api/public/manage/[token]/group/route";
import { PUT as classesPut } from "@/app/api/public/manage/[token]/group/classes/route";
import { GroupRegistrationError } from "@/modules/group-registrations/repository";
import { PublicRegistrationError } from "@/modules/forms/public-repository";
import { ClassSelectionError } from "@/modules/honors/enrollment-repository";
import { RegistrationAmendmentError } from "@/modules/registrations/amendments-repository";
import { EventLocationError } from "@/modules/event-locations/errors";

const allowed = { allowed: true, decisions: [] };
const eventCtx = { params: Promise.resolve({ eventSlug: "honors-weekend" }) };
const tokenCtx = { params: Promise.resolve({ token: "synthetic-token" }) };
const post = (body: unknown, method = "POST") => new Request("https://events.imsda.test/api/x", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const submission = {
  versionId: "v1",
  idempotencyKey: "5b1f6f3e-7f3a-4c3e-9a6a-0a3a4d5e6f71",
  responses: { email: "contact@example.test" },
  attendees: [{ clientId: "p1", responses: { first_name: "Alex", attendee_age: "12" } }],
  website: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkPublicRegistrationRateLimit.mockResolvedValue(allowed);
  mocks.checkPublicManageRateLimit.mockResolvedValue(allowed);
  mocks.processQueuedMessageIdsAfterCommit.mockResolvedValue({});
});

describe("public group registration route (#650)", () => {
  it("serves the group page data with no caching", async () => {
    mocks.getGroupRegistrationExperience.mockResolvedValue({ problem: null });
    const response = await publicGet(new Request("https://events.imsda.test/api/x"), eventCtx);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getGroupRegistrationExperience).toHaveBeenCalledWith("honors-weekend");
  });

  it("submits a group with its location and class picks beside the answers", async () => {
    mocks.submitGroupRegistration.mockResolvedValue({ confirmation: { confirmationCode: "REG-1" }, honors: { saved: 1 } });
    const response = await publicPost(post({ ...submission, locationId: "loc-1", honorSelections: { p1: ["off-1"] } }), eventCtx);
    expect(response.status).toBe(201);
    expect(mocks.submitGroupRegistration).toHaveBeenCalledWith(
      "honors-weekend",
      expect.objectContaining({ versionId: "v1", idempotencyKey: "5b1f6f3e-7f3a-4c3e-9a6a-0a3a4d5e6f71" }),
      { locationId: "loc-1", honorSelections: { p1: ["off-1"] } },
    );
    // The location and picks are not form answers.
    expect(mocks.submitGroupRegistration.mock.calls[0]![1]).not.toHaveProperty("locationId");
    await expect(response.json()).resolves.toMatchObject({ confirmation: { confirmationCode: "REG-1" }, honors: { saved: 1 } });
  });

  it("is rate limited on its own key, same-origin only, and size capped", async () => {
    await publicPost(post(submission), eventCtx);
    expect(mocks.checkPublicRegistrationRateLimit).toHaveBeenCalledWith(expect.any(Request), "honors-weekend", "group");

    mocks.checkPublicRegistrationRateLimit.mockResolvedValueOnce({ allowed: false, decisions: [] });
    expect((await publicPost(post(submission), eventCtx)).status).toBe(429);

    mocks.rejectCrossOriginRequest.mockReturnValueOnce(Response.json({}, { status: 403 }));
    expect((await publicPost(post(submission), eventCtx)).status).toBe(403);

    mocks.submitGroupRegistration.mockClear();
    const huge = await publicPost(post(JSON.stringify({ ...submission, padding: "x".repeat(600 * 1024) })), eventCtx);
    expect(huge.status).toBe(413);
    expect(mocks.submitGroupRegistration).not.toHaveBeenCalled();
  });

  it("refuses bad JSON and a malformed submission before touching the database", async () => {
    expect((await publicPost(post("{not json"), eventCtx)).status).toBe(400);
    expect((await publicPost(post({ versionId: "v1" }), eventCtx)).status).toBe(400);
    expect(mocks.submitGroupRegistration).not.toHaveBeenCalled();
  });

  it("maps the server's refusals to clear statuses", async () => {
    const cases: Array<[Error, number, string]> = [
      [new GroupRegistrationError("EVENT_NOT_FOUND", "No."), 404, "EVENT_NOT_FOUND"],
      [new PublicRegistrationError("GROUP_ATTENDEES_INVALID", "Enter an age."), 422, "GROUP_ATTENDEES_INVALID"],
      [new PublicRegistrationError("INVALID_SUBMISSION", "Review.", []), 422, "INVALID_SUBMISSION"],
      [new PublicRegistrationError("REGISTRATION_CLOSED", "Closed."), 410, "REGISTRATION_CLOSED"],
      [new PublicRegistrationError("EVENT_FULL", "Full."), 409, "EVENT_FULL"],
      [new EventLocationError("LOCATION_FULL", "Full."), 409, "LOCATION_FULL"],
      [new EventLocationError("LOCATION_REQUIRED", "Pick."), 422, "LOCATION_REQUIRED"],
    ];
    for (const [error, status, code] of cases) {
      mocks.submitGroupRegistration.mockRejectedValueOnce(error);
      const response = await publicPost(post(submission), eventCtx);
      expect(response.status, code).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: code });
    }
  });

  it("never leaks an unexpected error", async () => {
    mocks.submitGroupRegistration.mockRejectedValueOnce(new Error("connection string postgres://secret"));
    const response = await publicPost(post(submission), eventCtx);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("postgres://secret");
    expect(text).toContain("Nothing was submitted");
  });
});

describe("private group manage routes (#650)", () => {
  it("returns the contact's workspace for a valid link, privately, and 404 for any other", async () => {
    mocks.getGroupRegistrationWorkspace.mockResolvedValueOnce({ registration: { confirmationCode: "REG-1" } });
    const found = await manageGet(new Request("https://events.imsda.test/api/x"), tokenCtx);
    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toContain("no-store");
    expect(found.headers.get("x-robots-tag")).toContain("noindex");
    expect(mocks.getGroupRegistrationWorkspace).toHaveBeenCalledWith("synthetic-token");

    mocks.getGroupRegistrationWorkspace.mockResolvedValueOnce(null);
    const missing = await manageGet(new Request("https://events.imsda.test/api/x"), tokenCtx);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "REGISTRATION_ACCESS_UNAVAILABLE" });
  });

  it("rate limits a link per operation", async () => {
    mocks.checkPublicManageRateLimit.mockResolvedValueOnce({ allowed: false, decisions: [] });
    expect((await manageGet(new Request("https://events.imsda.test/api/x"), tokenCtx)).status).toBe(429);
    expect(mocks.checkPublicManageRateLimit).toHaveBeenCalledWith(expect.any(Request), "synthetic-token", "read");
    await managePatch(post({}, "PATCH"), tokenCtx);
    expect(mocks.checkPublicManageRateLimit).toHaveBeenCalledWith(expect.any(Request), "synthetic-token", "update");
  });

  const edit = {
    clientRequestId: "0b1f6f3e-7f3a-4c3e-9a6a-0a3a4d5e6f70",
    expectedUpdatedAt: "2026-10-15T15:00:00.000Z",
    attendees: [{ attendeeId: "att-1", responses: { attendee_age: "13" } }],
  };

  it("amends through the link and sends the queued notices after the save", async () => {
    mocks.amendGroupRegistration.mockResolvedValue({ result: { attendeeCount: 1 }, pendingMessageIds: ["m1"] });
    const response = await managePatch(post(edit, "PATCH"), tokenCtx);
    expect(response.status).toBe(200);
    expect(mocks.amendGroupRegistration).toHaveBeenCalledWith("synthetic-token", expect.objectContaining({ clientRequestId: edit.clientRequestId }));
    expect(mocks.processQueuedMessageIdsAfterCommit).toHaveBeenCalledWith(["m1"]);
    await expect(response.json()).resolves.toEqual({ attendeeCount: 1 });
  });

  it("is same-origin only, refuses unknown fields (no club or church can be named), and caps the size", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(Response.json({}, { status: 403 }));
    expect((await managePatch(post(edit, "PATCH"), tokenCtx)).status).toBe(403);
    expect((await managePatch(post({ ...edit, organizationId: "club-1" }, "PATCH"), tokenCtx)).status).toBe(400);
    expect((await managePatch(post({ ...edit, padding: "x".repeat(300 * 1024) }, "PATCH"), tokenCtx)).status).toBe(413);
    expect(mocks.amendGroupRegistration).not.toHaveBeenCalled();
  });

  it("words the amendment engine's refusals for a group contact, never staff wording", async () => {
    mocks.amendGroupRegistration.mockRejectedValueOnce(new RegistrationAmendmentError("PAYMENT_ADJUSTMENT_REQUIRED", "Record the required refund in Finance.", [], { paidCents: 100 }));
    const payment = await managePatch(post(edit, "PATCH"), tokenCtx);
    const body = await payment.json() as { message: string };
    expect(payment.status).toBe(409);
    expect(body.message).not.toMatch(/finance|church|director|refund/i);

    mocks.amendGroupRegistration.mockRejectedValueOnce(new RegistrationAmendmentError("ATTENDEE_IDENTITY_CHANGED", "Use Substitute.", [], { attendeeName: "Alex Sample" }));
    const identity = await managePatch(post(edit, "PATCH"), tokenCtx);
    expect(identity.status).toBe(422);
    expect(((await identity.json()) as { message: string }).message).not.toMatch(/substitute/i);

    mocks.amendGroupRegistration.mockRejectedValueOnce(new GroupRegistrationError("REGISTRATION_CLOSED", "Registration closed after November 30, 2026."));
    const closed = await managePatch(post(edit, "PATCH"), tokenCtx);
    expect(closed.status).toBe(410);

    mocks.amendGroupRegistration.mockRejectedValueOnce(new GroupRegistrationError("CLASS_PICKS_CONFLICT", "Alex is too young for Birds. Remove that class first."));
    expect((await managePatch(post(edit, "PATCH"), tokenCtx)).status).toBe(409);

    mocks.amendGroupRegistration.mockRejectedValueOnce(new RegistrationAmendmentError("INVALID_AMENDMENT", "Review", [
      { kind: "validation", code: "REQUIRED", fieldId: null, key: "attendee_age", path: "attendees.0.responses.attendee_age", attendeeIndex: 0, message: "Age is required.", clientId: "p1" } as never,
    ]));
    const invalid = await managePatch(post(edit, "PATCH"), tokenCtx);
    expect(((await invalid.json()) as { issues: unknown[] }).issues).toEqual([{ key: "attendee_age", message: "Age is required.", clientId: "p1" }]);
  });

  it("saves class picks through the link, with the same rules as every other save", async () => {
    mocks.setGroupClassesByToken.mockResolvedValue({ selections: {} });
    const saved = await classesPut(post({ selections: { "att-1": ["off-1"] } }, "PUT"), tokenCtx);
    expect(saved.status).toBe(200);
    expect(mocks.setGroupClassesByToken).toHaveBeenCalledWith("synthetic-token", { "att-1": ["off-1"] });

    for (const [code, status] of [["CLASS_FULL", 409], ["CLUB_LIMIT_REACHED", 409], ["SELECTION_INVALID", 422], ["DEADLINE_PASSED", 410], ["NOT_REGISTERED", 404]] as const) {
      mocks.setGroupClassesByToken.mockRejectedValueOnce(new ClassSelectionError(code, "No."));
      const response = await classesPut(post({ selections: {} }, "PUT"), tokenCtx);
      expect(response.status, code).toBe(status);
    }
    expect((await classesPut(post({ selections: {}, extra: 1 }, "PUT"), tokenCtx)).status).toBe(400);
  });
});
