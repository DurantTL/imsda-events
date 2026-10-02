import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { applyEventTemplate } from "@/modules/event-templates/repository";
import { parseEventTemplatePayload, validateEventTemplatePayloadReferences } from "@/modules/event-templates/domain";
import { starterDescription, starterEventTemplates, starterPayload } from "@/modules/event-templates/starters";
import { formTemplates, getFormTemplate, registrationFormDefinitionSchema, validateTestResponses } from "@/modules/forms/definition";
import { getFeeWarnings, getLocationDateWarnings, unpricedFeeFieldLabels } from "@/modules/events/readiness";
import { collectEventReadinessWarnings } from "@/modules/events/readiness-warnings";

/** Fall Camporee starter (#593). Synthetic data only. */

const starter = starterEventTemplates.find((entry) => entry.starterKey === "fall_camporee")!;
const form = getFormTemplate("fall_camporee")!;
const fields = form.definition.sections.flatMap((section) => section.fields);
const springFields = getFormTemplate("spring_camporee_export")!.definition.sections.flatMap((section) => section.fields);

describe("Fall Camporee form template", () => {
  it("validates against the form schema and is listed after Spring Camporee", () => {
    expect(registrationFormDefinitionSchema.safeParse(form.definition).success).toBe(true);
    const keys = formTemplates.map((template) => template.key);
    expect(keys.indexOf("fall_camporee")).toBe(keys.indexOf("spring_camporee_export") + 1);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("takes the club, camping and roster fields from Spring and drops the Spring-only sections", () => {
    const keys = fields.map((field) => field.key);
    for (const key of ["club_name", "director_name", "email", "phone", "tents", "kitchen_canopy", "first_name", "last_name", "attendee_age", "attendee_type"]) {
      expect(keys).toContain(key);
    }
    const springRoster = springFields.filter((field) => field.scope === "ATTENDEE" && field.key !== "registration_fee").map((field) => field.key);
    const fallRoster = fields.filter((field) => field.scope === "ATTENDEE" && field.key !== "registration_fee").map((field) => field.key);
    expect(fallRoster).toEqual(springRoster);
    for (const key of ["duty_areas", "special_activities", "sponsoring_meals", "meal_sponsorship_count", "baptism_names", "bible_names", "trailers", "total_sqft"]) {
      expect(keys).not.toContain(key);
    }
  });

  it("has the release and background-check acknowledgments as required checkboxes, and nothing about driving", () => {
    for (const key of ["photo_video_release", "background_check_acknowledgment"]) {
      const field = fields.find((entry) => entry.key === key)!;
      expect(field.type).toBe("CHECKBOX");
      expect(field.required).toBe(true);
    }
    expect(JSON.stringify(form)).not.toMatch(/driv/i);
  });

  it("sets no prices: the fee field has no amount and there is no late pricing", () => {
    const fee = fields.find((field) => field.key === "registration_fee")!;
    expect(fee.type).toBe("CALCULATED");
    expect(fee.label).toBe("Fall Camporee fee");
    expect(fee.priceCents).toBeUndefined();
    expect(fee.latePricing).toBeUndefined();
    expect(JSON.stringify(form)).not.toMatch(/priceCents|choicePricesCents|creditCentsPerUnit|\$\d/);
  });

  it("can be test-submitted with a synthetic club and roster", () => {
    const registration = validateTestResponses(form.definition, {
      director_name: "Alex Sample",
      email: "director@example.test",
      phone: "555-0100",
      tents: "Two 10x10",
      kitchen_canopy: "10x10 canopy",
      photo_video_release: true,
      background_check_acknowledgment: true,
    }, {}, "REGISTRATION", { ignoredFieldKeys: ["club_name"] }); // the club list comes from the directory at runtime
    expect(registration.isValid, JSON.stringify(registration.issues)).toBe(true);
    const attendee = validateTestResponses(form.definition, { first_name: "Sam", last_name: "Sample", attendee_age: 12, attendee_type: "Pathfinder" }, {}, "ATTENDEE");
    expect(attendee.isValid, JSON.stringify(attendee.issues)).toBe(true);
    // The acknowledgments are required: leaving them out blocks the submission.
    const missing = validateTestResponses(form.definition, {}, {}, "REGISTRATION");
    expect(missing.issues.map((issue) => issue.key)).toEqual(expect.arrayContaining(["photo_video_release", "background_check_acknowledgment"]));
  });
});

describe("Fall Camporee starter", () => {
  it("is a CLUB, church-billed starter with adult background checks on and two undated locations", () => {
    expect(starter).toMatchObject({ name: "Fall Camporee", audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", checksAdultBackgrounds: true, formTemplateKey: "fall_camporee" });
    const payload = parseEventTemplatePayload(starterPayload(starter));
    expect(() => validateEventTemplatePayloadReferences(payload)).not.toThrow();
    expect(payload.locations).toEqual([
      { name: "Iowa", address: null, capacity: null, firstDayOffset: null, lastDayOffset: null, registrationClosesOffset: null },
      { name: "Missouri", address: null, capacity: null, firstDayOffset: null, lastDayOffset: null, registrationClosesOffset: null },
    ]);
    expect(starterDescription(starter)).toContain("Iowa and Missouri");
  });

  it("applying it creates the two locations active with no dates", async () => {
    const eventRow = {
      id: "event-1", name: "Fall Camporee 2027", slug: "fall-camporee-2027",
      startsAt: new Date("2027-10-08T12:00:00.000Z"), endsAt: new Date("2027-10-10T12:00:00.000Z"), timezone: "America/Chicago",
      location: null, capacity: null, publicInfoUrl: null, supportContact: null, hotelName: null, hotelBookingUrl: null, hotelPhone: null,
      hotelGroupName: null, hotelRate: null, hotelInstructions: null, isPublished: false, registrationOpensOn: null, registrationClosesOn: null,
      waitlistEnabled: false, collectsShirtSizes: false, checksAdultBackgrounds: true, attendeeEditPolicy: "VERIFY_EVERY_EDIT",
      billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB", seminarPreferenceClosesOn: null, seminarPreferenceSelfServiceLocked: false,
      autoPromoteWaitlist: false, createdAt: new Date(), updatedAt: new Date(),
    };
    const locationCreateMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ status: "PUBLISHED" }]),
      eventTemplate: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "template-1", name: "Fall Camporee" }) },
      eventTemplateVersion: { findFirst: vi.fn().mockResolvedValue({ id: "version-1", versionNumber: 1, status: "PUBLISHED", payload: starterPayload(starter) }) },
      platformSettings: { upsert: vi.fn().mockResolvedValue({ defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT" }) },
      event: { create: vi.fn().mockResolvedValue(eventRow) },
      eventMembership: { create: vi.fn().mockResolvedValue({}) },
      eventModule: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      eventAttendeeType: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      eventAttendeeClassification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      eventLocation: { createMany: locationCreateMany },
      registrationForm: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "form-1", name: "Fall Camporee" }) },
      eventMessageTemplate: { create: vi.fn().mockResolvedValue({}) },
      eventTemplateApplication: { create: vi.fn().mockResolvedValue({ id: "application-1" }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    dependencies.getPrisma.mockReturnValue({
      eventTemplateApplication: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      event: { findUnique: vi.fn().mockResolvedValue(eventRow) },
      registrationForm: { findMany: vi.fn().mockResolvedValue([]) },
      eventPaymentInstructionVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
    });
    await applyEventTemplate("template-1", "usr_actor", { name: "Fall Camporee 2027", slug: "fall-camporee-2027", startsOn: "2027-10-08", endsOn: "2027-10-10", requestKey: "idempotency-key-0593" });
    const rows = locationCreateMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.name)).toEqual(["Iowa", "Missouri"]);
    expect(rows.every((row) => row.firstDay === null && row.lastDay === null && row.registrationClosesOn === null && row.capacity === null)).toBe(true);
    expect(rows.some((row) => "isActive" in row && row.isActive === false)).toBe(false);
    expect(tx.registrationForm.create).toHaveBeenCalled();
  });
});

