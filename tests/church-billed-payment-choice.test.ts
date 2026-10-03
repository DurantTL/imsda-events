import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  authorizeRegistrationAccessToken: vi.fn(),
  getCurrentAttendee: vi.fn(),
  authorizeAttendeeRegistration: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  checkPublicManageRateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ attendeeSecondStepPending: async () => false }));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@prisma/client", () => ({
  Prisma: {
    TransactionIsolationLevel: { Serializable: "Serializable" },
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {},
  },
}));
vi.mock("@/modules/public-access/repository", () => ({
  authorizeRegistrationAccessToken: dependencies.authorizeRegistrationAccessToken,
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: dependencies.getCurrentAttendee,
}));
vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({
  authorizeAttendeeRegistration: dependencies.authorizeAttendeeRegistration,
}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: dependencies.rejectCrossOriginRequest,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicManageRateLimit: dependencies.checkPublicManageRateLimit,
}));

import { POST as PUBLIC_POST } from "@/app/api/public/manage/[token]/payment-choice/route";
import { POST as ATTENDEE_POST } from "@/app/api/attendee/registrations/[registrationId]/payment-choice/route";

/**
 * A church-billed event has no card or pay-later choice, so both payment-choice endpoints refuse
 * it and return no quote, subtotal, total or balance (#621). Synthetic data only.
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

function promotedRegistration(billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE") {
  return {
    id: "registration-1",
    eventId: "event-1",
    confirmationCode: "REG-PROMOTED",
    status: "SUBMITTED",
    totalAmount: 80,
    event: { billingMode },
    waitlistEntry: { status: "PROMOTED" },
    publicFormSubmission: {
      pricingSnapshot: {
        currency: "USD",
        preDiscountSubtotalCents: 10_000,
        discountAmountCents: 2_000,
        subtotalCents: 8_000,
        processingFeeCents: 0,
        totalCents: 8_000,
      },
      formVersion: { definition },
    },
    paymentAttempts: [],
    payments: [],
    paymentChoiceOperations: [],
  };
}

function useRegistration(billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE") {
  const tx = {
    registrationAdjustment: { aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: null } }) },
    registrationPaymentChoiceOperation: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    registration: {
      findUnique: vi.fn().mockResolvedValue(promotedRegistration(billingMode)),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  dependencies.getPrisma.mockReturnValue({
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  });
  return tx;
}

const token = "a".repeat(43);
const body = { choice: "CARD", clientRequestId: "19af978c-b75a-4860-9df5-e9110dc2671e", expectedPriorOperationId: null };
const request = (url: string) => new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://events.imsda.test" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.rejectCrossOriginRequest.mockReturnValue(null);
  dependencies.checkPublicManageRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  dependencies.authorizeRegistrationAccessToken.mockResolvedValue({
    accessTokenId: "access-1", registrationId: "registration-1", eventId: "event-1", registrationStatus: "SUBMITTED",
  });
  dependencies.getCurrentAttendee.mockResolvedValue({ account: { verifiedEmail: "director@example.test" }, via: "attendee" });
  dependencies.authorizeAttendeeRegistration.mockResolvedValue({ registrationId: "registration-1", eventId: "event-1" });
});

describe("church-billed payment-choice endpoints (#621)", () => {
  it("refuses the private-link endpoint with no amounts and changes nothing", async () => {
    const tx = useRegistration("DEFERRED_ORGANIZATION_INVOICE");
    const response = await PUBLIC_POST(
      request(`https://events.imsda.test/api/public/manage/${token}/payment-choice`),
      { params: Promise.resolve({ token }) },
    );
    const text = await response.text();
    expect(response.status).toBe(422);
    expect(JSON.parse(text)).toMatchObject({ error: "PAYMENT_CHOICE_NOT_ELIGIBLE" });
    expect(text).not.toMatch(/totalCents|subtotalCents|baseSubtotalCents|balanceCents|processingFeeCents|8000|8270|82\.70/);
    expect(tx.registration.update).not.toHaveBeenCalled();
    expect(tx.registrationPaymentChoiceOperation.create).not.toHaveBeenCalled();
  });

  it("refuses the account endpoint with no amounts and changes nothing", async () => {
    const tx = useRegistration("DEFERRED_ORGANIZATION_INVOICE");
    const response = await ATTENDEE_POST(
      request("https://events.imsda.test/api/attendee/registrations/registration-1/payment-choice"),
      { params: Promise.resolve({ registrationId: "registration-1" }) },
    );
    const text = await response.text();
    expect(response.status).toBe(422);
    expect(text).not.toMatch(/totalCents|subtotalCents|baseSubtotalCents|balanceCents|processingFeeCents|8000|8270|82\.70/);
    expect(tx.registration.update).not.toHaveBeenCalled();
  });

  it("refuses before replaying a stored result, so no stored quote comes back either", async () => {
    const tx = useRegistration("DEFERRED_ORGANIZATION_INVOICE");
    tx.registrationPaymentChoiceOperation.findUnique.mockResolvedValue({
      requestFingerprint: "anything",
      responseSnapshot: {
        operationId: "67fcf012-8a2f-42ed-b316-2e9e4c370ce8",
        choice: "CARD",
        baseSubtotalCents: 8000,
        processingFeeCents: 270,
        totalCents: 8270,
        currency: "USD",
      },
    });
    const response = await PUBLIC_POST(
      request(`https://events.imsda.test/api/public/manage/${token}/payment-choice`),
      { params: Promise.resolve({ token }) },
    );
    const text = await response.text();
    expect(response.status).toBe(422);
    expect(text).not.toMatch(/8000|8270|totalCents|baseSubtotalCents/);
    // The refusal comes before the stored result is even looked up.
    expect(tx.registrationPaymentChoiceOperation.findUnique).not.toHaveBeenCalled();
  });

  it("still returns the quote on a self-pay promoted registration", async () => {
    useRegistration("ATTENDEE_PAY");
    const response = await PUBLIC_POST(
      request(`https://events.imsda.test/api/public/manage/${token}/payment-choice`),
      { params: Promise.resolve({ token }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paymentChoice: { totalCents: 8_270 } });
  });
});
