import { describe, expect, it } from "vitest";
import { getFormTemplate, registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  buildClonePlan,
  canonicalJson,
  cloneAlwaysReset,
  clonePricingSummary,
  cloneDomainKeys,
  cloneRequestInputOf,
  confirmEventCloneInputSchema,
  excludedDomains,
  previewEventCloneInputSchema,
  reviewIssues,
  rewriteFormDefinitionForClone,
  sanitizeSourceForClone,
  type CloneDomainKey,
  type ConfirmEventCloneInput,
  type SourceConfiguration,
} from "@/modules/event-clones/domain";
import { stripPrivateLinks } from "@/modules/event-clones/private-links";

const lateTemplate = getFormTemplate("womens_retreat_export")!.definition;
const capacityTemplate = getFormTemplate("camp_meeting_export")!.definition;

function config(overrides: Partial<SourceConfiguration> = {}): SourceConfiguration {
  return {
    event: { id: "event-src", name: "Annual 2027", slug: "annual-2027", startsOn: "2027-05-05", endsOn: "2027-05-07", isPublished: true },
    eventDetails: {
      location: "Synthetic Lodge", timezone: "America/Denver", publicInfoUrl: null, supportContact: null, tagline: null, subtitle: null, helpEmail: null, calendarCategory: null, showOnCalendar: false,
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
    honorSessions: [{ id: "session-1", name: "Friday", normalizedName: "friday", sortOrder: 0, locationName: null, locationNormalizedName: null }],
    honorOfferings: [{
      id: "offering-1", honorId: "honor-1", honorName: "Knots", sessionId: "session-1", sessionName: "Friday", span: "SINGLE_SESSION",
      capacity: 30, minimumAge: null, perClubLimit: null, teacherName: "", location: "", additionalCostCents: null, requirementNote: "", isActive: true,
      locationName: null, locationNormalizedName: null,
    }],
    locations: [],
    unsupported: { merchandiseProducts: 3, paymentInstructionVersions: 1, messageDeliverySettings: 1, uploadedFiles: 2 },
    ...overrides,
  };
}

const all = Object.fromEntries(cloneDomainKeys.map((key) => [key, true])) as Record<CloneDomainKey, boolean>;
const noDomains = Object.fromEntries(cloneDomainKeys.map((key) => [key, false])) as Record<CloneDomainKey, boolean>;
const fingerprint = "a".repeat(64);

function lateItems() {
  return buildClonePlan(config(), fingerprint).review.latePricing;
}

function limitItems() {
  return buildClonePlan(config(), fingerprint).review.formChoiceLimits;
}

const none = { value: null, none: true } as const;

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    sourceEventId: "event-src",
    expectedFingerprint: fingerprint,
    requestKey: "idempotency-key-0001",
    name: "Annual 2028",
    slug: "annual-2028",
    startsOn: "2028-05-03",
    endsOn: "2028-05-05",
    capacity: none,
    registrationOpensOn: none,
    registrationClosesOn: none,
    include: { ...all },
    formLatePricingDates: lateItems().map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: "2028-03-01" })),
    formChoiceLimits: limitItems().map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, choice: item.choice, limit: 14 })),
    promoCodeWindows: [{ promoCodeId: "promo-1", startsOn: { value: "2028-01-10" }, endsOn: none }],
    honorOfferingCapacities: [{ offeringId: "offering-1", capacity: 25, perClubLimit: null }],
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
    const rewritten = rewriteFormDefinitionForClone(definition, dates, new Map());
    const rewrittenFields = rewritten.sections.flatMap((section) => section.fields).filter((field) => field.latePricing);
    expect(rewrittenFields.map((field) => field.latePricing!.startsOn)).toEqual(fields.map(() => "2028-03-01"));
    expect(rewrittenFields.map((field) => field.latePricing!.priceCents)).toEqual(fields.map((field) => field.latePricing!.priceCents));
    expect(definition.sections.flatMap((section) => section.fields).find((field) => field.latePricing)!.latePricing!.startsOn).not.toBe("2028-03-01");
    expect(() => registrationFormDefinitionSchema.parse(rewritten)).not.toThrow();
  });

  const definition = registrationFormDefinitionSchema.parse(capacityTemplate);
  const limited = definition.sections.flatMap((section) => section.fields).find((field) => Object.keys(field.choiceLimits ?? {}).length > 0)!;
  const [choice, sourceLimit] = Object.entries(limited.choiceLimits!)[0]!;
  const rewrittenField = (limits: Map<string, Map<string, number | null>>) => rewriteFormDefinitionForClone(definition, new Map(), limits)
    .sections.flatMap((section) => section.fields).find((field) => field.key === limited.key)!;

  it("writes the reviewed choice limit and keeps the choices and availability mode", () => {
    expect(choice).toBe("RV / camper hookup");
    expect(sourceLimit).toBe(16);
    const same = rewrittenField(new Map([[limited.key, new Map([[choice, 9]])]]));
    expect(same.choiceLimits).toEqual({ [choice]: 9 });
    expect(same.options).toEqual(limited.options);
    expect(same.availabilityMode).toBe(limited.availabilityMode);
    expect(limited.choiceLimits![choice]).toBe(16);
  });

  it("removes a limit only for a reviewed null, and never carries the source limit forward", () => {
    expect(rewrittenField(new Map([[limited.key, new Map([[choice, null]])]])).choiceLimits).toEqual({});
    // Defensive: a limit with no reviewed entry (refused earlier by reviewIssues) is not the source's 16.
    expect(rewrittenField(new Map()).choiceLimits).toEqual({});
    expect(() => registrationFormDefinitionSchema.parse(rewriteFormDefinitionForClone(definition, new Map(), new Map([[limited.key, new Map([[choice, 9]])]])))).not.toThrow();
  });
});

