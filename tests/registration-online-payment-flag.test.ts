/**
 * The regression this guards: an attendee hitting "Online payment is
 * unavailable" on their manage link (checkoutFromRegistration in
 * modules/payments/square-repository.ts) had no equivalent signal anywhere
 * on the staff side — Finance and People & registrations only ever showed
 * recorded payment history, never whether a registration could currently
 * take a card payment at all. `onlinePaymentUnavailable` mirrors that same
 * eligibility check at read time so staff see the same condition the
 * attendee is stuck on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    registration: { findMany: mocks.findMany },
  }),
}));

import { listRegistrations } from "@/modules/registrations/repository";

const paymentDefinition = {
  title: "Women's Retreat",
  description: "",
  confirmationMessage: "Received.",
  payment: {
    enabled: true,
    currency: "USD" as const,
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
      type: "RADIO" as const,
      scope: "REGISTRATION" as const,
      required: true,
      options: ["Pay later", "Credit / debit card"],
    }],
  }],
};

function baseRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: "reg_1",
    eventId: "evt_1",
    confirmationCode: "WR26-1",
    status: "SUBMITTED",
    totalAmount: "250.00",
    contactSnapshot: {},
    submittedAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    accountHolderPerson: {
      id: "per_1",
      firstName: "Caleb",
      lastName: "Durant",
      normalizedEmail: "cdurant@imsda.org",
      phone: "",
    },
    attendees: [],
    payments: [],
    adjustments: [],
    messages: [],
    operations: [],
    publicFormSubmission: null,
    event: { billingMode: "STANDARD", attendeeTypes: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registration.onlinePaymentUnavailable", () => {
  it("flags a registration with a balance but no public form submission at all", async () => {
    mocks.findMany.mockResolvedValue([baseRegistration()]);

    const [registration] = await listRegistrations("evt_1");

    expect(registration!.balanceCents).toBe(25000);
    expect(registration!.onlinePaymentUnavailable).toBe(true);
  });

  it("does not flag a registration submitted through a published form with card payment enabled", async () => {
    mocks.findMany.mockResolvedValue([baseRegistration({
      publicFormSubmission: {
        responses: { payment_method: "Credit / debit card" },
        pricingSnapshot: {},
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        formVersion: {
          versionNumber: 1,
          status: "PUBLISHED",
          definition: paymentDefinition,
          form: { name: "Women's Retreat", slug: "womens-retreat", status: "PUBLISHED" },
        },
      },
    })]);

    const [registration] = await listRegistrations("evt_1");

    expect(registration!.onlinePaymentUnavailable).toBe(false);
  });

  it("does not flag a registration whose own submitted version was archived by a later publish, as long as the form is still published", async () => {
    mocks.findMany.mockResolvedValue([baseRegistration({
      publicFormSubmission: {
        responses: { payment_method: "Credit / debit card" },
        pricingSnapshot: {},
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        formVersion: {
          versionNumber: 1,
          status: "ARCHIVED",
          definition: paymentDefinition,
          form: { name: "Women's Retreat", slug: "womens-retreat", status: "PUBLISHED" },
        },
      },
    })]);

    const [registration] = await listRegistrations("evt_1");

    expect(registration!.onlinePaymentUnavailable).toBe(false);
  });

  it("flags a registration whose form has been withdrawn entirely", async () => {
    mocks.findMany.mockResolvedValue([baseRegistration({
      publicFormSubmission: {
        responses: { payment_method: "Credit / debit card" },
        pricingSnapshot: {},
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        formVersion: {
          versionNumber: 1,
          status: "PUBLISHED",
          definition: paymentDefinition,
          form: { name: "Women's Retreat", slug: "womens-retreat", status: "ARCHIVED" },
        },
      },
    })]);

    const [registration] = await listRegistrations("evt_1");

    expect(registration!.onlinePaymentUnavailable).toBe(true);
  });

  it("does not flag a paid-in-full registration even with no submission", async () => {
    mocks.findMany.mockResolvedValue([baseRegistration({
      payments: [{ amount: "250.00", refunds: [] }],
    })]);

    const [registration] = await listRegistrations("evt_1");

    expect(registration!.balanceCents).toBe(0);
    expect(registration!.onlinePaymentUnavailable).toBe(false);
  });

  it("does not flag a deferred-organization-billing event even with no submission", async () => {
    mocks.findMany.mockResolvedValue([baseRegistration({
      event: { billingMode: "DEFERRED_ORGANIZATION_INVOICE", attendeeTypes: [] },
    })]);

    const [registration] = await listRegistrations("evt_1");

    expect(registration!.onlinePaymentUnavailable).toBe(false);
  });

  it("does not flag a cancelled registration even with no submission", async () => {
    mocks.findMany.mockResolvedValue([baseRegistration({ status: "CANCELLED" })]);

    const [registration] = await listRegistrations("evt_1");

    expect(registration!.onlinePaymentUnavailable).toBe(false);
  });
});
