import { beforeEach, describe, expect, it, vi } from "vitest";

// #744: the QR pass, registration contact, payment and payment-choice routes
// use the shared second-step gate. Only the gate's own lookup is faked.
const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  pending: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  createAccountAttendeePass: vi.fn(),
  qrToString: vi.fn(),
  updateContact: vi.fn(),
  authorize: vi.fn(),
  getCheckout: vi.fn(),
  createPayment: vi.fn(),
  rateLimit: vi.fn(),
  choosePayment: vi.fn(),
  bodyRead: vi.fn(),
}));

vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("qrcode", () => ({ default: { toString: mocks.qrToString } }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ attendeeSecondStepPending: mocks.pending }));
vi.mock("@/modules/checkin/attendee-pass-repository", () => ({ createAccountAttendeePass: mocks.createAccountAttendeePass }));
vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({
  authorizeAttendeeRegistration: mocks.authorize,
  updateAttendeeRegistrationContact: mocks.updateContact,
}));
vi.mock("@/modules/payments/square-repository", () => ({
  createAttendeeSquarePayment: mocks.createPayment,
  getAttendeeSquareCheckout: mocks.getCheckout,
  SquarePaymentOperationError: class extends Error {},
}));
vi.mock("@/modules/rate-limit/service", () => ({ checkPublicPaymentRateLimit: mocks.rateLimit }));
vi.mock("@/modules/payments/payment-choice-repository", () => ({
  chooseAttendeePromotedWaitlistPayment: mocks.choosePayment,
  PaymentChoiceOperationError: class extends Error {},
}));

import { GET as QR_GET } from "@/app/api/attendee/registrations/[registrationId]/attendee-passes/[attendeeId]/qr/route";
import { PATCH as CONTACT_PATCH } from "@/app/api/attendee/registrations/[registrationId]/route";
import { GET as PAYMENT_GET, POST as PAYMENT_POST } from "@/app/api/attendee/registrations/[registrationId]/payment/route";
import { POST as CHOICE_POST } from "@/app/api/attendee/registrations/[registrationId]/payment-choice/route";

type Handler = (request: Request, context: unknown) => Promise<Response>;
const base = "https://events.imsda.test/api/attendee/registrations/registration-1";
const context = {
  params: Promise.resolve({ registrationId: "registration-1", attendeeId: "attendee-1" }),
};
const send = (path: string, method: string, body: unknown) =>
  new Request(`${base}${path}`, {
    method,
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
// A request whose body must never be read when the gate refuses.
function watched(path: string, method: string) {
  const request = send(path, method, {});
  request.json = async () => {
    mocks.bodyRead();
    return {};
  };
  return request;
}

const contactBody = {
  code: "123456",
  contact: { firstName: "Avery", lastName: "Person", email: "avery@example.test", phone: "555-0100" },
};
const choiceBody = {
  choice: "CARD",
  clientRequestId: "19af978c-b75a-4860-9df5-e9110dc2671e",
  expectedPriorOperationId: null,
};
const paymentBody = { sourceId: "cnon:synthetic", idempotencyKey: "19af978c-b75a-4860-9df5-e9110dc2671e" };

const qr = () => (QR_GET as unknown as Handler)(new Request(`${base}/attendee-passes/attendee-1/qr`), context);
const paymentGet = () => (PAYMENT_GET as unknown as Handler)(new Request(`${base}/payment`), context);

const gated: Array<[string, () => Promise<Response>, () => unknown[]]> = [
  ["QR pass GET", qr, () => [mocks.createAccountAttendeePass, mocks.qrToString]],
  ["contact PATCH", () => (CONTACT_PATCH as unknown as Handler)(watched("", "PATCH"), context), () => [mocks.updateContact]],
  ["payment GET", paymentGet, () => [mocks.authorize, mocks.getCheckout]],
  ["payment POST", () => (PAYMENT_POST as unknown as Handler)(watched("/payment", "POST"), context), () => [mocks.authorize, mocks.rateLimit, mocks.createPayment]],
  ["payment-choice POST", () => (CHOICE_POST as unknown as Handler)(watched("/payment-choice", "POST"), context), () => [mocks.authorize, mocks.choosePayment]],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.pending.mockResolvedValue(false);
  mocks.getCurrentAttendee.mockResolvedValue({
    account: { id: "account-1", verifiedEmail: "guest@example.test", displayName: "Guest" },
    via: "attendee",
    sessionId: "session-1",
  });
  mocks.createAccountAttendeePass.mockResolvedValue({ token: "synthetic-token", expiresAt: new Date("2026-10-13T17:00:00Z") });
  mocks.qrToString.mockResolvedValue("<svg>pass</svg>");
  mocks.updateContact.mockResolvedValue({ codeAccepted: true, contact: contactBody.contact });
  mocks.authorize.mockResolvedValue({ registrationId: "registration-1" });
  mocks.getCheckout.mockResolvedValue({ totalCents: 100 });
  mocks.rateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.createPayment.mockResolvedValue({ status: "COMPLETED" });
  mocks.choosePayment.mockResolvedValue({ choice: "CARD" });
});

describe("attendee routes behind the second-step gate (#744)", () => {
  it.each(gated)("%s refuses a pending account with no side effects", async (_name, call, effects) => {
    mocks.pending.mockResolvedValue(true);
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "SECOND_STEP_REQUIRED" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.bodyRead).not.toHaveBeenCalled();
    for (const spy of effects()) expect(spy).not.toHaveBeenCalled();
  });

  it("lets an ordinary attendee through every gated route", async () => {
    expect((await qr()).status).toBe(200);
    expect(mocks.createAccountAttendeePass).toHaveBeenCalledTimes(1);
    const contact = await (CONTACT_PATCH as unknown as Handler)(send("", "PATCH", contactBody), context);
    expect(contact.status).toBe(200);
    expect(mocks.updateContact).toHaveBeenCalledTimes(1);
    expect((await paymentGet()).status).toBe(200);
    const pay = await (PAYMENT_POST as unknown as Handler)(send("/payment", "POST", paymentBody), context);
    expect(pay.status).toBe(200);
    expect(mocks.createPayment).toHaveBeenCalledTimes(1);
    const choice = await (CHOICE_POST as unknown as Handler)(send("/payment-choice", "POST", choiceBody), context);
    expect(choice.status).toBe(200);
    expect(mocks.choosePayment).toHaveBeenCalledTimes(1);
  });

  it("answers a cross-origin or signed-out request before the gate", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "INVALID_REQUEST_ORIGIN" }, { status: 403 }));
    const crossOrigin = await (CONTACT_PATCH as unknown as Handler)(send("", "PATCH", contactBody), context);
    expect(crossOrigin.status).toBe(403);
    expect(mocks.pending).not.toHaveBeenCalled();
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    expect((await qr()).status).toBe(401);
    expect(mocks.pending).not.toHaveBeenCalled();
  });

  it("refuses a QR pass to staff acting as an attendee", async () => {
    mocks.pending.mockResolvedValue(true); // act-as is refused before the second-step gate
    mocks.getCurrentAttendee.mockResolvedValue({
      account: { id: "account-1", verifiedEmail: "guest@example.test", displayName: "Guest" },
      via: "staff",
      sessionId: null,
    });
    const response = await qr();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "ACT_AS_NOT_ALLOWED",
      error: "ACT_AS_NOT_ALLOWED",
      message: "Switch to your attendee account to show passes.",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.createAccountAttendeePass).not.toHaveBeenCalled();
    expect(mocks.qrToString).not.toHaveBeenCalled();
  });
});
