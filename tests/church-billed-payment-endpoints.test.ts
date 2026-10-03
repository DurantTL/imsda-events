import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  authorizeRegistrationAccessToken: vi.fn(),
  getCurrentAttendee: vi.fn(),
  authorizeAttendeeRegistration: vi.fn(),
  getSquareConfiguration: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ attendeeSecondStepPending: async () => false }));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/public-access/repository", () => ({
  authorizeRegistrationAccessToken: dependencies.authorizeRegistrationAccessToken,
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: dependencies.getCurrentAttendee,
}));
vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({
  authorizeAttendeeRegistration: dependencies.authorizeAttendeeRegistration,
}));
vi.mock("@/modules/payments/square-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/payments/square-config")>()),
  getSquareConfiguration: dependencies.getSquareConfiguration,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueuePaymentReceiptMessage: vi.fn(),
  enqueueRefundNoticeMessage: vi.fn(),
}));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit: vi.fn(),
}));
vi.mock("@/modules/rate-limit/service", () => ({ checkPublicPaymentRateLimit: vi.fn() }));

import { GET as PUBLIC_GET } from "@/app/api/public/manage/[token]/payment/route";
import { GET as ATTENDEE_GET } from "@/app/api/attendee/registrations/[registrationId]/payment/route";

/**
 * The payment JSON of a church-billed registration carries a state and a message, never an
 * amount, balance, surcharge or payment-choice total (#621). Synthetic data only.
 */

const definition = {
  title: "Synthetic camporee",
  description: "",
  confirmationMessage: "Received.",
  payment: {
    enabled: true,
    currency: "USD",
    paymentMethodFieldKey: "payment_method",
    cardOptionValue: "Credit / debit card",
    percentageBasisPoints: 290,
    fixedFeeCents: 30,
    passFeeToRegistrant: true,
  },
  sections: [{
    id: "payment-section",
    title: "Payment",
    description: "",
    fields: [{
      id: "payment-method",
      key: "payment_method",
      label: "Payment method",
      helpText: "",
      type: "RADIO",
      scope: "REGISTRATION",
      required: true,
      options: ["Pay later", "Credit / debit card"],
    }],
  }],
};

function registration(billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE") {
  return {
    id: "registration-1",
    eventId: "event-1",
    confirmationCode: "REG-ONE",
    status: "CONFIRMED",
    totalAmount: 250,
    event: { billingMode },
    contactSnapshot: { firstName: "Test", lastName: "Director", email: "director@example.test", phone: "" },
    accountHolderPerson: { firstName: "Test", lastName: "Director", normalizedEmail: "director@example.test", phone: null },
    payments: [],
    paymentAttempts: [],
    waitlistEntry: null,
    paymentChoiceOperations: [],
    publicFormSubmission: {
      responses: { payment_method: "Pay later" },
      pricingSnapshot: { currency: "USD", subtotalCents: 25_000 },
      formVersion: { status: "PUBLISHED", definition, form: { versions: [{ id: "live-version" }] } },
    },
  };
}

const token = "a".repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getSquareConfiguration.mockReturnValue({
    environment: "sandbox",
    applicationId: "sandbox-app",
    locationId: "sandbox-location",
    accessToken: "sandbox-access-token",
    apiUrl: "https://connect.squareupsandbox.com",
    apiVersion: "2026-07-15",
    scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
    webhookSignatureKey: "key",
    webhookNotificationUrl: "https://events.imsda.test/api/webhooks/square",
    paymentConfigured: true,
    webhookConfigured: true,
    issue: null,
  });
  dependencies.authorizeRegistrationAccessToken.mockResolvedValue({ registrationId: "registration-1", eventId: "event-1", accessTokenId: "access-1" });
  dependencies.getCurrentAttendee.mockResolvedValue({ account: { verifiedEmail: "director@example.test" }, via: "attendee" });
  dependencies.authorizeAttendeeRegistration.mockResolvedValue({ registrationId: "registration-1", eventId: "event-1" });
});

function useRegistration(billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE") {
  dependencies.getPrisma.mockReturnValue({
    registration: { findUnique: vi.fn().mockResolvedValue(registration(billingMode)) },
  });
}

const publicRequest = () => new Request(`https://events.imsda.test/api/public/manage/${token}/payment`);
const attendeeRequest = () => new Request("https://events.imsda.test/api/attendee/registrations/registration-1/payment");

describe("church-billed payment endpoints (#621)", () => {
  it("returns only state, message and currency from the private-link payment endpoint", async () => {
    useRegistration("DEFERRED_ORGANIZATION_INVOICE");
    const response = await PUBLIC_GET(publicRequest(), { params: Promise.resolve({ token }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.checkout).toEqual({
      state: "NOT_ELIGIBLE",
      message: "This event bills the responsible organization directly. No online payment is available.",
      currency: "USD",
    });
    expect(JSON.stringify(body)).not.toMatch(/25000|250|amountCents|balanceCents|surchargeCents|paymentChoice/);
  });

  it("returns only state, message and currency from the account payment endpoint", async () => {
    useRegistration("DEFERRED_ORGANIZATION_INVOICE");
    const response = await ATTENDEE_GET(attendeeRequest(), { params: Promise.resolve({ registrationId: "registration-1" }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(body.checkout).sort()).toEqual(["currency", "message", "state"]);
    expect(JSON.stringify(body)).not.toMatch(/25000|amountCents|balanceCents|surchargeCents|paymentChoice/);
  });

  it("still returns the amounts on a self-pay registration", async () => {
    useRegistration("ATTENDEE_PAY");
    const response = await PUBLIC_GET(publicRequest(), { params: Promise.resolve({ token }) });
    const body = await response.json();
    expect(body.checkout).toMatchObject({ state: "READY", balanceCents: 25_000 });
  });
});
