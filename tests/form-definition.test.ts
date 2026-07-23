import { describe, expect, it } from "vitest";
import { calculateRosterTotal, formTemplates, registrationFormDefinitionSchema, summarizeChoiceUsage, validateTestResponses } from "@/modules/forms/definition";

describe("registration form definitions", () => {
  it("ships valid starter templates", () => {
    expect(formTemplates).toHaveLength(7);
    for (const template of formTemplates) expect(registrationFormDefinitionSchema.safeParse(template.definition).success).toBe(true);
  });

  it("requires an always-visible required name for every repeatable attendee", () => {
    const definition = structuredClone(formTemplates.find((template) => template.key === "womens_retreat_export")!.definition);
    const attendeeName = definition.sections
      .flatMap((section) => section.fields)
      .find((field) => field.scope === "ATTENDEE" && field.key === "first_name")!;
    attendeeName.required = false;

    const result = registrationFormDefinitionSchema.safeParse(definition);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("always-visible required attendee name"))).toBe(true);
    }
  });

  it("rejects duplicate field keys across sections", () => {
    const definition = structuredClone(formTemplates[1].definition);
    definition.sections[1].fields[0].key = definition.sections[0].fields[0].key;
    const result = registrationFormDefinitionSchema.safeParse(definition);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes("already in use"))).toBe(true);
  });

  it("requires choices for select fields", () => {
    const definition = structuredClone(formTemplates[0].definition);
    definition.sections[0].fields[0].type = "SELECT";
    const result = registrationFormDefinitionSchema.safeParse(definition);
    expect(result.success).toBe(false);
  });

  it("requires choices for every choice-based field type", () => {
    for (const type of ["RADIO", "MULTISELECT", "RANKED_CHOICE"] as const) {
      const definition = structuredClone(formTemplates[0].definition);
      definition.sections[0].fields[0].type = type;
      definition.sections[0].fields[0].options = [];
      expect(registrationFormDefinitionSchema.safeParse(definition).success).toBe(false);
    }
  });

  it("validates single, multiple, and ranked choices", () => {
    const definition = structuredClone(formTemplates[0].definition);
    const firstField = definition.sections[0].fields[0];
    firstField.type = "RADIO";
    firstField.options = ["Adult", "Teen"];
    const lastField = definition.sections[0].fields[1];
    lastField.type = "MULTISELECT";
    lastField.options = ["Friday", "Sabbath", "Sunday"];
    lastField.maxSelections = 2;
    const emailField = definition.sections[0].fields[2];
    emailField.type = "RANKED_CHOICE";
    emailField.options = ["Seminar A", "Seminar B", "Seminar C"];
    emailField.maxSelections = 2;

    expect(validateTestResponses(definition, { first_name: "Adult", last_name: ["Friday", "Sunday"], email: ["Seminar B", "Seminar A"] }).isValid).toBe(true);
    const invalid = validateTestResponses(definition, { first_name: "Other", last_name: ["Friday", "Sunday", "Sabbath"], email: ["Seminar A", "Seminar A"] });
    expect(invalid.isValid).toBe(false);
    expect(invalid.issues.map((issue) => issue.key)).toEqual(expect.arrayContaining(["first_name", "last_name", "email"]));
  });

  it("counts ranked demand without blocking preferences at assignment room limits", () => {
    const definition = structuredClone(formTemplates[0].definition);
    const seminar = definition.sections[0].fields[0];
    seminar.type = "RANKED_CHOICE";
    seminar.options = ["Seminar A", "Seminar B", "Seminar C"];
    seminar.minSelections = 2;
    seminar.maxSelections = 2;
    seminar.choiceLimits = { "Seminar A": 2, "Seminar B": 10 };
    const usage = summarizeChoiceUsage(definition, [
      { first_name: ["Seminar A", "Seminar B"] },
      { first_name: ["Seminar B", "Seminar A"] },
    ]);

    expect(usage.first_name["Seminar A"]).toEqual({ total: 2, first: 1, second: 1 });
    expect(usage.first_name["Seminar B"]).toEqual({ total: 2, first: 1, second: 1 });
    const popular = validateTestResponses(definition, { first_name: ["Seminar A", "Seminar C"], last_name: "Tester", email: "tester@example.test" }, usage);
    expect(popular.isValid).toBe(true);
    expect(popular.issues.some((issue) => issue.message.includes("limit of 2"))).toBe(false);
    const available = validateTestResponses(definition, { first_name: ["Seminar B", "Seminar C"], last_name: "Tester", email: "tester@example.test" }, usage);
    expect(available.isValid).toBe(true);
  });

  it("requires the configured number of ranked choices", () => {
    const definition = structuredClone(formTemplates[0].definition);
    const seminar = definition.sections[0].fields[0];
    seminar.type = "RANKED_CHOICE";
    seminar.options = ["Seminar A", "Seminar B", "Seminar C"];
    seminar.minSelections = 2;
    seminar.maxSelections = 2;
    const result = validateTestResponses(definition, { first_name: ["Seminar A"], last_name: "Tester", email: "tester@example.test" });
    expect(result.isValid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("requires 2 choices"))).toBe(true);
  });

  it("validates required fields and email responses", () => {
    const definition = formTemplates[0].definition;
    const missing = validateTestResponses(definition, { first_name: "Avery", email: "bad" });
    expect(missing.isValid).toBe(false);
    expect(missing.issues.map((issue) => issue.key)).toEqual(expect.arrayContaining(["last_name", "email"]));
    const valid = validateTestResponses(definition, { first_name: "Avery", last_name: "Tester", email: "avery@example.test" });
    expect(valid).toEqual({ isValid: true, issues: [] });
  });

  it("validates a conditional field only when its controlling answer shows it", () => {
    const definition = structuredClone(formTemplates.find((template) => template.key === "camp_meeting_export")!.definition);
    const rvDetails = definition.sections[1].fields.find((field) => field.key === "rv_details")!;
    rvDetails.required = true;

    const hidden = validateTestResponses(definition, { housing_selection: "Dorm room" });
    expect(hidden.issues.some((issue) => issue.key === "rv_details")).toBe(false);

    const shown = validateTestResponses(definition, { housing_selection: "RV / camper hookup" });
    expect(shown.issues.some((issue) => issue.key === "rv_details")).toBe(true);
  });

  it("preserves the Women’s Retreat roster, church follow-up, and ranked seminar choices", () => {
    const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;
    const fields = definition.sections.flatMap((section) => section.fields);
    const church = fields.find((field) => field.key === "church")!;
    const churchOther = fields.find((field) => field.key === "church_other")!;
    const attendeeType = fields.find((field) => field.key === "attendee_type")!;
    const rankedSessions = fields.filter((field) => field.type === "RANKED_CHOICE");

    expect(definition.attendeeRoster).toMatchObject({ enabled: true, maxAttendees: 12 });
    expect(church.options).toContain("Other");
    expect(church.options.length).toBeGreaterThan(130);
    expect(churchOther.conditional).toEqual({ fieldKey: "church", operator: "EQUALS", value: "Other" });
    expect(attendeeType.options).toEqual(["Adult", "Teen", "Child"]);
    expect(rankedSessions).toHaveLength(3);
    expect(rankedSessions.every((field) => field.minSelections === 2 && field.maxSelections === 2)).toBe(true);
  });

  it("calculates Man Camp lodging packages per attendee and leaves volunteers free", () => {
    const definition = formTemplates.find((template) => template.key === "man_camp_export")!.definition;
    const packageField = definition.sections.flatMap((section) => section.fields).find((field) => field.key === "registration_package")!;
    const calculation = calculateRosterTotal(
      definition,
      { payment_method: "Cash or check" },
      [
        { first_name: "Paid", last_name: "Guest", registration_package: "Shared cabin — connected restroom" },
        { first_name: "Event", last_name: "Volunteer", registration_package: "Volunteer — no registration fee" },
      ],
      "2026-03-01",
    );

    expect(packageField.availabilityMode).toBe("CAPACITY");
    expect(packageField.choicePricesCents).toMatchObject({
      "Shared cabin — connected restroom": 12000,
      "RV hookup": 9000,
      "Volunteer — no registration fee": 0,
    });
    expect(calculation).toMatchObject({ subtotalCents: 12000, processingFeeCents: 0, totalCents: 12000 });
    expect(calculation.lineItems).toHaveLength(1);
  });

  it("ships Spring Camporee duties, dependent details, and April 11 late pricing", () => {
    const definition = formTemplates.find((template) => template.key === "spring_camporee_export")!.definition;
    const fields = definition.sections.flatMap((section) => section.fields);
    const fee = fields.find((field) => field.key === "registration_fee")!;
    const flagSlots = fields.find((field) => field.key === "flag_slots")!;
    const fridaySpecial = fields.find((field) => field.key === "friday_special_type")!;
    const activities = fields.find((field) => field.key === "special_activities")!;

    expect(flagSlots).toMatchObject({
      availabilityMode: "CAPACITY",
      conditional: { fieldKey: "duty_areas", operator: "INCLUDES", value: "Flag raising / lowering" },
    });
    expect(fridaySpecial.conditional).toEqual({
      fieldKey: "special_activities",
      operator: "INCLUDES",
      value: "Special music, poem or skit — Friday vespers",
    });
    expect(activities.options).toHaveLength(7);
    expect(calculateRosterTotal(definition, {}, [{ first_name: "Pat", last_name: "Finder" }], "2026-04-10").subtotalCents).toBe(900);
    expect(calculateRosterTotal(definition, {}, [{ first_name: "Pat", last_name: "Finder" }], "2026-04-11").subtotalCents).toBe(1400);
    expect(fee.latePricing?.label).toBe("Late registration pricing");
  });

  it("calculates Camp Meeting housing nights and separate adult and child meal tickets", () => {
    const definition = formTemplates.find((template) => template.key === "camp_meeting_export")!.definition;
    const housing = definition.sections[1].fields.find((field) => field.key === "housing_selection")!;
    const calculation = calculateRosterTotal(
      definition,
      {
        housing_selection: "Dorm room",
        dorm_nights: ["Tuesday", "Wednesday", "Thursday", "Friday"],
        breakfast_adult_qty: 2,
        breakfast_child_qty: 1,
        payment_method: "Credit / debit card",
      },
      [{ first_name: "Camp", last_name: "Guest" }],
      "2026-05-01",
    );

    expect(housing.choiceLimits).toEqual({ "RV / camper hookup": 16 });
    expect(calculation).toMatchObject({
      subtotalCents: 12000,
      processingFeeCents: 390,
      totalCents: 12390,
    });
    expect(calculation.lineItems.map((item) => item.key)).toEqual([
      "dorm_nights",
      "breakfast_adult_qty",
      "breakfast_child_qty",
    ]);
  });

  it("calculates priced choices and grosses up the card fee", () => {
    const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;
    const calculation = calculateRosterTotal(
      definition,
      { payment_method: "Credit / debit card" },
      [{ first_name: "Demo", last_name: "Registrant" }],
      "2026-08-14",
    );

    expect(calculation.subtotalCents).toBe(12500);
    expect(calculation.processingFeeCents).toBe(405);
    expect(calculation.totalCents).toBe(12905);
    expect(calculation.lineItems).toEqual([{
      key: "attendees.0.registration_fee",
      label: "Registration fee — Demo Registrant",
      amountCents: 12500,
      attendeeIndex: 0,
      attendeeLabel: "Demo Registrant",
    }]);
  });

  it("does not add the card fee when pay-later is selected", () => {
    const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;
    expect(calculateRosterTotal(
      definition,
      { payment_method: "Pay later" },
      [{ first_name: "Demo", last_name: "Registrant" }],
      "2026-08-14",
    )).toMatchObject({ subtotalCents: 12500, processingFeeCents: 0, totalCents: 12500 });
  });

  it("automatically applies late pricing on the configured calendar date", () => {
    const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;
    const attendee = [{ first_name: "Demo", last_name: "Registrant" }];
    const before = calculateRosterTotal(definition, { payment_method: "Pay later" }, attendee, "2026-08-14");
    const starts = calculateRosterTotal(definition, { payment_method: "Pay later" }, attendee, "2026-08-15");

    expect(before.subtotalCents).toBe(12500);
    expect(before.lineItems[0].pricingLabel).toBeUndefined();
    expect(starts.subtotalCents).toBe(14500);
    expect(starts.lineItems[0].pricingLabel).toBe("Regular registration pricing");
  });

  it("does not count ordinary payment or registration choices as availability", () => {
    const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;
    const usage = summarizeChoiceUsage(definition, [{
      payment_method: "Credit / debit card",
      session_1_preferences: [
        "Color Me Golden: Embracing Life in Every Season",
        "Refined by Fire, Revealed in Beauty",
      ],
    }]);
    expect(usage.payment_method).toBeUndefined();
    expect(usage.session_1_preferences).toBeDefined();
  });

  it("enforces capacity on a single-choice housing option", () => {
    const definition = structuredClone(formTemplates.find((template) => template.key === "camp_meeting_export")!.definition);
    const housing = definition.sections[1].fields.find((field) => field.key === "housing_selection")!;
    housing.choiceLimits = { "Dorm room": 2 };
    const usage = { housing_selection: { "Dorm room": { total: 2, first: 2, second: 0 } } };
    const result = validateTestResponses(definition, { housing_selection: "Dorm room" }, usage);

    expect(result.issues.some((issue) => issue.key === "housing_selection" && issue.message.includes("limit of 2"))).toBe(true);
  });
});
