import { describe, expect, it } from "vitest";
import { registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";
import {
  calendarDateInTimeZone,
  preparePublicRegistration,
  publicRegistrationInputSchema,
} from "@/modules/forms/public-domain";

const idempotencyKey = "2f1c5ce4-a9bc-4d15-8a6d-9879f25dbd3b";

function definitionFixture(): RegistrationFormDefinition {
  return registrationFormDefinitionSchema.parse({
    title: "Public registration fixture",
    description: "Fictitious domain test form.",
    confirmationMessage: "Your local test registration is ready.",
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
      id: "contact_section",
      title: "Contact details",
      description: "",
      fields: [
        { id: "first_name_field", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "last_name_field", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "email_field", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
        { id: "phone_field", key: "phone", label: "Phone", helpText: "", type: "PHONE", scope: "REGISTRATION", required: false, options: [] },
        { id: "stay_field", key: "stay_type", label: "Stay type", helpText: "", type: "RADIO", scope: "REGISTRATION", required: true, options: ["Commuting", "Hotel"] },
        { id: "hotel_field", key: "hotel_details", label: "Hotel details", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [], priceCents: 5000, conditional: { fieldKey: "stay_type", operator: "EQUALS", value: "Hotel" } },
        { id: "fee_field", key: "registration_fee", label: "Registration fee", helpText: "", type: "CALCULATED", scope: "REGISTRATION", required: false, options: [], priceCents: 12500, latePricing: { startsOn: "2026-08-15", label: "Late registration pricing", priceCents: 14500 } },
        { id: "payment_field", key: "payment_method", label: "Payment method", helpText: "", type: "RADIO", scope: "REGISTRATION", required: true, options: ["Pay later", "Credit / debit card"] },
      ],
    }],
  });
}

function input(responses: Record<string, unknown>) {
  return publicRegistrationInputSchema.parse({ versionId: "form-version-1", idempotencyKey, responses });
}

