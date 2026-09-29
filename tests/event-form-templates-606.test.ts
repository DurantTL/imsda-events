import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { applyEventTemplate } from "@/modules/event-templates/repository";
import { parseEventTemplatePayload, templateBillingMode, validateEventTemplatePayloadReferences } from "@/modules/event-templates/domain";
import { starterDescription, starterEventTemplates, starterPayload } from "@/modules/event-templates/starters";
import { getFeeWarnings, getPaymentOnChurchBilledWarnings, unpricedFeeFieldLabels } from "@/modules/events/readiness";
import { collectEventReadinessWarnings } from "@/modules/events/readiness-warnings";
import {
  calculateFormTotal,
  formTemplates,
  getFormTemplate,
  registrationFormDefinitionSchema,
  resolveResponsibleOrganization,
  templatesForPicker,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import { preparePublicRegistration } from "@/modules/forms/public-domain";
import { listFormTemplates } from "@/modules/forms/repository";
import { withDirectoryOptions } from "@/modules/organizations/directory-form-options";

/** Starters and form templates from the 2026 Fluent Forms (#606). Synthetic data only. */

const starterKeys = ["leadership_weekend", "tlt_retreat", "outdoor_school", "hispanic_institute"] as const;
const addOnKeys = ["tlt_opportunities", "pathfinder_of_the_year", "tlt_of_the_year", "tlt_application", "conference_patches_pins"] as const;
const allKeys = [...starterKeys, ...addOnKeys];

const directory = { clubs: ["Sample Trail Pathfinders", "Sample Creek Pathfinders"], churches: ["Sample Hills SDA Church"] };
const timeZone = "America/Chicago";

function definitionOf(key: string) {
  return getFormTemplate(key)!.definition;
}
function fieldsOf(key: string) {
  return definitionOf(key).sections.flatMap((section) => section.fields);
}
function fieldOf(formKey: string, fieldKey: string) {
  const field = fieldsOf(formKey).find((entry) => entry.key === fieldKey);
  if (!field) throw new Error(`${formKey} has no ${fieldKey} field`);
  return field;
}
/** Test-submits a form the way the public page does: directory choices hydrated, then validated and priced. */
function submit(key: string, responses: Record<string, unknown>, now = new Date("2027-01-15T18:00:00Z"), attendees?: Array<{ clientId: string; responses: Record<string, unknown> }>) {
  const definition = withDirectoryOptions(definitionOf(key), directory);
  return preparePublicRegistration(definition, { responses, attendees, idempotencyKey: "b606-idempotency-key" } as never, { timeZone, now });
}
function calculate(definition: RegistrationFormDefinition, responses: Record<string, unknown>, pricingDate: string) {
  return calculateFormTotal(definition, responses, pricingDate);
}

describe("the #606 form templates", () => {
  it.each(allKeys)("%s validates, has unique keys, and appears in the template list and picker", (key) => {
    const template = getFormTemplate(key)!;
    expect(template).toBeTruthy();
    expect(registrationFormDefinitionSchema.safeParse(template.definition).success).toBe(true);
    expect(listFormTemplates().some((entry) => entry.key === key)).toBe(true);
    expect(templatesForPicker(listFormTemplates(), "GENERAL").some((entry) => entry.key === key)).toBe(true);
    expect(templatesForPicker(listFormTemplates(), "CLUB").some((entry) => entry.key === key)).toBe(true);
    expect(formTemplates.filter((entry) => entry.key === key)).toHaveLength(1);
  });

  it("uses the club and church directories, never hard-coded lists", () => {
    for (const key of allKeys) {
      for (const field of fieldsOf(key).filter((entry) => entry.optionSource)) {
        expect(field.options, `${key} ${field.key}`).toEqual([]);
        expect(field.scope).toBe("REGISTRATION");
        // Every directory field has its "not listed" text fallback.
        expect(fieldsOf(key).some((entry) => entry.key === `${field.key}_other` && entry.conditional?.fieldKey === field.key), `${key} ${field.key}`).toBe(true);
      }
    }
    expect(fieldOf("leadership_weekend", "pathfinder_club").optionSource).toBe("CLUBS_DIRECTORY");
    expect(fieldOf("leadership_weekend", "church_name").optionSource).toBe("CHURCHES_DIRECTORY");
    expect(fieldOf("tlt_retreat", "club_name").optionSource).toBe("CLUBS_DIRECTORY");
    expect(fieldOf("hispanic_institute", "church_name").optionSource).toBe("CHURCHES_DIRECTORY");
    for (const key of ["tlt_opportunities", "pathfinder_of_the_year", "tlt_of_the_year", "tlt_application", "conference_patches_pins"]) expect(fieldOf(key, "club_name").optionSource).toBe("CLUBS_DIRECTORY");
    expect(JSON.stringify(formTemplates.filter((entry) => allKeys.includes(entry.key as never)))).not.toContain("Albany SDA Church");
  });

  it("asks nothing about driving and collects no free-text medical details", () => {
    for (const key of allKeys) {
      expect(JSON.stringify(getFormTemplate(key)), key).not.toMatch(/driv|vehicle|license/i);
      for (const field of fieldsOf(key)) {
        expect(`${field.key} ${field.label}`, `${key} ${field.key}`).not.toMatch(/medical|allerg|insurance|condition|medication|diagnos/i);
        if (/health/i.test(field.key)) expect(field.type).toBe("CHECKBOX");
      }
    }
  });

  it("puts the section description text in the sections and stays inside the field limits", () => {
    const lodging = definitionOf("leadership_weekend").sections.find((section) => section.id === "lw_lodging")!;
    expect(lodging.description).toContain("No pets are allowed at Camp Heritage.");
    expect(fieldOf("leadership_weekend", "training_track").helpText).toContain("proof of attendance to an Area Coordinator");
    expect(fieldOf("leadership_weekend", "meals").helpText).toBe("All meals are vegetarian.");
    expect(definitionOf("outdoor_school").sections.find((section) => section.id === "os_sponsors")!.description).toContain("boys' or girls' cabins");
    expect(definitionOf("tlt_opportunities").description).toContain("get approval from your director before submitting");
  });
});

describe("Pathfinder Leadership Weekend", () => {
  const key = "leadership_weekend";
  const leader = {
    first_name: "Sam", last_name: "Sample", gender: "Male", email: "leader@example.test", club_position: "Counselor", phone: "555-0100", years_as_leader: 3,
    pathfinder_club: "Sample Trail Pathfinders", church_name: "Sample Hills SDA Church", training_track: "Master Guide", induction: "No", teaching_class: "No",
    lodging: "Tent or Camper", church_billing_acknowledgment: true,
  };

  it("has the eight tracks, the three lodging choices and the vegetarian meal checkboxes", () => {
    expect(fieldOf(key, "training_track").options).toHaveLength(8);
    expect(fieldOf(key, "lodging").options).toEqual(["Tent or Camper", "Youth Cabin", "Child under 10"]);
    expect(fieldOf(key, "meals").options).toEqual(["Friday Supper", "Sabbath Breakfast", "Sabbath Lunch", "Sabbath Supper", "Sunday Breakfast"]);
    expect(fieldOf(key, "dietary_needs").options).toEqual(["Vegan", "Gluten Free"]);
    expect(fieldOf(key, "mailing_address").required).toBe(false);
  });

  it("charges the early-bird prices until August 24 and the regular prices from then, with the child price unchanged", () => {
    const definition = definitionOf(key);
    const price = (lodging: string, date: string) => calculate(definition, { lodging }, date).subtotalCents;
    expect([price("Tent or Camper", "2026-08-23"), price("Youth Cabin", "2026-08-23"), price("Child under 10", "2026-08-23")]).toEqual([2500, 3500, 2500]);
    expect([price("Tent or Camper", "2026-08-24"), price("Youth Cabin", "2026-08-24"), price("Child under 10", "2026-08-24")]).toEqual([3500, 4500, 2500]);
  });

  it("can be test-submitted, requires the church-billing agreement, and bills the church, not the club", () => {
    const result = submit(key, leader);
    expect(result.isValid, JSON.stringify(result.issues)).toBe(true);
    expect(result.identity).toMatchObject({ firstName: "Sam", lastName: "Sample", email: "leader@example.test" });
    expect(resolveResponsibleOrganization(result.responses)).toBe("Sample Hills SDA Church");
    const withoutAgreement = submit(key, { ...leader, church_billing_acknowledgment: false });
    expect(withoutAgreement.isValid).toBe(false);
    expect(JSON.stringify(withoutAgreement.issues)).toContain("church_billing_acknowledgment");
    const notListed = submit(key, { ...leader, church_name: "Not listed", church_name_other: "Sample Fellowship" });
    expect(notListed.isValid, JSON.stringify(notListed.issues)).toBe(true);
    expect(resolveResponsibleOrganization(notListed.responses)).toBe("Sample Fellowship");
  });

  it("is a GENERAL starter billed to the church, since individuals register and the church pays later", () => {
    const starter = starterEventTemplates.find((entry) => entry.starterKey === key)!;
    expect(starter).toMatchObject({ audience: "GENERAL", billingMode: "DEFERRED_ORGANIZATION_INVOICE", formTemplateKey: key });
    expect(definitionOf(key).payment).toBeUndefined();
    expect(unpricedFeeFieldLabels(definitionOf(key))).toEqual([]);
  });
});

describe("TLT Retreat", () => {
  const key = "tlt_retreat";
  const participant = {
    first_name: "Tay", last_name: "Sample", email: "tlt@example.test", tlt_year: "Year 2", club_name: "Sample Trail Pathfinders",
    club_director_name: "Alex Sample", club_director_email: "director@example.test", dietary_needs: "Neither",
    application_approved_acknowledgment: true, health_record_acknowledgment: true, chaperone_acknowledgment: true,
  };

  it("has the six TLT years and the four dietary choices, and is free", () => {
    expect(fieldOf(key, "tlt_year").options).toEqual(["Year 1", "Year 2", "Year 3", "Year 4", "Staff/Chaperone", "Area Coordinator/Teacher"]);
    expect(fieldOf(key, "dietary_needs").options).toEqual(["Vegan", "Gluten Free", "Both", "Neither"]);
    expect(JSON.stringify(definitionOf(key))).not.toMatch(/priceCents|choicePricesCents|CALCULATED/);
    const starter = starterEventTemplates.find((entry) => entry.starterKey === key)!;
    expect(starter).toMatchObject({ audience: "GENERAL", billingMode: "ATTENDEE_PAY" });
    expect(calculate(definitionOf(key), participant, "2027-03-01").totalCents).toBe(0);
  });

  it("can be test-submitted; the three acknowledgments are required and the recommendation question is optional", () => {
    const result = submit(key, participant);
    expect(result.isValid, JSON.stringify(result.issues)).toBe(true);
    expect(result.identity?.email).toBe("tlt@example.test");
    for (const acknowledgment of ["application_approved_acknowledgment", "health_record_acknowledgment", "chaperone_acknowledgment"]) {
      expect(fieldOf(key, acknowledgment)).toMatchObject({ type: "CHECKBOX", required: true });
      expect(submit(key, { ...participant, [acknowledgment]: false }).isValid, acknowledgment).toBe(false);
    }
    expect(fieldOf(key, "recommendation_forms")).toMatchObject({ required: false, options: ["Yes", "N/A"] });
    expect(submit(key, { ...participant, recommendation_forms: "Yes" }).isValid).toBe(true);
  });

  it("lets an Area Coordinator or teacher skip the club and director, and nobody else", () => {
    const withoutClub: Record<string, unknown> = { ...participant };
    for (const clubKey of ["club_name", "club_director_name", "club_director_email"]) delete withoutClub[clubKey];
    expect(submit(key, withoutClub).isValid).toBe(false);
    const coordinator = submit(key, { ...withoutClub, tlt_year: "Area Coordinator/Teacher" });
    expect(coordinator.isValid, JSON.stringify(coordinator.issues)).toBe(true);
  });
});

describe("Outdoor School", () => {
  const key = "outdoor_school";
  const registration = { responsible_organization: "Sample Elementary School", contact_name: "Pat Teacher", email: "school@example.test", phone: "555-0101" };
  const students = [
    { clientId: "student-1", responses: { first_name: "Robin", last_name: "Sample", attendee_age: 11, gender: "Female" } },
    { clientId: "student-2", responses: { first_name: "Lee", last_name: "Sample", attendee_age: 12, gender: "Male" } },
  ];

  it("registers students on a roster with name, age and gender, and asks for both sponsors and the sack lunches", () => {
    const definition = definitionOf(key);
    expect(definition.attendeeRoster).toMatchObject({ enabled: true, attendeeLabel: "Student" });
    expect(fieldOf(key, "gender").options).toEqual(["Male", "Female"]);
    for (const sponsor of ["male_sponsor_1", "male_sponsor_2", "female_sponsor_1", "female_sponsor_2"]) expect(fieldOf(key, sponsor).scope).toBe("REGISTRATION");
    expect(fieldOf(key, "sack_lunches_thursday").type).toBe("NUMBER");
    expect(fieldOf(key, "dietary_needs").helpText).toBe("Vegetarian meals will be provided.");
    expect(definition.sections.find((section) => section.id === "os_before")!.description).toBe("Please review the What to Bring list.");
  });

  it("can be test-submitted with a synthetic school and two students, and the school is the billed organization", () => {
    const result = submit(key, registration, undefined, students);
    expect(result.isValid, JSON.stringify(result.issues)).toBe(true);
    expect(result.attendees).toHaveLength(2);
    expect(resolveResponsibleOrganization(result.responses)).toBe("Sample Elementary School");
    expect(submit(key, registration, undefined, []).isValid).toBe(false);
  });

  it("is a GENERAL, deferred-billed starter whose unset fee readiness flags", () => {
    const starter = starterEventTemplates.find((entry) => entry.starterKey === key)!;
    expect(starter).toMatchObject({ audience: "GENERAL", billingMode: "DEFERRED_ORGANIZATION_INVOICE" });
    expect(definitionOf(key).payment).toBeUndefined();
    expect(fieldOf(key, "registration_fee").priceCents).toBeUndefined();
    expect(getFeeWarnings(unpricedFeeFieldLabels(definitionOf(key))).map((warning) => warning.label)).toEqual(["Set the Outdoor School fee"]);
  });
});

describe("Hispanic Institute of Evangelism", () => {
  const key = "hispanic_institute";
  const attendee = {
    first_name: "Ana", last_name: "Sample", church_name: "Sample Hills SDA Church", church_position: "Elder", phone: "555-0102", email: "ana@example.test",
    payment_method: "Credit / debit card",
  };

  it("has the fixed $50 semester item and the platform's card fee, not a custom fee field", () => {
    const fee = fieldOf(key, "registration_fee");
    expect(fee).toMatchObject({ type: "CALCULATED", label: "Semester registration, January to June", priceCents: 5000 });
    const payment = definitionOf(key).payment!;
    expect(payment).toMatchObject({ enabled: true, cardOptionValue: "Credit / debit card", paymentMethodFieldKey: "payment_method", passFeeToRegistrant: true });
    expect(fieldsOf(key).filter((field) => field.type === "CALCULATED")).toHaveLength(1);
    expect(calculate(definitionOf(key), { ...attendee, payment_method: "Pay later" }, "2027-01-10")).toMatchObject({ subtotalCents: 5000, processingFeeCents: 0, totalCents: 5000 });
    const card = calculate(definitionOf(key), attendee, "2027-01-10");
    expect(card.subtotalCents).toBe(5000);
    expect(card.processingFeeCents).toBeGreaterThan(0);
    expect(starterEventTemplates.find((entry) => entry.starterKey === key)).toMatchObject({ audience: "GENERAL", billingMode: "ATTENDEE_PAY" });
    expect(unpricedFeeFieldLabels(definitionOf(key))).toEqual([]);
  });

  it("can be test-submitted, with comments optional", () => {
    const result = submit(key, attendee);
    expect(result.isValid, JSON.stringify(result.issues)).toBe(true);
    expect(result.calculation.subtotalCents).toBe(5000);
    expect(fieldOf(key, "comments").required).toBe(false);
  });
});

describe("TLT Opportunities", () => {
  const key = "tlt_opportunities";
  const tlt = { first_name: "Jo", last_name: "Sample", club_name: "Sample Creek Pathfinders", email: "jo@example.test", phone: "555-0103", need_tlt_shirt: "No", trading_in_old_shirt: "No" };

  it("lists all 21 leadership opportunities, 7 Friday morning events and 12 Oregon Trail stations", () => {
    expect(fieldOf(key, "leadership_opportunities").options).toHaveLength(21);
    expect(fieldOf(key, "friday_morning_events").options).toHaveLength(7);
    expect(fieldOf(key, "oregon_trail_stations").options).toHaveLength(12);
    expect(fieldOf(key, "leadership_opportunities").options.every((option) => option.length <= 120)).toBe(true);
  });

  it("shows the arrival time only for the office option and the praise team role only for the praise team", () => {
    const opportunities = fieldOf(key, "leadership_opportunities").options;
    const office = opportunities[2]!;
    const praise = opportunities[12]!;
    expect(fieldOf(key, "office_arrival_time").conditional).toEqual({ fieldKey: "leadership_opportunities", operator: "INCLUDES", value: office });
    expect(fieldOf(key, "praise_team_role").conditional).toEqual({ fieldKey: "leadership_opportunities", operator: "INCLUDES", value: praise });
    expect(submit(key, { ...tlt, leadership_opportunities: [office] }).isValid).toBe(false);
    expect(submit(key, { ...tlt, leadership_opportunities: [office], office_arrival_time: "3:30 PM" }).isValid).toBe(true);
    expect(submit(key, { ...tlt, leadership_opportunities: [praise] }).isValid).toBe(false);
    expect(submit(key, { ...tlt, leadership_opportunities: [praise], praise_team_role: "Vocals" }).isValid).toBe(true);
    expect(submit(key, { ...tlt, leadership_opportunities: [opportunities[1]!] }).isValid).toBe(true);
  });

  it("asks for shirt type and size only when a shirt or a trade-in is chosen, using the shirt-size options", () => {
    expect(submit(key, tlt).isValid).toBe(true);
    expect(submit(key, { ...tlt, need_tlt_shirt: "Yes" }).isValid).toBe(false);
    expect(submit(key, { ...tlt, need_tlt_shirt: "Yes", shirt_type: "Polo", shirt_size: "Adult L" }).isValid).toBe(true);
    expect(submit(key, { ...tlt, trading_in_old_shirt: "Yes" }).isValid).toBe(false);
    expect(submit(key, { ...tlt, trading_in_old_shirt: "Yes", trade_in_shirt_type: "T-Shirt", trade_in_shirt_size: "Adult 2XL" }).isValid).toBe(true);
    expect(fieldOf(key, "shirt_type").options).toEqual(["Polo", "T-Shirt"]);
  });

  it("carries the closing meeting note and no fees", () => {
    expect(definitionOf(key).confirmationMessage).toContain("meeting Thursday night in the Lodge");
    expect(JSON.stringify(definitionOf(key))).not.toMatch(/priceCents|choicePricesCents|CALCULATED/);
  });
});

describe("Pathfinder of the Year and TLT of the Year nominations", () => {
  const nomination = {
    nominee_name: "Casey Sample", club_name: "Sample Trail Pathfinders", contact_name: "Dana Sample", email: "nominator@example.test", nominee_age: 14,
    meeting_attendance: "95%", good_conduct_award: "No",
    essay_honor: "Synthetic essay A.", essay_service: "Synthetic essay B.", essay_talents: "Synthetic essay C.", essay_serving: "Synthetic essay D.", essay_why: "Synthetic essay E.",
  };

  it("share one shape; only the Pathfinder form offers Ranger classes", () => {
    const shape = (key: string) => fieldsOf(key).map((field) => field.key);
    expect(shape("pathfinder_of_the_year")).toEqual(shape("tlt_of_the_year"));
    expect(fieldOf("pathfinder_of_the_year", "classes_completed").options).toEqual(["Friend", "Friend Adv", "Companion", "Companion Adv", "Explorer", "Explorer Adv", "Ranger", "Ranger Adv"]);
    expect(fieldOf("tlt_of_the_year", "classes_completed").options).toEqual(["Friend", "Friend Adv", "Companion", "Companion Adv", "Explorer", "Explorer Adv"]);
    expect(fieldOf("tlt_of_the_year", "meeting_attendance").options).toEqual(["80%", "85%", "90%", "95%", "100%"]);
    expect(definitionOf("tlt_of_the_year").sections.flatMap((section) => section.fields).filter((field) => field.type === "LONG_TEXT")).toHaveLength(5);
    expect(getFormTemplate("tlt_of_the_year")!.name).toBe("TLT of the Year nomination");
    expect(getFormTemplate("pathfinder_of_the_year")!.name).toBe("Pathfinder of the Year nomination");
  });

  it.each(["pathfinder_of_the_year", "tlt_of_the_year"])("%s can be test-submitted, asks the Good Conduct years only for Yes, and has no fees", (key) => {
    const result = submit(key, nomination);
    expect(result.isValid, JSON.stringify(result.issues)).toBe(true);
    expect(result.identity).toMatchObject({ firstName: "Dana", lastName: "Sample", email: "nominator@example.test" });
    expect(submit(key, { ...nomination, good_conduct_award: "Yes" }).isValid).toBe(false);
    expect(submit(key, { ...nomination, good_conduct_award: "Yes", good_conduct_years: 2, classes_completed: ["Friend", "Explorer Adv"] }).isValid).toBe(true);
    expect(submit(key, { ...nomination, meeting_attendance: "70%" }).isValid).toBe(false);
    expect(submit(key, { ...nomination, essay_why: "" }).isValid).toBe(false);
    expect(JSON.stringify(definitionOf(key))).not.toMatch(/priceCents|choicePricesCents|CALCULATED/);
  });
});

describe("TLT Application", () => {
  const key = "tlt_application";
  const address = { line1: "1 Sample Road", locality: "Sampleville", region: "IA", postalCode: "50000", country: "United States" };
  const application = {
    full_name: "Riley Sample", email: "riley@example.test", grade_coming_school_year: "10th", mailing_address: address, gender: "Female",
    club_name: "Sample Trail Pathfinders", years_in_club: 4, club_director_name: "Alex Sample", club_director_email: "director@example.test",
    meal_preference: "Both", previous_conference_tlt_years: 1,
    why_conference_tlt: "Synthetic answer one.", purpose_of_pathfinders: "Synthetic answer two.", purpose_of_tlt_program: "Synthetic answer three.",
    accuracy_acknowledgment: true, application_approved_acknowledgment: true,
  };

  it("has the personal and club fields, the meal choices, the three questions and the two required acknowledgments", () => {
    expect(fieldOf(key, "mailing_address").type).toBe("ADDRESS");
    expect(fieldOf(key, "gender").options).toEqual(["Male", "Female"]);
    expect(fieldOf(key, "meal_preference").options).toEqual(["Vegan", "Gluten Free", "Both", "Neither"]);
    expect(fieldOf(key, "grade_coming_school_year").type).toBe("TEXT");
    expect(fieldOf(key, "years_in_club").type).toBe("NUMBER");
    expect(fieldOf(key, "previous_conference_tlt_years").type).toBe("NUMBER");
    expect(definitionOf(key).sections.find((section) => section.id === "ta_questions")!.description).toBe("Please answer each question thoughtfully and in your own words.");
    expect(fieldsOf(key).filter((field) => field.type === "LONG_TEXT")).toHaveLength(3);
    for (const acknowledgment of ["accuracy_acknowledgment", "application_approved_acknowledgment"]) expect(fieldOf(key, acknowledgment)).toMatchObject({ type: "CHECKBOX", required: true });
    expect(definitionOf(key).payment).toBeUndefined();
    expect(JSON.stringify(definitionOf(key))).not.toMatch(/priceCents|choicePricesCents|CALCULATED/);
  });

  it("can be test-submitted, with the acknowledgments and the club (or a not-listed club) required", () => {
    const result = submit(key, application);
    expect(result.isValid, JSON.stringify(result.issues)).toBe(true);
    expect(result.identity).toMatchObject({ firstName: "Riley", lastName: "Sample", email: "riley@example.test" });
    expect(submit(key, { ...application, accuracy_acknowledgment: false }).isValid).toBe(false);
    expect(submit(key, { ...application, application_approved_acknowledgment: false }).isValid).toBe(false);
    expect(submit(key, { ...application, club_name: "Not listed" }).isValid).toBe(false);
    expect(submit(key, { ...application, club_name: "Not listed", club_name_other: "Sample Mountain Pathfinders" }).isValid).toBe(true);
    expect(submit(key, { ...application, meal_preference: "Anything" }).isValid).toBe(false);
  });
});

describe("Conference shoulder patches and pins order", () => {
  const key = "conference_patches_pins";
  const address = { line1: "2 Sample Road", locality: "Sampleville", region: "MO", postalCode: "60000", country: "United States" };
  const order = { contact_name: "Morgan Sample", email: "orders@example.test", club_name: "Sample Creek Pathfinders", mailing_address: address, payment_method: "Pay later" };

  it("prices each quantity at its 2026 unit price, so the registration total is the sum of the three lines", () => {
    expect(fieldOf(key, "pathfinder_shoulder_patch_quantity")).toMatchObject({ type: "NUMBER", priceCents: 125, helpText: expect.stringContaining("2 3/8 in H × 3 1/2 in W") });
    expect(fieldOf(key, "pathfinder_conference_pin_quantity")).toMatchObject({ type: "NUMBER", priceCents: 275, helpText: expect.stringContaining("Colorful 1½ inch epoxy pin on gold metal") });
    expect(fieldOf(key, "adventurer_shoulder_patch_quantity")).toMatchObject({ type: "NUMBER", priceCents: 225, helpText: expect.stringContaining("2 in H × 3.13 in W") });
    expect(fieldOf(key, "patches_to_exchange")).toMatchObject({ type: "NUMBER", required: false });
    expect(fieldOf(key, "patches_to_exchange").priceCents).toBeUndefined();
    const total = calculate(definitionOf(key), { ...order, pathfinder_shoulder_patch_quantity: 10, pathfinder_conference_pin_quantity: 4, adventurer_shoulder_patch_quantity: 2 }, "2027-03-01");
    expect(total.lineItems.map((item) => item.amountCents)).toEqual([1250, 1100, 450]);
    expect(total.subtotalCents).toBe(2800);
    expect(calculate(definitionOf(key), order, "2027-03-01").subtotalCents).toBe(0);
    expect(unpricedFeeFieldLabels(definitionOf(key))).toEqual([]);
  });

  it("notes that postage is not included, and takes card payment with the platform's card fee", () => {
    expect(definitionOf(key).description).toBe("Postage not included.");
    expect(definitionOf(key).sections.find((section) => section.id === "cp_order")!.description).toContain("Postage not included.");
    expect(definitionOf(key).payment).toMatchObject({ enabled: true, cardOptionValue: "Credit / debit card", paymentMethodFieldKey: "payment_method" });
    const card = calculate(definitionOf(key), { ...order, payment_method: "Credit / debit card", pathfinder_conference_pin_quantity: 4 }, "2027-03-01");
    expect(card.subtotalCents).toBe(1100);
    expect(card.processingFeeCents).toBeGreaterThan(0);
  });

  it("can be test-submitted, with whole-number quantities only", () => {
    const result = submit(key, { ...order, pathfinder_shoulder_patch_quantity: 3, patches_to_exchange: 2 });
    expect(result.isValid, JSON.stringify(result.issues)).toBe(true);
    expect(result.calculation.subtotalCents).toBe(375);
    expect(submit(key, { ...order, adventurer_shoulder_patch_quantity: 1.5 }).isValid).toBe(false);
    expect(submit(key, { ...order, adventurer_shoulder_patch_quantity: -1 }).isValid).toBe(false);
    expect(submit(key, { ...order, mailing_address: {} }).isValid).toBe(false);
  });
});

describe("the #606 starters", () => {
  const eventRow = {
    id: "event-1", name: "Sample 2027", slug: "sample-2027",
    startsAt: new Date("2027-06-01T12:00:00.000Z"), endsAt: new Date("2027-06-03T12:00:00.000Z"), timezone: "America/Chicago",
    location: null, capacity: null, publicInfoUrl: null, supportContact: null, hotelName: null, hotelBookingUrl: null, hotelPhone: null,
    hotelGroupName: null, hotelRate: null, hotelInstructions: null, isPublished: false, registrationOpensOn: null, registrationClosesOn: null,
    waitlistEnabled: false, collectsShirtSizes: false, checksAdultBackgrounds: false, attendeeEditPolicy: "VERIFY_EVERY_EDIT",
    billingMode: "ATTENDEE_PAY", audience: "GENERAL", seminarPreferenceClosesOn: null, seminarPreferenceSelfServiceLocked: false,
    autoPromoteWaitlist: false, createdAt: new Date(), updatedAt: new Date(),
  };

  it("exist, in the starter list, with stable keys that match their form templates", () => {
    for (const key of starterKeys) {
      const starter = starterEventTemplates.find((entry) => entry.starterKey === key);
      expect(starter, key).toBeTruthy();
      expect(starter!.formTemplateKey).toBe(key);
      expect(starter!.checksAdultBackgrounds).toBe(false);
      expect(starter!.collectsShirtSizes).toBe(false);
      const payload = parseEventTemplatePayload(starterPayload(starter!));
      expect(() => validateEventTemplatePayloadReferences(payload)).not.toThrow();
      expect(payload.formTemplateKeys).toEqual([key]);
      expect(templateBillingMode(payload)).toBe(starter!.billingMode);
    }
    // The add-on forms are form templates only.
    for (const key of addOnKeys) expect(starterEventTemplates.some((entry) => entry.formTemplateKey === key)).toBe(false);
  });

  it("describes prices honestly and stays within the description limit", () => {
    const description = (key: string) => starterDescription(starterEventTemplates.find((entry) => entry.starterKey === key)!);
    expect(description("leadership_weekend")).toContain("keeps last year's prices and late-price dates");
    expect(description("leadership_weekend")).not.toContain("choice limits");
    expect(description("leadership_weekend")).toContain("2026");
    expect(description("hispanic_institute")).toContain("keeps last year's prices.");
    expect(description("hispanic_institute")).toContain("$50 semester registration is the 2026 price");
    expect(description("outdoor_school")).toContain("set the Outdoor School fee on the draft event before publishing");
    expect(description("tlt_retreat")).toContain("The retreat is free");
    for (const key of starterKeys) expect(description(key).length).toBeLessThanOrEqual(2000);
  });

  it.each(starterKeys)("applying %s creates a working draft event with its form and billing", async (key) => {
    const starter = starterEventTemplates.find((entry) => entry.starterKey === key)!;
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ status: "PUBLISHED" }]),
      eventTemplate: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "template-1", name: starter.name }) },
      eventTemplateVersion: { findFirst: vi.fn().mockResolvedValue({ id: "version-1", versionNumber: 1, status: "PUBLISHED", payload: starterPayload(starter) }) },
      platformSettings: { upsert: vi.fn().mockResolvedValue({ defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT" }) },
      event: { create: vi.fn().mockResolvedValue({ ...eventRow, billingMode: starter.billingMode }) },
      eventMembership: { create: vi.fn().mockResolvedValue({}) },
      eventAttendeeType: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      eventAttendeeClassification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      eventLocation: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      registrationForm: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "form-1", name: starter.name }) },
      eventMessageTemplate: { create: vi.fn().mockResolvedValue({}) },
      eventTemplateApplication: { create: vi.fn().mockResolvedValue({ id: "application-1" }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    dependencies.getPrisma.mockReturnValue({
      eventTemplateApplication: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      event: { findUnique: vi.fn().mockResolvedValue({ ...eventRow, billingMode: starter.billingMode }) },
      registrationForm: { findMany: vi.fn().mockResolvedValue([]) },
      eventPaymentInstructionVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
    });
    await applyEventTemplate("template-1", "usr_actor", { name: `${starter.name} 2027`, slug: `${key.replace(/_/g, "-")}-2027`, startsOn: "2027-06-01", endsOn: "2027-06-03", requestKey: `b606-request-key-${key}` });
    expect(tx.event.create.mock.calls[0]![0].data).toMatchObject({ audience: starter.audience, billingMode: starter.billingMode, isPublished: false, checksAdultBackgrounds: false });
    expect(tx.registrationForm.create).toHaveBeenCalledTimes(1);
    expect(tx.eventLocation.createMany).not.toHaveBeenCalled();
  });
});