describe("choice capacity limits in the plan and the review", () => {
  const parse = (overrides: Record<string, unknown> = {}): ConfirmEventCloneInput => confirmEventCloneInputSchema.parse(validBody(overrides));

  it("lists every source choice limit with its old value", () => {
    const items = limitItems();
    expect(items).toContainEqual(expect.objectContaining({ formId: "form-cap", choice: "RV / camper hookup", sourceLimit: 16 }));
    expect(buildClonePlan(config(), fingerprint).domains.find((domain) => domain.key === "registrationForms")!.notes.join(" ")).toContain("entered again");
  });

  it("treats a missing entry as an error and a null as an explicit no limit", () => {
    expect(reviewIssues(config(), parse({ formChoiceLimits: [] })).some((issue) => issue.includes("RV / camper hookup"))).toBe(true);
    const explicitNone = parse({ formChoiceLimits: limitItems().map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, choice: item.choice, limit: null })) });
    expect(reviewIssues(config(), explicitNone)).toEqual([]);
  });

  it("refuses a duplicate, an unknown choice, and a limit for an excluded form", () => {
    const item = limitItems()[0]!;
    const entry = { formId: item.formId, fieldKey: item.fieldKey, choice: item.choice, limit: 3 };
    expect(reviewIssues(config(), parse({ formChoiceLimits: [...limitItems().map((i) => ({ ...entry, choice: i.choice })), entry] })).some((issue) => issue.includes("twice"))).toBe(true);
    expect(reviewIssues(config(), parse({ formChoiceLimits: [...validBody().formChoiceLimits, { ...entry, choice: "Tent pad" }] }))).toHaveLength(1);
    const excluded = parse({ include: { ...all, registrationForms: false }, formLatePricingDates: [] });
    expect(reviewIssues(config(), excluded).some((issue) => issue.includes("not being copied"))).toBe(true);
  });

  it("requires the formChoiceLimits key", () => {
    const body: Record<string, unknown> = validBody();
    delete body.formChoiceLimits;
    expect(confirmEventCloneInputSchema.safeParse(body).success).toBe(false);
    expect(confirmEventCloneInputSchema.safeParse(validBody({ formChoiceLimits: [{ formId: "form-cap", fieldKey: "x", choice: "y" }] })).success).toBe(false);
  });
});

