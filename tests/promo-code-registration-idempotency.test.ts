import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
  enqueuePublicRegistrationMessages: vi.fn(),
  enqueueWaitlistJoinedMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit: dependencies.processQueuedMessageIdsAfterCommit,
  enqueuePublicRegistrationMessages: dependencies.enqueuePublicRegistrationMessages,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueWaitlistJoinedMessage: dependencies.enqueueWaitlistJoinedMessage,
}));

import { submitPublicRegistration } from "@/modules/forms/public-repository";

const definition = registrationFormDefinitionSchema.parse({
  title: "Promo replay verification",
  description: "",
  confirmationMessage: "Registration saved.",
  sections: [{
    id: "registration",
    title: "Registration",
    description: "",
    fields: [
      { id: "name", key: "full_name", label: "Full name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { id: "email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
      { id: "fee", key: "registration_fee", label: "Registration fee", helpText: "", type: "CALCULATED", scope: "REGISTRATION", required: false, options: [], priceCents: 10_000 },
      { id: "promo", key: "promo_code", label: "Promo code", helpText: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [] },
    ],
  }],
});

const input = publicRegistrationInputSchema.parse({
  versionId: "version_1",
  idempotencyKey: "42c8575a-a024-48cb-978d-90c64d9152e6",
  responses: {
    full_name: "Replay Tester",
    email: "replay@example.test",
    promo_code: "SAVE10",
  },
  website: "",
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestHash() {
  return createHash("sha256").update(stableJson({
    versionId: input.versionId,
    responses: input.responses,
  })).digest("hex");
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.processQueuedMessageIdsAfterCommit.mockResolvedValue({
    capturedIds: [],
    sentIds: [],
    failedIds: [],
    rescheduledIds: [],
    skippedIds: [],
  });
});

describe("promo-code registration idempotency", () => {
  it("returns the immutable first result without consuming a second promo use", async () => {
    const tx = {
      registrationForm: {
        findFirst: vi.fn().mockResolvedValue({
          id: "form_1",
          slug: "registration",
          eventId: "event_1",
          event: {
            id: "event_1",
            name: "Retreat",
            slug: "retreat",
            startsAt: new Date("2026-09-01T14:00:00.000Z"),
            endsAt: new Date("2026-09-03T18:00:00.000Z"),
            timezone: "America/Chicago",
            location: "Camp",
            capacity: null,
            isPublished: true,
            registrationOpensOn: "2026-06-01",
            registrationClosesOn: "2026-08-31",
            waitlistEnabled: false,
          },
          versions: [{
            id: "version_1",
            versionNumber: 1,
            definition,
            publishedAt: new Date("2026-06-01T12:00:00.000Z"),
          }],
        }),
      },
      publicRegistrationSubmission: {
        findUnique: vi.fn().mockResolvedValue({
          registrationId: "registration_1",
          requestHash: requestHash(),
          responses: input.responses,
          attendeeResponses: [],
          pricingSnapshot: {
            currency: "USD",
            formVersionId: "version_1",
            eventTimeZone: "America/Chicago",
            pricingDate: "2026-07-23",
            lineItems: [{
              key: "registration_fee",
              label: "Registration fee",
              amountCents: 10_000,
            }],
            preDiscountSubtotalCents: 10_000,
            discountAmountCents: 1_000,
            promoCode: "SAVE10",
            subtotalCents: 9_000,
            processingFeeCents: 0,
            totalCents: 9_000,
            cardSelected: false,
            paymentCollected: false,
          },
          registration: {
            confirmationCode: "REG-REPLAY",
            status: "SUBMITTED",
            waitlistEntry: null,
          },
        }),
      },
      messageOutbox: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      promoCode: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (
        operation: (client: typeof tx) => unknown,
      ) => operation(tx)),
    });

    const result = await submitPublicRegistration(
      "retreat",
      "registration",
      input,
      new Date("2026-07-23T12:00:00.000Z"),
    );

    expect(result).toMatchObject({
      confirmationCode: "REG-REPLAY",
      preDiscountSubtotalCents: 10_000,
      discountAmountCents: 1_000,
      promoCode: "SAVE10",
      subtotalCents: 9_000,
      totalCents: 9_000,
    });
    expect(tx.promoCode.findUnique).not.toHaveBeenCalled();
    expect(tx.promoCode.updateMany).not.toHaveBeenCalled();
    expect(dependencies.enqueuePublicRegistrationMessages).not.toHaveBeenCalled();
  });
});

