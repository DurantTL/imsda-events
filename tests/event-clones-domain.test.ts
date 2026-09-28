import { describe, expect, it } from "vitest";
import { getFormTemplate, registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  buildClonePlan,
  canonicalJson,
  cloneDomainKeys,
  cloneRequestInputOf,
  confirmEventCloneInputSchema,
  excludedDomains,
  previewEventCloneInputSchema,
  reviewIssues,
  rewriteFormDefinitionForClone,
  type CloneDomainKey,
  type ConfirmEventCloneInput,
  type SourceConfiguration,
} from "@/modules/event-clones/domain";

const lateTemplate = getFormTemplate("womens_retreat_export")!.definition;
const capacityTemplate = getFormTemplate("camp_meeting_export")!.definition;

function config(overrides: Partial<SourceConfiguration> = {}): SourceConfiguration {
  return {
    event: { id: "event-src", name: "Annual 2027", slug: "annual-2027", startsOn: "2027-05-05", endsOn: "2027-05-07", isPublished: true },
    eventDetails: {
      location: "Synthetic Lodge", timezone: "America/Denver", publicInfoUrl: null, supportContact: null, calendarCategory: null,
      hotelName: null, hotelBookingUrl: null, hotelPhone: null, hotelGroupName: null, hotelRate: null, hotelInstructions: null,
      audience: "GENERAL", billingMode: "ATTENDEE_PAY",
    },
    moduleToggles: { waitlistEnabled: true, autoPromoteWaitlist: true, collectsShirtSizes: false, checksAdultBackgrounds: false, community: null },
    contentSections: [{ kind: "RESOURCE_LINKS", title: "Links", body: "", position: 1, links: [{ label: "Schedule", description: "", url: "https://example.test", position: 1 }], assetLinkCount: 2 }],
    registrationForms: [
      { formId: "form-late", name: "Retreat", slug: "retreat", versionId: "ver-1", versionNumber: 3, definition: lateTemplate },
      { formId: "form-cap", name: "Camp", slug: "camp", versionId: "ver-2", versionNumber: 1, definition: capacityTemplate },
      { formId: "form-bad", name: "Broken", slug: "broken", versionId: "ver-3", versionNumber: 1, definition: { nonsense: true } },
    ],
    formsWithoutPublishedVersion: 1,
    attendeeTypes: [{ code: "ADULT", label: "Adult", description: "", sortOrder: 0, isActive: true, minimumAge: 18, maximumAge: null }],
    attendeeClassifications: [],
    messageTemplates: [
      { key: "EVENT_ANNOUNCEMENT", isEnabled: true, versionId: "mv-1", versionNumber: 2, subjectTemplate: "News from {{event_name}}", bodyTemplate: "Hi {{recipient_name}}." },
      { key: "EVENT_ANNOUNCEMENT_STALE", isEnabled: true, versionId: "mv-2", versionNumber: 1, subjectTemplate: "Hi {{not_a_token}}", bodyTemplate: "Body" },
    ],
    messageTemplatesWithoutPublishedVersion: 0,
    tags: [],
    promoCodes: [
      { id: "promo-1", code: "EARLY", normalizedCode: "EARLY", discountType: "FIXED_CENTS", discountValue: 500, startsOn: "2027-01-10", endsOn: "2027-02-10", minimumSubtotalCents: null, maximumUses: null, maximumDiscountCents: null },
    ],
    honorSessions: [{ id: "session-1", name: "Friday", normalizedName: "friday", sortOrder: 0 }],
    honorOfferings: [{
      id: "offering-1", honorId: "honor-1", honorName: "Knots", sessionId: "session-1", sessionName: "Friday", span: "SINGLE_SESSION",
      capacity: 30, minimumAge: null, perClubLimit: null, teacherName: "", location: "", isActive: true,
    }],
    unsupported: { merchandiseProducts: 3, paymentInstructionVersions: 1, messageDeliverySettings: 1, uploadedFiles: 2 },
    ...overrides,
  };
}

const all = Object.fromEntries(cloneDomainKeys.map((key) => [key, true])) as Record<CloneDomainKey, boolean>;
const none = Object.fromEntries(cloneDomainKeys.map((key) => [key, false])) as Record<CloneDomainKey, boolean>;
const fingerprint = "a".repeat(64);

function lateItems() {
  return buildClonePlan(config(), fingerprint).review.latePricing;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    sourceEventId: "event-src",
    expectedFingerprint: fingerprint,
    requestKey: "idempotency-key-0001",
    name: "Annual 2028",
    slug: "annual-2028",
    startsOn: "2028-05-03",
    endsOn: "2028-05-05",
    capacity: null,
    registrationOpensOn: null,
    registrationClosesOn: null,
    include: { ...all },
    formLatePricingDates: lateItems().map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: "2028-03-01" })),
    promoCodeWindows: [{ promoCodeId: "promo-1", startsOn: "2028-01-10", endsOn: null }],
    honorOfferingCapacities: [{ offeringId: "offering-1", capacity: 25 }],
    ...overrides,
  };
}