describe("honors per-club limits and minimum age", () => {
  it("lists the old capacity and per-club limit as hints and shows the carried-over minimum age", () => {
    const plan = buildClonePlan(config({ honorOfferings: [{ ...config().honorOfferings[0]!, perClubLimit: 4, minimumAge: 10 }] }), fingerprint);
    expect(plan.review.honorOfferings[0]).toMatchObject({ sourceCapacity: 30, sourcePerClubLimit: 4, minimumAge: 10 });
  });

  it("requires an explicit per-club limit or null in each offering entry", () => {
    expect(confirmEventCloneInputSchema.safeParse(validBody({ honorOfferingCapacities: [{ offeringId: "offering-1", capacity: 25 }] })).success).toBe(false);
    expect(confirmEventCloneInputSchema.safeParse(validBody({ honorOfferingCapacities: [{ offeringId: "offering-1", capacity: 25, perClubLimit: 3 }] })).success).toBe(true);
    expect(confirmEventCloneInputSchema.safeParse(validBody({ honorOfferingCapacities: [{ offeringId: "offering-1", capacity: 25, perClubLimit: 0 }] })).success).toBe(false);
  });
});

describe("explicit none for the event capacity, registration dates, and promo windows", () => {
  it.each([
    ["a bare null capacity", { capacity: null }],
    ["a capacity with no answer", { capacity: { value: null } }],
    ["a capacity that is both a value and none", { capacity: { value: 5, none: true } }],
    ["a bare registration open date", { registrationOpensOn: "2028-01-01" }],
    ["a bare null close date", { registrationClosesOn: null }],
    ["a none that is false", { registrationClosesOn: { value: null, none: false } }],
    ["a promo start left blank", { promoCodeWindows: [{ promoCodeId: "promo-1", startsOn: null, endsOn: none }] }],
    ["a promo end with no answer", { promoCodeWindows: [{ promoCodeId: "promo-1", startsOn: { value: "2028-01-10" }, endsOn: { value: null } }] }],
  ])("refuses %s", (_label, overrides) => {
    expect(confirmEventCloneInputSchema.safeParse(validBody(overrides)).success).toBe(false);
  });

  it("accepts values and explicit nones", () => {
    const parsed = confirmEventCloneInputSchema.parse(validBody({
      capacity: { value: 250 }, registrationOpensOn: { value: "2028-01-01" }, registrationClosesOn: none,
      promoCodeWindows: [{ promoCodeId: "promo-1", startsOn: none, endsOn: none }],
    }));
    expect(parsed.capacity.value).toBe(250);
    expect(parsed.registrationClosesOn.value).toBeNull();
    expect(parsed.promoCodeWindows[0]!.startsOn).toEqual(none);
  });
});

