import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ChurchInvoiceNotice, ChurchInvoiceReviewFacts } from "@/components/church-invoice-notice";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { RadioCardGroup } from "@/components/radio-card-group";
import { MAX_AGE_YEARS, MIN_AGE_YEARS, ageInputAttributes, isWholeAgeInRange } from "@/modules/attendee-types/age-limits";
import { attendeeTypeInputSchema } from "@/modules/attendee-types/domain";
import { churchInvoiceTerms, invoiceRecipientName } from "@/modules/club-registrations/church-invoice-terms";
import { perPersonPrice } from "@/modules/club-registrations/per-person-price";
import { parseTypedAge } from "@/modules/club-registrations/roster-ages";
import { usesRadioCards } from "@/modules/forms/choice-controls";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { formatTypedDate, parseTypedDate } from "@/modules/forms/typed-date";
import { parseGroupAge } from "@/modules/group-registrations/domain";

// Synthetic data only.
const field = (key: string, extra: Record<string, unknown> = {}) => ({
  id: `f_${key}`, key, label: key, helpText: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [] as string[], ...extra,
});

function definition(fee: Record<string, unknown> | null, extraFields: Array<Record<string, unknown>> = []) {
  return registrationFormDefinitionSchema.parse({
    title: "Synthetic event", description: "", confirmationMessage: "Received.",
    sections: [{ id: "s_main", title: "Details", description: "", fields: [
      field("email", { type: "EMAIL", required: true }),
      ...extraFields,
      ...(fee ? [field("registration_fee", { type: "CALCULATED", ...fee })] : []),
    ] }],
  });
}

const event = {
  name: "Synthetic Event", slug: "synthetic-event", startsAt: "2026-12-05T15:00:00.000Z", endsAt: "2026-12-06T22:00:00.000Z",
  timezone: "America/Chicago", location: null, capacity: null, billingMode: "ATTENDEE_PAY" as const,
};
const lifecycle = { phase: "OPEN" as const, capacityDecision: "REGISTER" as const, remainingSpots: null, waitingRegistrations: 0 };
const render = (def: ReturnType<typeof definition>, billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE" = "ATTENDEE_PAY") => renderToStaticMarkup(createElement(PublicRegistrationForm, {
  event: { ...event, billingMode },
  form: { slug: "synthetic", versionId: "v1", versionNumber: 1, definition: def },
  choiceUsage: {}, pricingDate: "2026-03-01", lifecycle, disableDrafts: true,
}));