describe("starter descriptions tell the truth about prices", () => {
  it("mentions last year's prices only for starters whose form carries prices", () => {
    for (const entry of starterEventTemplates) {
      const description = starterDescription(entry);
      const carries = /"(priceCents|choicePricesCents|creditCentsPerUnit|latePricing|choiceLimits)"/.test(JSON.stringify(getFormTemplate(entry.formTemplateKey)!.definition));
      expect(/keeps last year's prices/.test(description), entry.name).toBe(carries && !entry.locations && !/^blank_/.test(entry.starterKey));
    }
    const byKey = (key: string) => starterDescription(starterEventTemplates.find((entry) => entry.starterKey === key)!);
    expect(byKey("spring_camporee")).toContain("keeps last year's prices");
    expect(byKey("honors_weekend")).not.toContain("last year's prices");
  });
});

describe("Fall Camporee readiness warnings", () => {
  it("flags the fee with the field's own name, and nothing once an amount is set", () => {
    expect(unpricedFeeFieldLabels(form.definition)).toEqual(["Fall Camporee fee"]);
    expect(getFeeWarnings(["Fall Camporee fee"])[0]).toMatchObject({ label: "Set the Fall Camporee fee" });
    const priced = structuredClone(form.definition);
    for (const section of priced.sections) for (const field of section.fields) if (field.key === "registration_fee") field.priceCents = 2500;
    expect(unpricedFeeFieldLabels(priced)).toEqual([]);
  });

  const created = "2027-01-01T12:00:00.000Z";
  const location = (overrides: Partial<{ name: string; firstDay: string | null; lastDay: string | null; isActive: boolean; updatedAt: string }> = {}) => ({
    name: "Iowa", firstDay: null, lastDay: null, isActive: true, createdAt: created, updatedAt: created, ...overrides,
  });

  it("warns for an active, never-edited location with no dates, in the 'until edited' wording", () => {
    const [warning] = getLocationDateWarnings([location()]);
    expect(warning).toMatchObject({ label: "Check the dates for Iowa", detail: "It uses the event's dates until you set its own." });
    // A save within a second of creation still counts as never edited.
    expect(getLocationDateWarnings([location({ updatedAt: "2027-01-01T12:00:00.800Z" })])).toHaveLength(1);
  });

  it("does not warn once staff have saved the location, even with no dates", () => {
    expect(getLocationDateWarnings([location({ updatedAt: "2027-01-02T09:30:00.000Z" })])).toEqual([]);
  });

  it("does not warn when only one date is set, or the location is inactive", () => {
    expect(getLocationDateWarnings([location({ firstDay: "2027-10-15" }), location({ name: "Missouri", lastDay: "2027-10-17" })])).toEqual([]);
    expect(getLocationDateWarnings([location({ isActive: false })])).toEqual([]);
  });

  it("gives no location warning for an event with no locations", () => {
    expect(getLocationDateWarnings([])).toEqual([]);
  });

  it("collects the location and fee warnings, reading the published version over a newer draft", async () => {
    const priced = structuredClone(form.definition);
    for (const section of priced.sections) for (const field of section.fields) if (field.key === "registration_fee") field.priceCents = 2500;
    const prisma = {
      eventLocation: { findMany: vi.fn().mockResolvedValue([location(), location({ name: "Missouri" })]) },
      registrationForm: { findMany: vi.fn()
        .mockResolvedValueOnce([{ id: "form-1", versions: [{ definition: priced }] }, { id: "form-2", versions: [] }])
        .mockResolvedValueOnce([{ id: "form-1", versions: [{ definition: form.definition }] }, { id: "form-2", versions: [{ definition: form.definition }] }]) },
    };
    const warnings = await collectEventReadinessWarnings(prisma as never, "event-1");
    // form-1's published version is priced (its newer draft is ignored); form-2 has only a draft, which is unpriced.
    expect(warnings.map((warning) => warning.label)).toEqual(["Check the dates for Iowa", "Check the dates for Missouri", "Set the Fall Camporee fee"]);
    expect(prisma.registrationForm.findMany).toHaveBeenCalledTimes(2);
  });
});

beforeEach(() => vi.clearAllMocks());