describe("private links in copied text", () => {
  const source = config();
  const sourceId = source.event.id;
  const slug = source.event.slug;
  const markers = {
    manage: "https://events.imsda.test/manage/MARKER-MANAGE-TOKEN",
    adminApi: `https://events.imsda.test/api/events/${sourceId}/exports/roster.csv`,
    asset: `/api/public/events/${slug}/assets/MARKER-ASSET`,
    token: "https://example.test/share?token=MARKER-TOKEN-VALUE&x=1",
    sig: "https://example.test/file?sig=MARKER-SIG-VALUE",
    slug: `https://events.imsda.test/events/${slug}`,
  };
  const safe = "https://example.test/schedule";
  const appOrigins = ["https://events.imsda.test"];
  const lateDefinition = registrationFormDefinitionSchema.parse(lateTemplate);
  const withChoiceText = structuredClone(lateDefinition);
  const choiceField = withChoiceText.sections.flatMap((section) => section.fields).find((field) => field.options.length > 0 && !field.optionSource)!;
  const firstField = withChoiceText.sections[0]!.fields[0]!;
  firstField.helpText = `Update here: ${markers.manage} or ${safe}`;
  choiceField.optionDescriptions = { ...(choiceField.optionDescriptions ?? {}), [choiceField.options[0]!]: `See ${markers.asset} for details.` };
  const markedConfig = config({
    contentSections: [{
      kind: "RESOURCE_LINKS", title: "Links", body: `Roster: ${markers.adminApi}. Schedule: ${safe}. Photos: ${markers.slug}`, position: 1, assetLinkCount: 0,
      links: [
        { label: "Schedule", description: "", url: safe, position: 1 },
        { label: "Shared file", description: "", url: markers.sig, position: 2 },
      ],
    }],
    registrationForms: [{ formId: "form-late", name: "Retreat", slug: "retreat", versionId: "ver-1", versionNumber: 3, definition: withChoiceText }],
    messageTemplates: [{ key: "EVENT_ANNOUNCEMENT", isEnabled: true, versionId: "mv-1", versionNumber: 2, subjectTemplate: "News from {{event_name}}", bodyTemplate: `Hi {{recipient_name}}. Your link: ${markers.token}` }],
  });
  const { config: clean, findings } = sanitizeSourceForClone(markedConfig, appOrigins);
  const cleanJson = JSON.stringify(clean);

  it("finds a marker in section text, a link URL, form help and choice text, and a message body", () => {
    expect(new Set(findings.map((finding) => finding.domain))).toEqual(new Set(["contentSections", "registrationForms", "messageTemplates"]));
    expect(findings).toHaveLength(6);
    expect(findings.some((finding) => finding.location.includes("link \"Shared file\""))).toBe(true);
    expect(findings.some((finding) => finding.location.includes("help"))).toBe(true);
    expect(findings.some((finding) => finding.location.includes("description") && finding.location.includes("choice"))).toBe(true);
    expect(findings.some((finding) => finding.location === "Message EVENT_ANNOUNCEMENT body")).toBe(true);
    expect(findings.some((finding) => finding.reasons.includes("the source event's own address or id"))).toBe(true);
  });

  it("strips each marker from the copy, drops a private link row, and keeps safe links", () => {
    for (const marker of ["MARKER-MANAGE-TOKEN", "MARKER-ASSET", "MARKER-TOKEN-VALUE", "MARKER-SIG-VALUE", `/api/events/${sourceId}/`, `/events/${slug}`]) {
      expect(cleanJson).not.toContain(marker);
    }
    expect(clean.contentSections[0]!.links.map((link) => link.url)).toEqual([safe]);
    expect(clean.contentSections[0]!.body).toContain(safe);
    expect(JSON.stringify(clean.registrationForms[0]!.definition)).toContain(safe);
    expect(clean.messageTemplates[0]!.bodyTemplate).toBe("Hi {{recipient_name}}. Your link:");
    expect(() => registrationFormDefinitionSchema.parse(clean.registrationForms[0]!.definition)).not.toThrow();
  });

  it("never repeats a secret in the plan, and lists each finding as needing review", () => {
    const plan = buildClonePlan(markedConfig, fingerprint, appOrigins);
    expect(plan.review.privateLinks).toHaveLength(6);
    const planJson = JSON.stringify(plan.review.privateLinks);
    for (const secret of ["MARKER-MANAGE-TOKEN", "MARKER-TOKEN-VALUE", "MARKER-SIG-VALUE"]) expect(planJson).not.toContain(secret);
    expect(planJson).toContain("/manage/…");
    expect(plan.domains.find((domain) => domain.key === "messageTemplates")!.notes.join(" ")).toContain("1 private link needs review");
    expect(plan.domains.find((domain) => domain.key === "messageTemplates")!.count).toBe(1);
  });

  it("leaves text without private links unchanged, and ignores a slug inside a longer word", () => {
    const quiet = config({ contentSections: [{ kind: "RICH_TEXT", title: "Hi", body: `Photos at https://example.test/${slug}-photos and ${safe}`, position: 1, links: [], assetLinkCount: 0 }] });
    const result = sanitizeSourceForClone(quiet, appOrigins);
    expect(result.findings).toEqual([]);
    expect(result.config.contentSections[0]!.body).toBe(quiet.contentSections[0]!.body);
  });

  it("drops a private public-info or lodging link from the event details", () => {
    const details = config({ eventDetails: { ...config().eventDetails, publicInfoUrl: markers.slug, hotelBookingUrl: "https://hotel.example.test/book?group=imsda" } });
    const result = sanitizeSourceForClone(details, appOrigins);
    expect(result.config.eventDetails.publicInfoUrl).toBeNull();
    expect(result.config.eventDetails.hotelBookingUrl).toBe("https://hotel.example.test/book?group=imsda");
    expect(result.findings.map((finding) => finding.domain)).toEqual(["eventDetails"]);
  });

  it("scans location, support contact, and the other lodging fields, clearing one left empty", () => {
    const details = config({ eventDetails: {
      ...config().eventDetails, location: "Synthetic Lodge", supportContact: `Questions? ${markers.manage}`,
      hotelName: "Synthetic Inn", hotelPhone: markers.token, hotelGroupName: "IMSDA", hotelRate: "$99",
    } });
    const result = sanitizeSourceForClone(details, appOrigins);
    expect(result.config.eventDetails.supportContact).toBe("Questions?");
    expect(result.config.eventDetails.hotelPhone).toBeNull();
    expect(result.config.eventDetails.location).toBe("Synthetic Lodge");
    expect(result.findings.map((finding) => finding.location)).toEqual(["Support contact", "Lodging phone"]);
  });
});

