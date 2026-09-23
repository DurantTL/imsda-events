/**
 * The People & registrations workspace resends a registration's original
 * confirmation email from its Email history panel. Deciding whether a given
 * message is that resendable original (versus an audited resend copy) needs
 * `retryOfMessageId` on each serialized message, so this guards that the
 * repository keeps selecting and passing it through.
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

describe("registration.messages retryOfMessageId", () => {
  it("passes the original confirmation's retryOfMessageId through as null", async () => {
    mocks.findMany.mockResolvedValue([baseRegistration({
      messages: [{
        id: "msg_original",
        templateKey: "REGISTRATION_CONFIRMATION_PAID",
        recipientEmail: "cdurant@imsda.org",
        recipientName: "Caleb Durant",
        subjectSnapshot: "You're confirmed",
        bodyTextSnapshot: "See you there.",
        status: "SENT",
        retryOfMessageId: null,
        providerDeliveryStatus: "DELIVERED",
        capturedAt: null,
        sentAt: new Date("2026-06-01T00:05:00.000Z"),
        deliveredAt: new Date("2026-06-01T00:06:00.000Z"),
        failedAt: null,
        lastError: null,
        createdAt: new Date("2026-06-01T00:05:00.000Z"),
      }],
    })]);

    const [registration] = await listRegistrations("evt_1");

    expect(registration!.messages[0]!.retryOfMessageId).toBeNull();
  });

  it("passes a resend copy's retryOfMessageId through so it is not offered as resendable again", async () => {
    mocks.findMany.mockResolvedValue([baseRegistration({
      messages: [{
        id: "msg_copy",
        templateKey: "REGISTRATION_CONFIRMATION_PAID",
        recipientEmail: "corrected@imsda.org",
        recipientName: "Caleb Durant",
        subjectSnapshot: "You're confirmed",
        bodyTextSnapshot: "See you there.",
        status: "SENT",
        retryOfMessageId: "msg_original",
        providerDeliveryStatus: "DELIVERED",
        capturedAt: null,
        sentAt: new Date("2026-06-02T00:05:00.000Z"),
        deliveredAt: new Date("2026-06-02T00:06:00.000Z"),
        failedAt: null,
        lastError: null,
        createdAt: new Date("2026-06-02T00:05:00.000Z"),
      }],
    })]);

    const [registration] = await listRegistrations("evt_1");

    expect(registration!.messages[0]!.retryOfMessageId).toBe("msg_original");
  });
});