describe("public registration domain", () => {
  it("resolves the event-local calendar date across the pricing boundary", () => {
    expect(calendarDateInTimeZone(new Date("2026-08-15T04:59:59.999Z"), "America/Chicago")).toBe("2026-08-14");
    expect(calendarDateInTimeZone(new Date("2026-08-15T05:00:00.000Z"), "America/Chicago")).toBe("2026-08-15");
  });

  it("strips hidden priced answers and calculated-field input", () => {
    const prepared = preparePublicRegistration(definitionFixture(), input({
      first_name: "  Avery ",
      last_name: " Tester ",
      email: " AVERY@EXAMPLE.TEST ",
      stay_type: "Commuting",
      hotel_details: "Charge this hidden answer",
      registration_fee: 1,
      payment_method: "Pay later",
    }), { timeZone: "America/Chicago", now: new Date("2026-08-14T12:00:00Z") });

    expect(prepared.responses).toEqual({
      first_name: "Avery",
      last_name: "Tester",
      email: "AVERY@EXAMPLE.TEST",
      stay_type: "Commuting",
      payment_method: "Pay later",
    });
    expect(prepared.calculation).toMatchObject({ subtotalCents: 12500, processingFeeCents: 0, totalCents: 12500 });
    expect(prepared.isValid).toBe(true);
  });

  it("rejects unknown response keys instead of persisting them", () => {
    const prepared = preparePublicRegistration(definitionFixture(), input({
      first_name: "Avery",
      last_name: "Tester",
      email: "avery@example.test",
      stay_type: "Commuting",
      payment_method: "Pay later",
      total_amount_cents: 1,
    }), { timeZone: "America/Chicago", now: new Date("2026-08-14T12:00:00Z") });

    expect(prepared.responses).not.toHaveProperty("total_amount_cents");
    expect(prepared.issues).toContainEqual(expect.objectContaining({ code: "UNKNOWN_FIELD", key: "total_amount_cents" }));
    expect(prepared.isValid).toBe(false);
  });

  it("requires conditional fields only when their controlling answer shows them", () => {
    const missingVisible = preparePublicRegistration(definitionFixture(), input({
      first_name: "Avery",
      last_name: "Tester",
      email: "avery@example.test",
      stay_type: "Hotel",
      payment_method: "Pay later",
    }), { timeZone: "America/Chicago", now: new Date("2026-08-14T12:00:00Z") });
    expect(missingVisible.issues).toContainEqual(expect.objectContaining({ code: "INVALID_RESPONSE", key: "hotel_details" }));

    const hidden = preparePublicRegistration(definitionFixture(), input({
      first_name: "Avery",
      last_name: "Tester",
      email: "avery@example.test",
      stay_type: "Commuting",
      hotel_details: "Ignore me",
      payment_method: "Pay later",
    }), { timeZone: "America/Chicago", now: new Date("2026-08-14T12:00:00Z") });
    expect(hidden.responses).not.toHaveProperty("hotel_details");
    expect(hidden.issues.some((issue) => issue.key === "hotel_details")).toBe(false);
    expect(hidden.isValid).toBe(true);
  });

  it("recomputes late pricing and the grossed-up card fee on the server date", () => {
    const prepared = preparePublicRegistration(definitionFixture(), input({
      first_name: "Avery",
      last_name: "Tester",
      email: "avery@example.test",
      stay_type: "Commuting",
      payment_method: "Credit / debit card",
    }), { timeZone: "America/Chicago", now: new Date("2026-08-15T05:00:00Z") });

    expect(prepared.pricingDate).toBe("2026-08-15");
    expect(prepared.calculation).toMatchObject({ subtotalCents: 14500, processingFeeCents: 464, totalCents: 14964 });
    expect(prepared.calculation.lineItems[0]).toMatchObject({ pricingLabel: "Late registration pricing" });
  });

  it("extracts normalized contact identity and falls back to a common full-name key", () => {
    const direct = preparePublicRegistration(definitionFixture(), input({
      first_name: "Avery",
      last_name: "Tester",
      email: "AVERY@EXAMPLE.TEST",
      phone: " 555-0100 ",
      stay_type: "Commuting",
      payment_method: "Pay later",
    }), { timeZone: "America/Chicago", now: new Date("2026-08-14T12:00:00Z") });
    expect(direct.identity).toEqual({ firstName: "Avery", lastName: "Tester", email: "avery@example.test", phone: "555-0100" });

    const fullNameDefinition = definitionFixture();
    const fields = fullNameDefinition.sections[0].fields;
    fullNameDefinition.sections[0].fields = fields.filter((field) => field.key !== "first_name" && field.key !== "last_name");
    fullNameDefinition.sections[0].fields.unshift({ id: "name_field", key: "name", label: "Name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] });
    const fallback = preparePublicRegistration(fullNameDefinition, input({
      name: "Mary Ann Smith",
      email: "mary@example.test",
      stay_type: "Commuting",
      payment_method: "Pay later",
    }), { timeZone: "America/Chicago", now: new Date("2026-08-14T12:00:00Z") });
    expect(fallback.identity).toMatchObject({ firstName: "Mary", lastName: "Ann Smith", email: "mary@example.test" });
  });

  it("returns contact configuration and validation issues when identity cannot be derived", () => {
    const missingValues = preparePublicRegistration(definitionFixture(), input({
      stay_type: "Commuting",
      payment_method: "Pay later",
    }), { timeZone: "America/Chicago", now: new Date("2026-08-14T12:00:00Z") });
    expect(missingValues.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "validation", code: "CONTACT_EMAIL_REQUIRED" }),
      expect.objectContaining({ kind: "validation", code: "CONTACT_NAME_REQUIRED" }),
    ]));
    expect(missingValues.identity).toBeNull();

    const unconfigured = definitionFixture();
    unconfigured.sections[0].fields = unconfigured.sections[0].fields.filter((field) => !["first_name", "last_name", "email"].includes(field.key));
    const noContactConfiguration = preparePublicRegistration(unconfigured, input({
      stay_type: "Commuting",
      payment_method: "Pay later",
    }), { timeZone: "America/Chicago", now: new Date("2026-08-14T12:00:00Z") });
    expect(noContactConfiguration.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "configuration", code: "CONTACT_EMAIL_REQUIRED" }),
      expect.objectContaining({ kind: "configuration", code: "CONTACT_NAME_REQUIRED" }),
    ]));
  });

  it("strictly rejects client-owned totals, statuses, invalid keys, and a filled honeypot", () => {
    const base = { versionId: "form-version-1", idempotencyKey, responses: {} };
    expect(publicRegistrationInputSchema.safeParse({ ...base, totalAmountCents: 1 }).success).toBe(false);
    expect(publicRegistrationInputSchema.safeParse({ ...base, status: "CONFIRMED" }).success).toBe(false);
    expect(publicRegistrationInputSchema.safeParse({ ...base, idempotencyKey: "not-a-uuid" }).success).toBe(false);
    expect(publicRegistrationInputSchema.safeParse({ ...base, website: "bot.example" }).success).toBe(false);
    expect(publicRegistrationInputSchema.parse({ ...base, website: "" })).toMatchObject({ website: "" });
  });
});
