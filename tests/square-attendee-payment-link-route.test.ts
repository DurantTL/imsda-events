import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockSquarePaymentOperationError extends Error {
    constructor(public readonly code: string, message: string, public readonly retryable = false) {
      super(message);
    }
  }
  return {
    getCurrentAttendee: vi.fn(),
    pending: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    authorize: vi.fn(),
    rateLimit: vi.fn(),
    createLink: vi.fn(),
    SquarePaymentOperationError: MockSquarePaymentOperationError,
  };
});

vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ attendeeSecondStepPending: mocks.pending }));
vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({ authorizeAttendeeRegistration: mocks.authorize }));
vi.mock("@/modules/payments/square-hosted-repository", () => ({ createAttendeeSquarePaymentLink: mocks.createLink }));
vi.mock("@/modules/payments/square-repository", () => ({ SquarePaymentOperationError: mocks.SquarePaymentOperationError }));
vi.mock("@/modules/rate-limit/service", () => ({ checkPublicPaymentRateLimit: mocks.rateLimit }));

import { POST } from "@/app/api/attendee/registrations/[registrationId]/payment-link/route";

type Handler = (request: Request, context: unknown) => Promise<Response>;
const post = POST as unknown as Handler;
const context = { params: Promise.resolve({ registrationId: "registration-1" }) };
const body = { idempotencyKey: "d67776d0-f79d-4e8f-bec2-ee61abb7337c", returnId: "R".repeat(43) };

function request(payload: unknown) {
  return new Request("https://events.imsda.test/api/attendee/registrations/registration-1/payment-link", {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.pending.mockResolvedValue(false);
  mocks.getCurrentAttendee.mockResolvedValue({
    account: { id: "account-1", verifiedEmail: "guest@example.test", displayName: "Guest" },
    via: "attendee",
    sessionId: "session-1",
  });
  mocks.authorize.mockResolvedValue({ registrationId: "registration-1", eventId: "event-1" });
  mocks.rateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.createLink.mockResolvedValue({ url: "https://sandbox.square.link/u/synthetic" });
});

describe("attendee Pay on Square link route (#327)", () => {
  it("creates the link for the registration's own account", async () => {
    const response = await post(request(body), context);
    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith("guest@example.test", "registration-1");
    expect(mocks.createLink).toHaveBeenCalledWith({ registrationId: "registration-1", eventId: "event-1" }, body);
  });

  it("answers 404 for a registration the account does not own, and does nothing", async () => {
    mocks.authorize.mockResolvedValue(null);
    const response = await post(request(body), context);
    expect(response.status).toBe(404);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createLink).not.toHaveBeenCalled();
  });

  it("requires the second sign-in step before anything else", async () => {
    mocks.pending.mockResolvedValue(true);
    const response = await post(request(body), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "SECOND_STEP_REQUIRED" });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.createLink).not.toHaveBeenCalled();
  });

  it("answers 404 when nobody is signed in, or staff are acting as an attendee", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    expect((await post(request(body), context)).status).toBe(404);
    mocks.getCurrentAttendee.mockResolvedValue({
      account: { id: "account-1", verifiedEmail: "guest@example.test", displayName: "Guest" },
      via: "staff",
      sessionId: null,
    });
    expect((await post(request(body), context)).status).toBe(404);
    expect(mocks.createLink).not.toHaveBeenCalled();
  });

  it("answers 400 for invalid JSON or a body that is not a request key and a return id", async () => {
    expect((await post(request("{not json"), context)).status).toBe(400);
    expect((await post(request({ idempotencyKey: body.idempotencyKey }), context)).status).toBe(400);
    expect((await post(request({ ...body, amountCents: 1 }), context)).status).toBe(400);
    expect(mocks.createLink).not.toHaveBeenCalled();
  });
});
