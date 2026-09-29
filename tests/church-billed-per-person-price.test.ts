import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { PerPersonPriceNotice } from "@/components/per-person-price-notice";
import { ClubPacketSheet } from "@/components/club-packet-sheet";
import { withChurchBilledPriceWording } from "@/modules/communications/templates";
import { buildPaymentStatusBlock } from "@/modules/communications/message-blocks";
import {
  CHURCH_BILLED_NOTICE,
  lineItemsFromPricingSnapshot,
  perPersonPrice,
  perPersonPriceInline,
  perPersonPriceText,
} from "@/modules/club-registrations/per-person-price";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

/** Church-billed events show registrants the per-person price only, never a total (#621). Synthetic data only. */

const line = (index: number, amountCents: number, label = `Person ${index + 1}`) => ({
  key: `attendees.${index}.fee`,
  label: `Fee — ${label}`,
  amountCents,
  attendeeIndex: index,
  attendeeLabel: label,
});

describe("perPersonPrice", () => {
  it("collapses identical per-person prices into one notice and never sums attendees", () => {
    const price = perPersonPrice([line(0, 2500), line(1, 2500), line(2, 2500)]);
    expect(price.notice).toBe("$25 per person. Your church is billed after the event.");
    expect(price.uniformAmountCents).toBe(2500);
    expect(price.notice).not.toContain("75");
  });

  it("lists each attendee's own price, without a sum, when prices differ (options or add-ons)", () => {
    const price = perPersonPrice([line(0, 2500, "Ada"), { ...line(0, 500, "Ada"), key: "attendees.0.addon" }, line(1, 2500, "Ben")]);
    expect(price.uniformAmountCents).toBeNull();
    expect(price.attendeeLines).toEqual([
      { attendeeLabel: "Ada", amountCents: 3000 },
      { attendeeLabel: "Ben", amountCents: 2500 },
    ]);
    expect(perPersonPriceText([line(0, 3000, "Ada"), line(1, 2500, "Ben")])).not.toContain("$55");
    expect(perPersonPriceInline([line(0, 3000, "Ada"), line(1, 2500, "Ben")])).not.toContain("$55");
  });

  it("uses the plain lines as the one person's price when the form has no roster", () => {
    expect(perPersonPrice([{ label: "Fee", amountCents: 1800 }]).notice).toBe("$18 per person. Your church is billed after the event.");
  });

  it("falls back to the notice alone when there is no price", () => {
    expect(perPersonPrice([]).notice).toBe(CHURCH_BILLED_NOTICE);
  });

  it("reads line items from a stored pricing snapshot and ignores anything malformed", () => {
    expect(lineItemsFromPricingSnapshot({ lineItems: [{ label: "Fee", amountCents: 2500, attendeeIndex: 0 }, { label: 3 }, null] })).toEqual([
      { label: "Fee", amountCents: 2500, attendeeIndex: 0 },
    ]);
    expect(lineItemsFromPricingSnapshot(null)).toEqual([]);
  });

  it("renders the notice component with no total", () => {
    const markup = renderToStaticMarkup(createElement(PerPersonPriceNotice, { price: perPersonPrice([line(0, 2500), line(1, 2500)]) }));
    expect(markup).toContain("$25 per person. Your church is billed after the event.");
    expect(markup).not.toContain("$50");
  });
});

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
    ],
  }],
});

function renderForm(billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE") {
  return renderToStaticMarkup(createElement(PublicRegistrationForm, {
    event: {
      name: "Synthetic Camporee",
      slug: "synthetic-camporee",
      startsAt: "2027-02-19T21:00:00.000Z",
      endsAt: "2027-02-21T17:00:00.000Z",
      timezone: "America/Chicago",
      location: "Camp",
      capacity: null,
      billingMode,
    },
    form: { slug: "registration", versionId: "version-1", versionNumber: 1, definition },
    choiceUsage: {},
    pricingDate: "2026-09-29",
    lifecycle: { phase: "OPEN", capacityDecision: "REGISTER", remainingSpots: null, waitingRegistrations: 0 },
    initialResponses: { fee: true },
    disableDrafts: true,
  }));
}