describe("event info card fields in a clone (#651)", () => {
  const appOrigins = ["https://events.imsda.test"];

  it("carries the tagline, subtitle and help email and each offering's cost and requirement", () => {
    const source = config({
      eventDetails: { ...config().eventDetails, tagline: "Lest We Forget", subtitle: "One form for your club", helpEmail: "help@example.test" },
      honorOfferings: [{ ...config().honorOfferings[0]!, additionalCostCents: 500, requirementNote: "Bring a flashlight" }],
    });
    const result = sanitizeSourceForClone(source, appOrigins);
    expect(result.config.eventDetails).toMatchObject({ tagline: "Lest We Forget", subtitle: "One form for your club", helpEmail: "help@example.test" });
    expect(result.config.honorOfferings[0]).toMatchObject({ additionalCostCents: 500, requirementNote: "Bring a flashlight" });
  });

  it("strips a private link from a class requirement and shows cost and requirement in the review rows", () => {
    const source = config({
      honorOfferings: [{ ...config().honorOfferings[0]!, additionalCostCents: 500, requirementNote: "Bring ID https://events.imsda.test/manage/MARKER-MANAGE-TOKEN" }],
    });
    const result = sanitizeSourceForClone(source, appOrigins);
    expect(result.config.honorOfferings[0]!.requirementNote).not.toContain("MARKER-MANAGE-TOKEN");
    expect(result.findings.some((finding) => finding.domain === "honors")).toBe(true);
    const row = buildClonePlan(result.config, fingerprint).review.honorOfferings[0]!;
    expect(row).toMatchObject({ additionalCostCents: 500, requirementNote: "Bring ID" });
  });

  it("tolerates a source that predates the new columns", () => {
    const base = config();
    const oldDetails: Record<string, unknown> = { ...base.eventDetails };
    for (const key of ["tagline", "subtitle", "helpEmail"]) delete oldDetails[key];
    const oldOffering: Record<string, unknown> = { ...base.honorOfferings[0]! };
    for (const key of ["additionalCostCents", "requirementNote"]) delete oldOffering[key];
    const source = { ...base, eventDetails: oldDetails, honorOfferings: [oldOffering] } as unknown as typeof base;
    const result = sanitizeSourceForClone(source, appOrigins);
    expect(result.config.eventDetails).toMatchObject({ tagline: null, subtitle: null, helpEmail: null });
    expect(result.config.honorOfferings[0]!.requirementNote).toBe("");
    expect(buildClonePlan(result.config, fingerprint).review.honorOfferings[0]).toMatchObject({ additionalCostCents: null, requirementNote: "" });
  });

  it("clears an empty tagline to null like the other optional details", () => {
    const result = sanitizeSourceForClone(config({ eventDetails: { ...config().eventDetails, tagline: "  " } }), appOrigins);
    expect(result.config.eventDetails.tagline).toBeNull();
  });
});

