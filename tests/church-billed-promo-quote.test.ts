import { beforeEach, describe, expect, it, vi } from "vitest";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { getPublicPromoCodeQuote } from "@/modules/promo-codes/repository";

/**
 * A promo quote for a church-billed event omits the subtotal, total and fee sum
 * (#621); a self-pay quote keeps them. Synthetic data only.
 */

const definition = registrationFormDefinitionSchema.parse({
  title: "Synthetic camporee",
  description: "Synthetic form.",
  confirmationMessage: "Received.",
  sections: [{
    id: "details",
    title: "Details",
    description: "",
    fields: [
      { id: "fee_field", key: "fee", label: "Camporee fee", type: "CHECKBOX", scope: "REGISTRATION", required: false, helpText: "", options: [], priceCents: 2500 },
      { id: "promo_field", key: "promo_code", label: "Promo code", type: "TEXT", scope: "REGISTRATION", required: false, helpText: "", options: [] },
    ],
  }],
});

function setEvent(billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE") {
  dependencies.getPrisma.mockReturnValue({
    registrationForm: {
      findFirst: vi.fn().mockResolvedValue({
        id: "form_1",
        slug: "registration",
        eventId: "event_1",
        event: {
          timezone: "America/Chicago",
          endsAt: new Date("2027-03-01T22:00:00.000Z"),
          isPublished: true,
          registrationOpensOn: null,
          registrationClosesOn: null,
          waitlistEnabled: false,
          billingMode,
          attendeeTypes: [],
        },
        versions: [{ id: "version_1", definition }],
      }),
    },
    promoCode: {
      findUnique: vi.fn().mockResolvedValue({
        id: "promo_1",
        code: "SAVE5",
        normalizedCode: "SAVE5",
        isActive: true,
        discountType: "FIXED_CENTS",
        discountValue: 500,
        startsOn: null,
        endsOn: null,
        minimumSubtotalCents: null,
        maximumUses: null,
        maximumDiscountCents: null,
        redeemedCount: 0,
        sponsoringOrganizationId: null,
      }),
    },
  });
}

const quoteInput = {
  versionId: "version_1",
  code: "SAVE5",
  responses: { fee: true },
  attendees: [],
} as unknown as Parameters<typeof getPublicPromoCodeQuote>[2];

const now = new Date("2026-10-01T12:00:00.000Z");

beforeEach(() => vi.clearAllMocks());

describe("public promo quote totals (#621)", () => {
  it("omits subtotal, total and processing fee on a church-billed event, keeping per-person lines", async () => {
    setEvent("DEFERRED_ORGANIZATION_INVOICE");
    const quote = await getPublicPromoCodeQuote("synthetic-camporee", "registration", quoteInput, now);
    expect(quote).not.toHaveProperty("subtotalCents");
    expect(quote).not.toHaveProperty("totalCents");
    expect(quote).not.toHaveProperty("processingFeeCents");
    expect(quote).not.toHaveProperty("preDiscountSubtotalCents");
    // No aggregate discount and no raw line items either: they would add back up to the total (S1, O1).
    expect(quote).not.toHaveProperty("discountAmountCents");
    expect(quote).not.toHaveProperty("lineItems");
    expect(quote).toMatchObject({ promoCode: "SAVE5", perPerson: { roster: false, registrationLines: [{ label: "Camporee fee", amountCents: 2500 }] } });
  });

  it("keeps the totals on a self-pay event", async () => {
    setEvent("ATTENDEE_PAY");
    const quote = await getPublicPromoCodeQuote("synthetic-camporee", "registration", quoteInput, now);
    expect(quote).toMatchObject({ preDiscountSubtotalCents: 2500, subtotalCents: 2000, totalCents: 2000, discountAmountCents: 500 });
    expect(quote).toHaveProperty("lineItems");
  });

  it("words a minimum-not-met refusal without any amount on a church-billed event, and keeps the amounts on self-pay (S1)", async () => {
    for (const billingMode of ["DEFERRED_ORGANIZATION_INVOICE", "ATTENDEE_PAY"] as const) {
      setEvent(billingMode);
      const prisma = dependencies.getPrisma();
      prisma.promoCode.findUnique.mockResolvedValue({
        id: "promo_1", code: "SAVE5", normalizedCode: "SAVE5", isActive: true, discountType: "FIXED_CENTS", discountValue: 500,
        startsOn: null, endsOn: null, minimumSubtotalCents: 10_000, maximumUses: null, maximumDiscountCents: null, redeemedCount: 0,
        sponsoringOrganizationId: null,
      });
      const failure = getPublicPromoCodeQuote("synthetic-camporee", "registration", quoteInput, now);
      if (billingMode === "DEFERRED_ORGANIZATION_INVOICE") {
        await expect(failure).rejects.toMatchObject({ reason: "MINIMUM_NOT_MET", message: "This promo code's minimum isn't met for this registration." });
      } else {
        await expect(failure).rejects.toMatchObject({ reason: "MINIMUM_NOT_MET", message: expect.stringContaining("$25.00") });
      }
    }
  });
});