describe("registration form order summary", () => {
  it("shows a church-billed registrant the per-person price and no total, subtotal or estimate", () => {
    const markup = renderForm("DEFERRED_ORGANIZATION_INVOICE");
    expect(markup).toContain("$25 per person. Your church is billed after the event.");
    expect(markup).not.toContain("Subtotal");
    expect(markup).not.toContain("Estimated total");
    expect(markup).not.toContain("Total");
  });

  it("keeps the total on a self-pay event", () => {
    const markup = renderForm("ATTENDEE_PAY");
    expect(markup).toContain("Subtotal");
    expect(markup).toContain("Total");
    expect(markup).not.toContain("Your church is billed after the event.");
  });
});

describe("club packet", () => {
  const base = {
    event: { name: "Synthetic Camporee", conferenceName: "IMSDA Events", startsOn: "2027-02-19T12:00:00.000Z", endsOn: "2027-02-21T12:00:00.000Z", timezone: "America/Chicago", earlyBirdDeadline: null, lateRateApplied: false },
    club: { organizationId: "org-1", organizationName: "Synthetic Club", sponsoringChurch: "Synthetic Church", directorName: "Pat Example", email: "pat@example.test", phone: "555-0100", submittedAt: "2027-01-05T00:00:00.000Z", confirmationCode: "CAMP-001" },
    headcounts: { pathfinder: 1, tlt: 0, staff: 0, child: 0, total: 1 },
    firstTimeCampers: 0,
    attendees: [],
    camping: { tents: "", trailers: "", kitchenCanopy: "", totalSqft: "", campNextTo: "" },
    assignment: null,
    dutyPreferences: { dutyAreas: [], flagSlots: [], bathroomDays: [] },
    otherDetails: { specialActivities: [], sponsoringMeals: false, mealSponsorshipCount: "", mealTimes: [], partnerClub: "", eventRibbons: "", sabbathSkit: "" },
    milestones: { baptismNames: "", bibleNames: "" },
    isBilled: true,
  };

  it("shows the director the per-person notice, and staff the amount", () => {
    const director = renderToStaticMarkup(createElement(ClubPacketSheet, {
      packet: { ...base, amountOwedCents: null, perPersonNotice: "$25 per person. Your church is billed after the event." } as never,
      qrSrc: "/qr",
    }));
    expect(director).toContain("$25 per person. Your church is billed after the event.");
    expect(director).not.toContain("Estimated amount billed");
    const staff = renderToStaticMarkup(createElement(ClubPacketSheet, { packet: { ...base, amountOwedCents: 4500 } as never, qrSrc: "/qr" }));
    expect(staff).toContain("Estimated amount billed to the church");
    expect(staff).toContain("$45.00");
  });
});

describe("confirmation email wording", () => {
  it("relabels the default total line to a price line and drops the balance line for church-billed registrants", () => {
    const body = "- **Registration total:** {{total_amount}}\n- **Balance due:** {{balance_amount}}\n\nThanks";
    const church = withChurchBilledPriceWording(body, true);
    expect(church).toContain("- **Price:** {{total_amount}}");
    expect(church).not.toContain("Balance due");
    expect(church).not.toContain("Registration total");
    expect(withChurchBilledPriceWording(body, false)).toBe(body);
  });

  it("the church-billed payment block carries the per-person notice and no total", () => {
    const block = buildPaymentStatusBlock({
      state: "ORGANIZATION_INVOICED",
      totalCents: 7500,
      paidCents: 0,
      balanceCents: 7500,
      perPersonNotice: perPersonPriceInline([line(0, 2500), line(1, 2500), line(2, 2500)]),
    });
    expect(block).toContain("$25 per person. Your church is billed after the event.");
    expect(block).not.toContain("$75");
  });
});