describe("private links: only the app's own links are stripped", () => {
  const context = (slug: string) => ({ sourceEventId: "cmsource123", sourceSlug: slug, appOrigins: ["https://events.imsda.org"] });
  const strip = (text: string, slug = "camp-meeting-2027") => stripPrivateLinks(text, context(slug));

  it.each([
    ["an outside page whose path holds the slug", "https://imsda.org/camp-meeting-2027/photos", "camp-meeting-2027"],
    ["an outside handle that equals the slug", "https://www.youtube.com/@retreat", "retreat"],
    ["an outside page with the slug as a path segment", "https://www.youtube.com/retreat", "retreat"],
    ["an outside manage page", "https://www.adventistgiving.org/manage/recurring", "camp-meeting-2027"],
    ["an app link whose segment only contains the slug", "https://events.imsda.org/events/retreat-2028", "retreat"],
    ["an app page with an unrelated relative path", "/events/other-event", "retreat"],
  ])("keeps %s", (_label, url, slug) => {
    const result = strip(`See ${url} for more.`, slug);
    expect(result.matches).toEqual([]);
    expect(result.text).toBe(`See ${url} for more.`);
  });

  it.each([
    ["an app-origin link to the source", "https://events.imsda.org/events/camp-meeting-2027"],
    ["an app-origin manage link", "https://events.imsda.org/manage/SYNTHETIC-TOKEN"],
    ["a relative manage link", "/manage/SYNTHETIC-TOKEN"],
    ["a relative link to the source", "/events/camp-meeting-2027/register"],
    ["an app-origin link naming the source id", "https://events.imsda.org/more/event-settings?event=cmsource123"],
    ["a token on an outside host", "https://files.example.test/doc?token=SYNTHETIC"],
    ["an access_token on an outside host", "https://files.example.test/doc?access_token=SYNTHETIC"],
    ["a signature on an outside host", "https://files.example.test/doc?signature=SYNTHETIC"],
    ["the source staff API on any host", "https://staging.example.test/api/events/cmsource123/exports"],
  ])("strips %s", (_label, url) => {
    const result = strip(`See ${url} for more.`);
    expect(result.matches).toHaveLength(1);
    expect(result.text).toBe("See for more.");
  });

  it("keeps a stripped markdown link's label as plain text and never leaves [label]()", () => {
    const result = strip("Please [update your booking](/manage/SYNTHETIC-TOKEN) and [see photos](https://imsda.org/camp-meeting-2027/photos).");
    expect(result.text).toBe("Please update your booking and [see photos](https://imsda.org/camp-meeting-2027/photos).");
    expect(result.text).not.toContain("]()");
    expect(result.matches).toHaveLength(1);
  });

  it("keeps trailing punctuation and collapses the spaces a removed link leaves", () => {
    expect(strip("Update at https://events.imsda.org/manage/X.  Thanks!").text).toBe("Update at. Thanks!");
    expect(strip("A  /manage/X  B").text).toBe("A B");
  });

  it("treats the source slug as a whole path segment", () => {
    expect(strip("/events/camp-meeting-2027x").matches).toEqual([]);
    expect(strip("/events/camp-meeting-2027/").matches).toHaveLength(1);
  });
});