describe("payment-enabled forms on church-billed events (#606)", () => {
  it("are left out of the picker on a church-billed event only, and say to use an attendee-pay event", () => {
    const templates = listFormTemplates();
    const paying = templates.filter((template) => template.collectsPayment).map((template) => template.key);
    expect(paying).toEqual(expect.arrayContaining(["conference_patches_pins", "hispanic_institute"]));
    const churchBilled = templatesForPicker(templates, "GENERAL", "DEFERRED_ORGANIZATION_INVOICE").map((template) => template.key);
    for (const key of paying) expect(churchBilled).not.toContain(key);
    expect(churchBilled).toContain("tlt_opportunities");
    for (const billingMode of ["ATTENDEE_PAY", undefined]) {
      const keys = templatesForPicker(templates, "GENERAL", billingMode).map((template) => template.key);
      for (const key of paying) expect(keys).toContain(key);
    }
    expect(getFormTemplate("conference_patches_pins")!.description).toContain("Use on an attendee-pay event");
    expect(getFormTemplate("hispanic_institute")!.description).toContain("Use on an attendee-pay event");
  });

  it("are explained by a readiness warning when already attached, and only on a church-billed event", async () => {
    expect(getPaymentOnChurchBilledWarnings("ATTENDEE_PAY", ["Order"])).toEqual([]);
    const [warning] = getPaymentOnChurchBilledWarnings("DEFERRED_ORGANIZATION_INVOICE", ["Conference shoulder patches and pins order"]);
    expect(warning).toMatchObject({ label: "Conference shoulder patches and pins order collects payment on a church-billed event" });
    expect(warning!.detail).toContain("cannot be submitted");
    const forms = [{ id: "form-1", versions: [{ definition: definitionOf("conference_patches_pins") }] }, { id: "form-2", versions: [{ definition: definitionOf("tlt_opportunities") }] }];
    const prisma = { eventLocation: { findMany: vi.fn().mockResolvedValue([]) }, registrationForm: { findMany: vi.fn().mockResolvedValueOnce(forms).mockResolvedValueOnce(forms) } };
    const warnings = await collectEventReadinessWarnings(prisma as never, "event-1", "DEFERRED_ORGANIZATION_INVOICE");
    expect(warnings.map((entry) => entry.label)).toEqual(["Conference shoulder patches and pins order collects payment on a church-billed event"]);
    const quiet = { ...prisma, registrationForm: { findMany: vi.fn().mockResolvedValueOnce(forms).mockResolvedValueOnce(forms) } };
    expect(await collectEventReadinessWarnings(quiet as never, "event-1", "ATTENDEE_PAY")).toEqual([]);
  });
});