describe("buildClonePlan", () => {
  const plan = buildClonePlan(config(), fingerprint);

  it("lists every copyable domain, in order, with counts", () => {
    expect(plan.domains.map((domain) => domain.key)).toEqual([...cloneDomainKeys]);
    const count = (key: CloneDomainKey) => plan.domains.find((domain) => domain.key === key)!.count;
    expect(count("registrationForms")).toBe(2);
    expect(count("contentSections")).toBe(1);
    expect(count("attendeeTypes")).toBe(1);
    expect(count("promoCodes")).toBe(1);
    expect(count("honors")).toBe(1);
    expect(plan.fingerprint).toBe(fingerprint);
  });

  it("reports forms that cannot be copied instead of copying them silently", () => {
    const forms = plan.domains.find((domain) => domain.key === "registrationForms")!;
    expect(forms.skipped.map((entry) => entry.label)).toEqual(["Broken", "1 form"]);
  });

  it("skips a message template whose published text no longer validates or whose key is not an event key", () => {
    const messages = plan.domains.find((domain) => domain.key === "messageTemplates")!;
    expect(messages.count).toBe(1);
    expect(messages.skipped).toHaveLength(1);
  });

  it("flags links to uploaded files as skipped, and lists what needs review", () => {
    expect(plan.domains.find((domain) => domain.key === "contentSections")!.notes.join(" ")).toContain("2 links to uploaded files");
    expect(plan.review.latePricing.length).toBeGreaterThan(0);
    expect(plan.review.promoCodes).toEqual([{ promoCodeId: "promo-1", code: "EARLY", sourceStartsOn: "2027-01-10", sourceEndsOn: "2027-02-10" }]);
    expect(plan.review.honorOfferings[0]).toMatchObject({ offeringId: "offering-1", sourceCapacity: 30 });
  });

  it("lists unsupported domains with their source counts and the never-copied list", () => {
    expect(plan.unsupported.map((entry) => [entry.key, entry.sourceCount])).toEqual([
      ["merchandise", 3], ["paymentInstructions", 1], ["messageDelivery", 1], ["uploadedFiles", 2],
    ]);
    expect(plan.neverCopied).toContain("Payments, refunds, and adjustments");
    expect(plan.resets.join(" ")).toContain("unpublished draft");
  });
});

describe("rewriteFormDefinitionForClone", () => {
  it("replaces late-pricing dates with the reviewed ones and touches nothing else", () => {
    const definition = registrationFormDefinitionSchema.parse(lateTemplate);
    const fields = definition.sections.flatMap((section) => section.fields).filter((field) => field.latePricing);
    const dates = new Map(fields.map((field) => [field.key, "2028-03-01"]));
    const rewritten = rewriteFormDefinitionForClone(definition, dates);
    const rewrittenFields = rewritten.sections.flatMap((section) => section.fields).filter((field) => field.latePricing);
    expect(rewrittenFields.map((field) => field.latePricing!.startsOn)).toEqual(fields.map(() => "2028-03-01"));
    expect(rewrittenFields.map((field) => field.latePricing!.priceCents)).toEqual(fields.map((field) => field.latePricing!.priceCents));
    expect(definition.sections.flatMap((section) => section.fields).find((field) => field.latePricing)!.latePricing!.startsOn).not.toBe("2028-03-01");
    expect(() => registrationFormDefinitionSchema.parse(rewritten)).not.toThrow();
  });

  it("clears choice capacity limits but keeps the choices and availability mode", () => {
    const definition = registrationFormDefinitionSchema.parse(capacityTemplate);
    const limited = definition.sections.flatMap((section) => section.fields).find((field) => Object.keys(field.choiceLimits ?? {}).length > 0)!;
    expect(limited).toBeDefined();
    const rewritten = rewriteFormDefinitionForClone(definition, new Map());
    const same = rewritten.sections.flatMap((section) => section.fields).find((field) => field.key === limited.key)!;
    expect(same.choiceLimits).toEqual({});
    expect(same.options).toEqual(limited.options);
    expect(same.availabilityMode).toBe(limited.availabilityMode);
    expect(() => registrationFormDefinitionSchema.parse(rewritten)).not.toThrow();
  });
});