describe("prices copied as they are", () => {
  it("counts priced fields, late prices, card fees, and promo codes, and says to review them", () => {
    const summary = clonePricingSummary(config());
    expect(summary.pricedFormFields).toBeGreaterThan(0);
    expect(summary.lateFormFields).toBe(lateItems().length);
    expect(summary.promoCodes).toBe(1);
    const plan = buildClonePlan(config(), fingerprint);
    expect(plan.pricing).toEqual(summary);
    expect(plan.pricingMessage).toMatch(/^Prices copied, review before publishing: /);
    expect(plan.pricingMessage).toContain("1 promo code");
  });

  it("counts only the selected domains, and has no message when nothing priced is copied", () => {
    expect(clonePricingSummary(config(), { registrationForms: false, promoCodes: false })).toEqual({ pricedFormFields: 0, lateFormFields: 0, formsWithCardFees: 0, promoCodes: 0 });
    expect(buildClonePlan(config({ registrationForms: [], promoCodes: [] }), fingerprint).pricingMessage).toBeNull();
  });

  it("says message templates are copied published and keep whether they are enabled", () => {
    expect(cloneAlwaysReset.join(" ")).toMatch(/Message templates .*published.*enabled/);
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
    ["registration closing before it opens", { registrationOpensOn: { value: "2028-04-01" }, registrationClosesOn: { value: "2028-03-01" } }],
    ["registration opening after the event ends", { registrationOpensOn: { value: "2028-06-01" } }],
    ["a zero capacity", { capacity: { value: 0 } }],
    ["a domain left out of the selection", { include: { ...all, promoCodes: undefined } }],
    ["an unknown domain", { include: { ...all, staffAccess: true } }],
    ["a promo code ending before it starts", { promoCodeWindows: [{ promoCodeId: "promo-1", startsOn: { value: "2028-02-01" }, endsOn: { value: "2028-01-01" } }] }],
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
    const issues = reviewIssues(config(), parse({ formLatePricingDates: [], formChoiceLimits: [], promoCodeWindows: [], honorOfferingCapacities: [] }));
    expect(issues.filter((issue) => issue.includes("late-pricing date"))).toHaveLength(lateItems().length);
    expect(issues.some((issue) => issue.includes("promo code EARLY"))).toBe(true);
    expect(issues.some((issue) => issue.includes("Knots (Friday)"))).toBe(true);
  });

  it("refuses a date carried over from the source", () => {
    const item = lateItems()[0]!;
    const issues = reviewIssues(config(), parse({
      formLatePricingDates: lateItems().map((entry) => ({ formId: entry.formId, fieldKey: entry.fieldKey, startsOn: entry.formId === item.formId && entry.fieldKey === item.fieldKey ? item.sourceStartsOn : "2028-03-01" })),
      promoCodeWindows: [{ promoCodeId: "promo-1", startsOn: { value: "2027-01-10" }, endsOn: none }],
    }));
    expect(issues.some((issue) => issue.includes("source event's date"))).toBe(true);
    expect(issues.some((issue) => issue.includes("promo code EARLY"))).toBe(true);
  });

  it("does not ask for values of an excluded domain, and refuses values supplied for one", () => {
    const excluded = parse({ include: { ...noDomains }, formLatePricingDates: [], formChoiceLimits: [], promoCodeWindows: [], honorOfferingCapacities: [] });
    expect(reviewIssues(config(), excluded)).toEqual([]);
    const stray = parse({ include: { ...noDomains } });
    expect(reviewIssues(config(), stray).length).toBeGreaterThanOrEqual(4);
  });

  it("refuses values for things that do not exist on the source", () => {
    const issues = reviewIssues(config(), parse({
      formLatePricingDates: [...lateItems().map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: "2028-03-01" })), { formId: "form-x", fieldKey: "nope", startsOn: "2028-03-01" }],
      honorOfferingCapacities: [{ offeringId: "offering-1", capacity: 25, perClubLimit: null }, { offeringId: "offering-9", capacity: 5, perClubLimit: null }],
    }));
    expect(issues).toHaveLength(2);
  });

  it("does not ask for a form's late-pricing date when its form is unsupported", () => {
    const issues = reviewIssues(config({ registrationForms: [] }), parse({ formLatePricingDates: [], formChoiceLimits: [] }));
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

describe("locations in a clone (#413)", () => {
  const locations = [
    { name: "Camp Heritage 1", address: "1 Synthetic Rd", capacity: 120, sortOrder: 0, firstDay: "2027-05-05", lastDay: "2027-05-06", registrationClosesOn: "2027-04-20" },
    { name: "Des Moines", address: null, capacity: null, sortOrder: 1, firstDay: null, lastDay: null, registrationClosesOn: null },
  ];
  const parse = (overrides: Record<string, unknown> = {}) => confirmEventCloneInputSchema.parse(validBody(overrides));

  it("lists locations as its own domain with a count and how the dates move", () => {
    const plan = buildClonePlan(config({ locations }), fingerprint);
    const domain = plan.domains.find((entry) => entry.key === "locations")!;
    expect(domain.count).toBe(2);
    expect(domain.label).toBe("Locations");
    expect(domain.notes.join(" ")).toContain("same number of days as the event's start date");
  });

  it("counts nothing, with no note, for an event without locations", () => {
    const domain = buildClonePlan(config(), fingerprint).domains.find((entry) => entry.key === "locations")!;
    expect(domain.count).toBe(0);
    expect(domain.notes).toEqual([]);
  });

  it("reads a confirm body from before locations existed as not selecting them", () => {
    const { locations: ignored, ...rest } = all;
    void ignored;
    expect(parse({ include: rest }).include.locations).toBe(false);
    expect(parse({ include: { ...all, locations: true } }).include.locations).toBe(true);
    expect(excludedDomains(parse({ include: rest }).include)).toContain("locations");
  });

  it("needs no dates or capacities entered anew: they move with the event and are copied", () => {
    const source = config({ locations });
    expect(reviewIssues(source, parse({ include: { ...all, locations: true } })).filter((issue) => /location/i.test(issue))).toEqual([]);
    expect(reviewIssues(source, parse({
      include: { ...noDomains, locations: true }, formLatePricingDates: [], formChoiceLimits: [], promoCodeWindows: [], honorOfferingCapacities: [],
    }))).toEqual([]);
  });

  it("keeps the locations in the request a retry is compared against", () => {
    const body = parse({ include: { ...all, locations: true } });
    expect(cloneRequestInputOf(body).include.locations).toBe(true);
    expect(canonicalJson(cloneRequestInputOf(body))).not.toBe(canonicalJson(cloneRequestInputOf(parse({ include: { ...all, locations: false } }))));
  });
});