describe("number checks (#606)", () => {
  it("years as a leader must be a whole number", () => {
    const key = "leadership_weekend";
    const leader = {
      first_name: "Sam", last_name: "Sample", gender: "Male", email: "leader@example.test", club_position: "Counselor", phone: "555-0100", years_as_leader: 3,
      pathfinder_club: "Sample Trail Pathfinders", church_name: "Sample Hills SDA Church", training_track: "Master Guide", induction: "No", teaching_class: "No",
      lodging: "Tent or Camper", church_billing_acknowledgment: true,
    };
    expect(submit(key, leader).isValid).toBe(true);
    expect(submit(key, { ...leader, years_as_leader: 2.5 }).isValid).toBe(false);
    expect(submit(key, { ...leader, years_as_leader: -1 }).isValid).toBe(false);
  });

  it("a patches order needs at least one item, and the rule is saved with the form", () => {
    const key = "conference_patches_pins";
    const address = { line1: "2 Sample Road", locality: "Sampleville", region: "MO", postalCode: "60000", country: "United States" };
    const order = { contact_name: "Morgan Sample", email: "orders@example.test", club_name: "Sample Creek Pathfinders", mailing_address: address, payment_method: "Pay later" };
    const empty = submit(key, order);
    expect(empty.isValid).toBe(false);
    expect(JSON.stringify(empty.issues)).toContain("Order at least one item.");
    const zeros = submit(key, { ...order, pathfinder_shoulder_patch_quantity: 0, pathfinder_conference_pin_quantity: 0, adventurer_shoulder_patch_quantity: 0 });
    expect(JSON.stringify(zeros.issues)).toContain("Order at least one item.");
    expect(submit(key, { ...order, patches_to_exchange: 2 }).isValid).toBe(false);
    expect(submit(key, { ...order, adventurer_shoulder_patch_quantity: 1 }).isValid).toBe(true);
    expect(registrationFormDefinitionSchema.parse(definitionOf(key)).requireAtLeastOne?.message).toBe("Order at least one item.");
    const broken = structuredClone(definitionOf(key));
    broken.requireAtLeastOne = { fieldKeys: ["no_such_field", "pathfinder_conference_pin_quantity"], message: "Order at least one item." };
    expect(registrationFormDefinitionSchema.safeParse(broken).success).toBe(false);
  });
});

beforeEach(() => vi.clearAllMocks());
