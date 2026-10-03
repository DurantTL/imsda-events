import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ChurchInvoiceNotice, ChurchInvoiceReviewFacts } from "@/components/church-invoice-notice";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { DateInput } from "@/components/club-form-date-input";
import { RadioCardGroup } from "@/components/radio-card-group";
import { MAX_AGE_YEARS, MIN_AGE_YEARS, ageInputAttributes, isWholeAgeInRange } from "@/modules/attendee-types/age-limits";
import { attendeeTypeInputSchema, attendeeTypeUpdateSchema } from "@/modules/attendee-types/domain";
import { templateAttendeeTypeSchema } from "@/modules/event-templates/domain";
import { churchInvoiceTerms, invoiceRecipientName, termsMatchPrice } from "@/modules/club-registrations/church-invoice-terms";
import { perPersonPrice } from "@/modules/club-registrations/per-person-price";
import { parseTypedAge } from "@/modules/club-registrations/roster-ages";
import { selectUsesRadioCards, usesRadioCards } from "@/modules/forms/choice-controls";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { CALENDAR_DATE_GUIDANCE, PUBLIC_DATE_GUIDANCE, formatTypedDate, parseTypedDate } from "@/modules/forms/typed-date";
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

  it("keeps an attendee type's stored age band maximum of 130, so existing rows and templates still save", () => {
    const base = { code: "YOUTH", label: "Youth" };
    expect(attendeeTypeInputSchema.safeParse({ ...base, minimumAge: 0, maximumAge: 125 }).success).toBe(true);
    expect(templateAttendeeTypeSchema.safeParse({ ...base, minimumAge: 0, maximumAge: 125 }).success).toBe(true);
    expect(attendeeTypeUpdateSchema.safeParse({ label: "Youth", minimumAge: 0, maximumAge: 125 }).success).toBe(true);
    expect(attendeeTypeInputSchema.safeParse({ ...base, minimumAge: 0, maximumAge: 131 }).success).toBe(false);
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
    expect(markup).toContain(PUBLIC_DATE_GUIDANCE);
    expect(markup).toContain("Pick a date.");
    expect(markup).not.toContain("calendar button");
    expect(markup).toContain('type="date"');
    // The helper line is linked to the input.
    const id = /aria-describedby="([^"]*_date_guidance)"/.exec(markup)?.[1];
    expect(id).toBeTruthy();
    expect(markup).toContain(`id="${id}"`);
  });

  it("says 'use the calendar button' only on the club date input, which has the button, and not when it is locked", () => {
    const render = (locked: boolean) => renderToStaticMarkup(createElement(DateInput, {
      label: "Date", labelText: "Date", value: "", onChange: () => undefined, locked,
    }));
    expect(render(false)).toContain(CALENDAR_DATE_GUIDANCE);
    expect(render(false)).toContain("Choose date for Date");
    expect(render(true)).not.toContain("calendar button");
    expect(render(true)).not.toContain("Choose date for");
    expect(PUBLIC_DATE_GUIDANCE).not.toContain("calendar button");
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
    const recipient = invoiceRecipientName(def, { church_name: " Synthetic Valley Church " });
    expect(recipient).toBe("Synthetic Valley Church");
    const markup = renderToStaticMarkup(createElement("div", null,
      createElement(ChurchInvoiceNotice, { terms, price: perPersonPrice({ lineItems: [{ label: "registration_fee", amountCents: 900 }], roster: false }) }),
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

describe("church-invoice terms only when they are the whole truth (#743)", () => {
  const rosterDefinition = (fields: Array<Record<string, unknown>>) => registrationFormDefinitionSchema.parse({
    title: "Synthetic event", description: "", confirmationMessage: "Received.",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 10, attendeeLabel: "Person", addButtonLabel: "Add a person" },
    sections: [{ id: "s_main", title: "People", description: "", fields: [
      field("first_name", { scope: "ATTENDEE", required: true }),
      field("last_name", { scope: "ATTENDEE", required: true }),
      ...fields,
    ] }],
  });
  const attendeeFee = (extra: Record<string, unknown> = {}) => field("registration_fee", { type: "CALCULATED", scope: "ATTENDEE", priceCents: 900, ...extra });
  const rates = { pricingDate: "2026-03-01" };
  const people = (count: number, amounts: number[]) => perPersonPrice({
    lineItems: amounts.map((amountCents, attendeeIndex) => ({ label: "Registration fee", amountCents, attendeeIndex })),
    roster: true, attendeeCount: count,
  });

  it("states no rate for a registration-scoped fee on a roster of three", () => {
    const def = rosterDefinition([field("registration_fee", { type: "CALCULATED", scope: "REGISTRATION", priceCents: 900 })]);
    expect(churchInvoiceTerms(def, rates)).toBeNull();
  });

  it("states no rate when a $9 fee has a $10 add-on for everyone, and keeps the notice if the amounts differ", () => {
    const def = rosterDefinition([attendeeFee(), field("meal", { type: "CALCULATED", scope: "ATTENDEE", priceCents: 1000 })]);
    expect(churchInvoiceTerms(def, rates)).toBeNull();
    const single = churchInvoiceTerms(rosterDefinition([attendeeFee()]), rates);
    expect(single).not.toBeNull();
    expect(termsMatchPrice(single!, people(3, [900, 900, 900]))).toBe(true);
    expect(termsMatchPrice(single!, people(3, [1900, 1900, 1900]))).toBe(false);
    expect(termsMatchPrice(single!, people(3, [900, 900, 0]))).toBe(false);
    expect(termsMatchPrice(single!, people(0, []))).toBe(false);
  });

  it("states no rate for choice-priced, checkbox-priced, quantity-priced or conditional fees", () => {
    expect(churchInvoiceTerms(rosterDefinition([attendeeFee({ conditional: { fieldKey: "first_name", operator: "EQUALS", value: "Sam" } })]), rates)).toBeNull();
    expect(churchInvoiceTerms(rosterDefinition([attendeeFee({ choicePricesCents: { A: 900 }, options: ["A"] })]), rates)).toBeNull();
    expect(churchInvoiceTerms(rosterDefinition([field("shirt", { type: "CHECKBOX", scope: "ATTENDEE", priceCents: 900 })]), rates)).toBeNull();
    expect(churchInvoiceTerms(rosterDefinition([field("meals", { type: "NUMBER", scope: "ATTENDEE", priceCents: 900 })]), rates)).toBeNull();
  });

  it("still states the rate for the single attendee-scoped fee", () => {
    const terms = churchInvoiceTerms(rosterDefinition([attendeeFee()]), { pricingDate: "2026-03-01", attendeeLabel: "Person" });
    expect(terms?.rateSentence).toBe("$9 per person.");
    const markup = renderToStaticMarkup(createElement(ChurchInvoiceNotice, { terms, price: people(3, [900, 900, 900]) }));
    expect(markup).toContain("$9 per person.");
    // A price that disagrees falls back to the per-person notice, with no stated rate.
    const mismatch = renderToStaticMarkup(createElement(ChurchInvoiceNotice, { terms, price: people(2, [1900, 1900]) }));
    expect(mismatch).not.toContain("$9 per person.");
    expect(mismatch).toContain("$19 per person.");
  });

  it("does not hide a fee line the sentence does not cover exactly", () => {
    const terms = churchInvoiceTerms(definition({ priceCents: 900 }), rates);
    const price = perPersonPrice({ lineItems: [{ label: "registration_fee", amountCents: 900 }, { label: "Extra", amountCents: 500 }], roster: false });
    const markup = renderToStaticMarkup(createElement(ChurchInvoiceNotice, { terms, price }));
    expect(markup).toContain("$9 per attendee.");
    expect(markup).toContain("Extra");
    expect(markup).not.toContain("registration_fee");
  });

  it("titles the review card 'Price' when no rate sentence applies", () => {
    const def = definition({ priceCents: 900 }, [field("meal", { type: "CHECKBOX", priceCents: 500, label: "Meal" })]);
    const markup = render(def, "DEFERRED_ORGANIZATION_INVOICE");
    expect(markup).not.toContain("per attendee.");
    const source = readFileSync("components/public-registration-form.tsx", "utf8");
    expect(source).toContain('shownInvoiceTerms ? "Rate per person" : "Price per person"');
  });
});

describe("church-invoice recipient (#743)", () => {
  const def = definition({ priceCents: 900 });
  it("reads a Not listed church from the name typed beside it, as the staff invoice does", () => {
    expect(invoiceRecipientName(def, { church_name: "Not listed", church_name_other: "Synthetic Chapel" })).toBe("Synthetic Chapel");
    expect(invoiceRecipientName(def, { church_name: "Synthetic Valley Church" })).toBe("Synthetic Valley Church");
  });
  it("uses the club when the club is the responsible organization", () => {
    expect(invoiceRecipientName(def, { club_name: "Synthetic Pathfinders", church_name: "Synthetic Valley Church" })).toBe("Synthetic Pathfinders");
  });
  it("resolves to nothing when no organization is named, so the review says 'Your church'", () => {
    expect(invoiceRecipientName(def, {})).toBeNull();
    expect(renderToStaticMarkup(createElement(ChurchInvoiceReviewFacts, { recipient: null }))).toContain("Your church");
  });
});

describe("dropdowns that stay dropdowns (#743)", () => {
  it("keeps directories, country, state, timezone and quantity selects as dropdowns", () => {
    const opt = ["A", "B", "C"];
    expect(selectUsesRadioCards({ key: "gender", label: "Gender", options: opt })).toBe(true);
    expect(selectUsesRadioCards({ key: "mc_country", label: "Home", options: opt })).toBe(false);
    expect(selectUsesRadioCards({ key: "home", label: "State or province", options: opt })).toBe(false);
    expect(selectUsesRadioCards({ key: "mc_region", label: "Home", options: opt })).toBe(false);
    expect(selectUsesRadioCards({ key: "tz", label: "Time zone", options: opt })).toBe(false);
    expect(selectUsesRadioCards({ key: "meal_qty", label: "Meals", options: opt })).toBe(false);
    expect(selectUsesRadioCards({ key: "church_name", label: "Church", options: opt, optionSource: "CHURCHES_DIRECTORY" })).toBe(false);
  });

  it("renders a three-entry directory and a country select as dropdowns on the form", () => {
    const markup = render(definition(null, [
      field("church_name", { type: "SELECT", label: "Church", optionSource: "CHURCHES_DIRECTORY", options: ["A", "B", "C"] }),
      field("mc_country", { type: "SELECT", label: "Home", options: ["US", "CA", "MX"] }),
      field("gender", { type: "SELECT", label: "Gender", options: ["Female", "Male"] }),
    ]));
    expect(markup).toContain("Search church");
    expect(markup).toContain("Search home");
    expect(markup).not.toMatch(/name="mc_country"/);
    expect(markup).toMatch(/name="gender"/);
  });
});

describe("the error link target on a full choice list (#743)", () => {
  it("still puts the base id on the first radio when every option is full and none is chosen", () => {
    const def = definition(null, [field("cabin", {
      type: "RADIO", label: "Cabin", options: ["A", "B"], availabilityMode: "CAPACITY", choiceLimits: { A: 1, B: 1 },
    })]);
    const usage = { cabin: { A: { total: 1, first: 0, second: 0 }, B: { total: 1, first: 0, second: 0 } } };
    const markup = renderToStaticMarkup(createElement(PublicRegistrationForm, {
      event, form: { slug: "synthetic", versionId: "v1", versionNumber: 1, definition: def },
      choiceUsage: usage, pricingDate: "2026-03-01", lifecycle, disableDrafts: true,
    }));
    expect(markup).toMatch(/<input id="public_registration_f_cabin"[^>]*type="radio"/);
    expect(markup).toContain("public_registration_f_cabin_option_1");
  });
});