describe("radio cards for short choice lists (#743)", () => {
  it("draws the same radio inputs, with the same values, for four options or fewer", () => {
    expect(usesRadioCards(2)).toBe(true);
    expect(usesRadioCards(4)).toBe(true);
    expect(usesRadioCards(5)).toBe(false);
    expect(usesRadioCards(0)).toBe(false);
    const markup = renderToStaticMarkup(createElement(RadioCardGroup, {
      legend: "Billing mode", name: "billingMode", value: "ATTENDEE_PAY", onChange: () => undefined,
      options: [{ value: "ATTENDEE_PAY", label: "Attendees pay online" }, { value: "DEFERRED_ORGANIZATION_INVOICE", label: "Bill later" }],
    }));
    expect(markup).toContain("<fieldset");
    expect(markup).toContain("<legend>Billing mode</legend>");
    expect(markup).toContain('type="radio"');
    expect(markup).toContain('value="DEFERRED_ORGANIZATION_INVOICE"');
    expect(markup).toContain('name="billingMode"');
    expect(markup).not.toContain("<select");
  });

  it("renders a public SELECT of four or fewer options as radios, and a longer one as the dropdown it was", () => {
    const markup = render(definition(null, [
      field("gender", { type: "SELECT", label: "Gender", options: ["Female", "Male", "Prefer not to say"] }),
      field("tshirt", { type: "SELECT", label: "Shirt", options: ["XS", "S", "M", "L", "XL"] }),
    ]));
    expect(markup).toMatch(/name="gender"[^>]*type="radio"|type="radio"[^>]*name="gender"/);
    expect(markup).toContain("public-registration-radio-cards");
    // Each radio's saved value is the same option text the dropdown stored.
    expect(markup).toMatch(/<input[^>]*name="gender"[^>]*>/);
    const radios = markup.match(/<input[^>]*name="gender"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    // Five options stay a searchable dropdown, not radios.
    expect(markup).not.toMatch(/name="tshirt"/);
    expect(markup).toContain("Search shirt");
  });
});

describe("age fields (#743)", () => {
  it("share one numeric range of 0 to 120 in the inputs and the server checks", () => {
    expect(ageInputAttributes).toMatchObject({ inputMode: "numeric", min: 0, max: 120 });
    expect([MIN_AGE_YEARS, MAX_AGE_YEARS]).toEqual([0, 120]);
    expect(isWholeAgeInRange(0)).toBe(true);
    expect(isWholeAgeInRange(120)).toBe(true);
    expect(isWholeAgeInRange(121)).toBe(false);
    expect(isWholeAgeInRange(-1)).toBe(false);
    expect(isWholeAgeInRange(7.5)).toBe(false);
    expect(parseTypedAge("120")).toBe(120);
    expect(parseTypedAge("121")).toBeUndefined();
    expect(parseGroupAge("120")).toBe(120);
    expect(parseGroupAge("121")).toBeNull();
  });

  it("holds an attendee type's age band to the same range", () => {
    const base = { code: "YOUTH", label: "Youth" };
    expect(attendeeTypeInputSchema.safeParse({ ...base, minimumAge: 0, maximumAge: 120 }).success).toBe(true);
    expect(attendeeTypeInputSchema.safeParse({ ...base, minimumAge: 0, maximumAge: 121 }).success).toBe(false);
  });
});

describe("typed dates (#743)", () => {
  it("reads M/D/YYYY and ISO into the stored ISO date, and nothing else", () => {
    expect(parseTypedDate("4/10/2026")).toBe("2026-04-10");
    expect(parseTypedDate(" 04/09/2026 ")).toBe("2026-04-09");
    expect(parseTypedDate("2026-04-10")).toBe("2026-04-10");
    expect(parseTypedDate("2/29/2028")).toBe("2028-02-29");
    expect(parseTypedDate("2/29/2027")).toBeNull();
    expect(parseTypedDate("13/1/2026")).toBeNull();
    expect(parseTypedDate("4/10/26")).toBeNull();
    expect(parseTypedDate("April 10")).toBeNull();
    expect(formatTypedDate("2026-04-10")).toBe("4/10/2026");
    expect(formatTypedDate("not a date")).toBe("");
  });

  it("shows the M/D/YYYY guidance under a public date question and keeps the date input", () => {
    const markup = render(definition(null, [field("arrival", { type: "DATE", label: "Arrival" })]));
    expect(markup).toContain("Type the date as M/D/YYYY");
    expect(markup).toContain('type="date"');
  });
});

describe("church-invoice wording (#743)", () => {
  it("leads with two tiers built from the configured rates and date", () => {
    const terms = churchInvoiceTerms(
      definition({ priceCents: 900, latePricing: { startsOn: "2026-04-11", label: "Late", priceCents: 1400 } }),
      { pricingDate: "2026-03-01" },
    );
    expect(terms?.rateSentence).toBe("$9 per attendee through April 10; $14 afterward.");
    expect(terms?.leadSentence).toBe("$9 per attendee through April 10; $14 afterward. No payment is collected with this form — your church will be invoiced after the event based on confirmed attendance.");
  });

  it("changes with the configuration instead of hardcoding amounts", () => {
    const terms = churchInvoiceTerms(
      definition({ priceCents: 2550, latePricing: { startsOn: "2026-08-15", label: "Late", priceCents: 3000 } }),
      { pricingDate: "2026-03-01", attendeeLabel: "Camper" },
    );
    expect(terms?.rateSentence).toBe("$25.50 per camper through August 14; $30 afterward.");
  });

  it("shows one line for a single rate, with no 'through'", () => {
    const terms = churchInvoiceTerms(definition({ priceCents: 900 }), { pricingDate: "2026-03-01" });
    expect(terms?.rateSentence).toBe("$9 per attendee.");
    expect(terms?.tiers).toEqual([{ amountCents: 900, throughDate: null }]);
  });

  it("omits 'through' when the late price equals the regular one, and after the deadline shows only the rate in force", () => {
    const same = definition({ priceCents: 900, latePricing: { startsOn: "2026-04-11", label: "Late", priceCents: 900 } });
    expect(churchInvoiceTerms(same, { pricingDate: "2026-03-01" })?.rateSentence).toBe("$9 per attendee.");
    const late = definition({ priceCents: 900, latePricing: { startsOn: "2026-04-11", label: "Late", priceCents: 1400 } });
    expect(churchInvoiceTerms(late, { pricingDate: "2026-04-11" })?.rateSentence).toBe("$14 per attendee.");
  });

  it("states nothing when the fee is not one plain per-person price", () => {
    expect(churchInvoiceTerms(definition(null), { pricingDate: "2026-03-01" })).toBeNull();
    expect(churchInvoiceTerms(
      definition({ priceCents: 900, choicePricesCents: { A: 900 }, options: ["A"], type: "CALCULATED" }),
      { pricingDate: "2026-03-01" },
    )).toBeNull();
  });

  it("puts the rate first on the public form and never a total", () => {
    const def = definition({ priceCents: 900, latePricing: { startsOn: "2026-04-11", label: "Late", priceCents: 1400 } });
    const markup = render(def, "DEFERRED_ORGANIZATION_INVOICE");
    expect(markup).toContain("$9 per attendee through April 10; $14 afterward.");
    expect(markup).toContain("No payment is collected with this form");
    expect(markup).not.toContain("Registration total");
    // The fee's own price line is the rate above, so it is not listed a second time.
    expect(markup).not.toContain("Price: registration_fee");
  });
});

describe("church-invoice review screen (#743)", () => {
  it("shows the rate, no payment due online, the church to be invoiced, and the timing", () => {
    const def = definition({ priceCents: 900, latePricing: { startsOn: "2026-04-11", label: "Late", priceCents: 1400 } }, [
      field("church", { type: "SELECT", label: "Church", optionSource: "CHURCHES_DIRECTORY" }),
    ]);
    const terms = churchInvoiceTerms(def, { pricingDate: "2026-03-01" });
    const recipient = invoiceRecipientName(def, { church: " Synthetic Valley Church " });
    expect(recipient).toBe("Synthetic Valley Church");
    const markup = renderToStaticMarkup(createElement("div", null,
      createElement(ChurchInvoiceNotice, { terms, price: perPersonPrice({ lineItems: [], roster: false }) }),
      createElement(ChurchInvoiceReviewFacts, { recipient }),
    ));
    expect(markup).toContain("$9 per attendee through April 10; $14 afterward.");
    expect(markup).toContain("No payment due online");
    expect(markup).toContain("Invoice recipient");
    expect(markup).toContain("Synthetic Valley Church");
    expect(markup).toContain("invoiced after the event");
  });

  it("falls back to 'Your church' when no church was chosen, and the review card uses these pieces", async () => {
    expect(invoiceRecipientName(definition({ priceCents: 900 }), {})).toBeNull();
    expect(renderToStaticMarkup(createElement(ChurchInvoiceReviewFacts, { recipient: null }))).toContain("Your church");
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/public-registration-form.tsx", "utf8");
    expect(source).toContain("<ChurchInvoiceReviewFacts recipient={invoiceRecipient} />");
    expect(source).toContain("Attendees</p>");
  });
});