describe("confirmEventCloneInputSchema", () => {
  it("accepts a fully reviewed body and normalizes the slug like event settings", () => {
    const parsed = confirmEventCloneInputSchema.parse(validBody({ slug: "  Annual-2028 " }));
    expect(parsed.slug).toBe("annual-2028");
  });

  it.each([
    ["an unknown key", { extra: true }],
    ["a missing capacity", { capacity: undefined }],
    ["a missing registration open date", { registrationOpensOn: undefined }],
    ["a missing fingerprint", { expectedFingerprint: undefined }],
    ["a malformed fingerprint", { expectedFingerprint: "abc" }],
    ["a short request key", { requestKey: "short" }],
    ["an impossible date", { startsOn: "2028-02-30" }],
    ["an event that ends before it starts", { endsOn: "2028-05-01" }],
    ["registration closing before it opens", { registrationOpensOn: "2028-04-01", registrationClosesOn: "2028-03-01" }],
    ["registration opening after the event ends", { registrationOpensOn: "2028-06-01" }],
    ["a zero capacity", { capacity: 0 }],
    ["a domain left out of the selection", { include: { ...all, promoCodes: undefined } }],
    ["an unknown domain", { include: { ...all, staffAccess: true } }],
    ["a promo code ending before it starts", { promoCodeWindows: [{ promoCodeId: "promo-1", startsOn: "2028-02-01", endsOn: "2028-01-01" }] }],
  ])("rejects %s", (_label, overrides) => {
    const body: Record<string, unknown> = validBody(overrides);
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete body[key];
    expect(confirmEventCloneInputSchema.safeParse(body).success).toBe(false);
  });

  it("requires a source event to preview", () => {
    expect(previewEventCloneInputSchema.safeParse({}).success).toBe(false);
    expect(previewEventCloneInputSchema.safeParse({ sourceEventId: "x", extra: 1 }).success).toBe(false);
    expect(previewEventCloneInputSchema.safeParse({ sourceEventId: "x" }).success).toBe(true);
  });

  it("keeps the request key out of the input a retry is compared against", () => {
    const parsed = confirmEventCloneInputSchema.parse(validBody());
    expect(cloneRequestInputOf(parsed)).not.toHaveProperty("requestKey");
    expect(cloneRequestInputOf(parsed)).toHaveProperty("expectedFingerprint");
  });
});

describe("reviewIssues", () => {
  const parse = (overrides: Record<string, unknown> = {}): ConfirmEventCloneInput => confirmEventCloneInputSchema.parse(validBody(overrides));

  it("accepts a complete review", () => {
    expect(reviewIssues(config(), parse())).toEqual([]);
  });

  it("asks for every missing late-pricing date, promo window, and honor capacity", () => {
    const issues = reviewIssues(config(), parse({ formLatePricingDates: [], promoCodeWindows: [], honorOfferingCapacities: [] }));
    expect(issues.filter((issue) => issue.includes("late-pricing date"))).toHaveLength(lateItems().length);
    expect(issues.some((issue) => issue.includes("promo code EARLY"))).toBe(true);
    expect(issues.some((issue) => issue.includes("Knots (Friday)"))).toBe(true);
  });

  it("refuses a date carried over from the source", () => {
    const item = lateItems()[0]!;
    const issues = reviewIssues(config(), parse({
      formLatePricingDates: lateItems().map((entry) => ({ formId: entry.formId, fieldKey: entry.fieldKey, startsOn: entry.formId === item.formId && entry.fieldKey === item.fieldKey ? item.sourceStartsOn : "2028-03-01" })),
      promoCodeWindows: [{ promoCodeId: "promo-1", startsOn: "2027-01-10", endsOn: null }],
    }));
    expect(issues.some((issue) => issue.includes("source event's date"))).toBe(true);
    expect(issues.some((issue) => issue.includes("promo code EARLY"))).toBe(true);
  });

  it("does not ask for values of an excluded domain, and refuses values supplied for one", () => {
    const excluded = parse({ include: { ...none }, formLatePricingDates: [], promoCodeWindows: [], honorOfferingCapacities: [] });
    expect(reviewIssues(config(), excluded)).toEqual([]);
    const stray = parse({ include: { ...none } });
    expect(reviewIssues(config(), stray).length).toBeGreaterThanOrEqual(3);
  });

  it("refuses values for things that do not exist on the source", () => {
    const issues = reviewIssues(config(), parse({
      formLatePricingDates: [...lateItems().map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: "2028-03-01" })), { formId: "form-x", fieldKey: "nope", startsOn: "2028-03-01" }],
      honorOfferingCapacities: [{ offeringId: "offering-1", capacity: 25 }, { offeringId: "offering-9", capacity: 5 }],
    }));
    expect(issues).toHaveLength(2);
  });

  it("does not ask for a form's late-pricing date when its form is unsupported", () => {
    const issues = reviewIssues(config({ registrationForms: [] }), parse({ formLatePricingDates: [] }));
    expect(issues).toEqual([]);
  });
});

describe("helpers", () => {
  it("canonicalJson is independent of key order and ignores undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(canonicalJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it("lists the domains a selection leaves out", () => {
    expect(excludedDomains({ ...all, tags: false, honors: false })).toEqual(["tags", "honors"]);
    expect(excludedDomains(all)).toEqual([]);
  });
});
