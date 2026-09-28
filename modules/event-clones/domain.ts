import { z } from "zod";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { isEventMessageTemplateKey, validateMessageTemplate } from "@/modules/communications/templates";
import { calendarDateSchema, eventNameSchema, eventSlugSchema } from "@/modules/events/schemas";

/**
 * Reviewed annual event cloning (#157). A clone is a one-time, non-live copy
 * of a prior event's *configuration* into a new DRAFT event. Everything here
 * is pure (no database, no clock) so the preview, the review rules, and the
 * form rewriting can be tested on their own and shared with the client.
 *
 * Lifecycle states (#156) are not built: today's publication model has one
 * flag, `Event.isPublished`, and a clone always starts with it false. Nothing
 * here invents another state.
 */

/** The copyable domains, in the order the preview lists them. Each one is an
 * explicit include/exclude choice; none is implied by another. */
export const cloneDomainKeys = [
  "eventDetails",
  "moduleToggles",
  "contentSections",
  "registrationForms",
  "attendeeTypes",
  "attendeeClassifications",
  "messageTemplates",
  "tags",
  "promoCodes",
  "honors",
] as const;

export type CloneDomainKey = (typeof cloneDomainKeys)[number];

export const cloneDomainLabels: Record<CloneDomainKey, { label: string; description: string }> = {
  eventDetails: {
    label: "Branding and event details",
    description: "Location, time zone, public info link, support contact, calendar category, lodging, audience, and billing mode.",
  },
  moduleToggles: {
    label: "Module settings",
    description: "Waitlist, shirt sizes, adult background checks, and event community settings, exactly as configured on the source.",
  },
  contentSections: {
    label: "Public page content",
    description: "Content sections and their web links, copied unpublished.",
  },
  registrationForms: {
    label: "Registration forms",
    description: "The current published definition of each form, copied as a new draft to review and publish.",
  },
  attendeeTypes: {
    label: "Attendee types",
    description: "Type codes, labels, and age bands.",
  },
  attendeeClassifications: {
    label: "Attendee categories",
    description: "Categories and other classifications attendees can be given.",
  },
  messageTemplates: {
    label: "Message templates",
    description: "The current published subject and body of each event message, and whether it is enabled.",
  },
  tags: {
    label: "Staff tags",
    description: "Tag names, colors, and descriptions (never who was tagged).",
  },
  promoCodes: {
    label: "Promo codes",
    description: "Discount rules copied inactive, with a new date window reviewed for each and usage reset to zero.",
  },
  honors: {
    label: "Honors sessions and classes",
    description: "Class sessions and offerings, each with a capacity you enter anew (never enrollments).",
  },
};

/** What a clone never copies, whatever is selected. Shown in every preview. */
export const cloneNeverCopied = [
  "Registrations, attendees, and their answers",
  "Person and account links",
  "Payments, refunds, and adjustments",
  "Check-ins and attendee passes",
  "Private links and tokens",
  "Outbox and sent messages",
  "Audit history",
  "Protected and medical records",
  "Assignments and rosters",
  "Merchandise orders",
  "Analytics",
  "Participant uploads",
  "Staff access grants (you become the event's administrator)",
] as const;

export type CloneUnsupportedKey = "merchandise" | "paymentInstructions" | "messageDelivery" | "uploadedFiles";

export const cloneUnsupportedLabels: Record<CloneUnsupportedKey, { label: string; reason: string }> = {
  merchandise: {
    label: "Merchandise catalog",
    reason: "Products carry prices, stock, and artwork files that must be reviewed one by one, so they are not copied.",
  },
  paymentInstructions: {
    label: "Approved payment instructions",
    reason: "Payment instructions are approved per event by a person, so they are not copied.",
  },
  messageDelivery: {
    label: "Message delivery settings",
    reason: "Sender addresses and the delivery mode decide who receives real email, so they are set again on the new event.",
  },
  uploadedFiles: {
    label: "Uploaded files and badge artwork",
    reason: "Stored files are not duplicated. Content links that point at an uploaded file are skipped.",
  },
};

// ---------------------------------------------------------------------------
// The source configuration (everything a clone can read from a source event)
// ---------------------------------------------------------------------------

export type SourceEventDetails = {
  location: string | null;
  timezone: string;
  publicInfoUrl: string | null;
  supportContact: string | null;
  calendarCategory: string | null;
  hotelName: string | null;
  hotelBookingUrl: string | null;
  hotelPhone: string | null;
  hotelGroupName: string | null;
  hotelRate: string | null;
  hotelInstructions: string | null;
  audience: "GENERAL" | "CLUB";
  billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE";
};

export type SourceCommunitySettings = {
  isEnabled: boolean;
  allowNewPosts: boolean;
  allowReplies: boolean;
  conductText: string;
  retentionDays: number;
};

export type SourceConfiguration = {
  /** Identity, for the preview header and provenance. */
  event: { id: string; name: string; slug: string; startsOn: string; endsOn: string; isPublished: boolean };
  eventDetails: SourceEventDetails;
  moduleToggles: {
    waitlistEnabled: boolean;
    autoPromoteWaitlist: boolean;
    collectsShirtSizes: boolean;
    checksAdultBackgrounds: boolean;
    community: SourceCommunitySettings | null;
  };
  contentSections: Array<{
    kind: "RICH_TEXT" | "RESOURCE_LINKS";
    title: string;
    body: string;
    position: number;
    links: Array<{ label: string; description: string; url: string; position: number }>;
    /** Links that point at an uploaded file: not copied. */
    assetLinkCount: number;
  }>;
  registrationForms: Array<{
    formId: string;
    name: string;
    slug: string;
    versionId: string;
    versionNumber: number;
    definition: unknown;
  }>;
  /** Forms with no published version: nothing current to copy. */
  formsWithoutPublishedVersion: number;
  attendeeTypes: Array<{
    code: string;
    label: string;
    description: string;
    sortOrder: number;
    isActive: boolean;
    minimumAge: number | null;
    maximumAge: number | null;
  }>;
  attendeeClassifications: Array<{
    kind: "CATEGORY" | string;
    code: string;
    label: string;
    description: string;
    sortOrder: number;
    isActive: boolean;
  }>;
  messageTemplates: Array<{
    key: string;
    isEnabled: boolean;
    versionId: string;
    versionNumber: number;
    subjectTemplate: string;
    bodyTemplate: string;
  }>;
  /** Message templates with no published version. */
  messageTemplatesWithoutPublishedVersion: number;
  tags: Array<{ name: string; normalizedName: string; color: string; description: string; isActive: boolean }>;
  promoCodes: Array<{
    id: string;
    code: string;
    normalizedCode: string;
    discountType: "FIXED_CENTS" | "PERCENT_BPS";
    discountValue: number;
    startsOn: string | null;
    endsOn: string | null;
    minimumSubtotalCents: number | null;
    maximumUses: number | null;
    maximumDiscountCents: number | null;
  }>;
  honorSessions: Array<{ id: string; name: string; normalizedName: string; sortOrder: number }>;
  honorOfferings: Array<{
    id: string;
    honorId: string;
    honorName: string;
    sessionId: string | null;
    sessionName: string | null;
    span: "SINGLE_SESSION" | "ALL_SESSIONS";
    capacity: number;
    minimumAge: number | null;
    perClubLimit: number | null;
    teacherName: string;
    location: string;
    isActive: boolean;
  }>;
  /** Counts of source rows in domains a clone does not support (for the preview only). */
  unsupported: { merchandiseProducts: number; paymentInstructionVersions: number; messageDeliverySettings: number; uploadedFiles: number };
};

// ---------------------------------------------------------------------------
// Forms: what is date-bound or capacity in a definition
// ---------------------------------------------------------------------------

export type FormLatePricingItem = { formId: string; formName: string; fieldKey: string; fieldLabel: string; sourceStartsOn: string };

type ParsedDefinition = ReturnType<typeof registrationFormDefinitionSchema.parse>;

export function parseFormDefinition(value: unknown): ParsedDefinition | null {
  const result = registrationFormDefinitionSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function latePricingItems(formId: string, formName: string, definition: ParsedDefinition): FormLatePricingItem[] {
  return definition.sections.flatMap((section) => section.fields
    .filter((field) => field.latePricing)
    .map((field) => ({ formId, formName, fieldKey: field.key, fieldLabel: field.label, sourceStartsOn: field.latePricing!.startsOn })));
}

export function capacityLimitCount(definition: ParsedDefinition) {
  return definition.sections.reduce((total, section) => total + section.fields.reduce(
    (fieldTotal, field) => fieldTotal + Object.keys(field.choiceLimits ?? {}).length,
    0,
  ), 0);
}

function attendeeTypeFieldCount(definition: ParsedDefinition) {
  return definition.sections.reduce((total, section) => total + section.fields.filter((field) => field.optionSource === "ATTENDEE_TYPES").length, 0);
}

/**
 * The definition a clone stores: the source's current published definition
 * with its date-bound and capacity values reset (#157). Each late-pricing
 * start date is replaced by the date the reviewer supplied, and every choice
 * capacity limit is cleared (the choices, prices, and availability mode stay)
 * so the new event never inherits a prior year's seat counts. Nothing is
 * shifted or guessed.
 */
export function rewriteFormDefinitionForClone(
  definition: ParsedDefinition,
  latePricingDates: ReadonlyMap<string, string>,
): ParsedDefinition {
  const next = structuredClone(definition);
  for (const section of next.sections) {
    for (const field of section.fields) {
      if (field.latePricing) {
        const startsOn = latePricingDates.get(field.key);
        if (startsOn) field.latePricing.startsOn = startsOn;
      }
      if (field.choiceLimits !== undefined) field.choiceLimits = {};
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// The preview plan
// ---------------------------------------------------------------------------

export type ClonePlanDomain = {
  key: CloneDomainKey;
  label: string;
  description: string;
  /** How many items would be copied if this domain is included. */
  count: number;
  /** Extra detail lines for the reviewer (what is reset, what is skipped). */
  notes: string[];
  skipped: Array<{ label: string; reason: string }>;
};

export type ClonePlan = {
  source: SourceConfiguration["event"];
  fingerprint: string;
  domains: ClonePlanDomain[];
  review: {
    latePricing: FormLatePricingItem[];
    promoCodes: Array<{ promoCodeId: string; code: string; sourceStartsOn: string | null; sourceEndsOn: string | null }>;
    honorOfferings: Array<{ offeringId: string; honorName: string; sessionName: string | null; sourceCapacity: number }>;
  };
  /** Values that are always reset on the new draft, whatever is selected. */
  resets: string[];
  unsupported: Array<{ key: CloneUnsupportedKey; label: string; reason: string; sourceCount: number }>;
  neverCopied: readonly string[];
};

/** Always reset on the clone (#157): none is copied and none is shifted. */
export const cloneAlwaysReset = [
  "Publication: the new event is an unpublished draft.",
  "Event dates, registration open and close dates, and the event capacity are entered below.",
  "The seminar preference deadline and lock are cleared.",
  "Public content sections are copied unpublished.",
  "Copied registration forms are new drafts; publish them after review.",
  "Choice capacity limits inside copied forms are cleared.",
] as const;

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function buildClonePlan(config: SourceConfiguration, fingerprint: string): ClonePlan {
  const skippedForms: ClonePlanDomain["skipped"] = [];
  const latePricing: FormLatePricingItem[] = [];
  let capacityLimits = 0;
  let attendeeTypeFields = 0;
  let copyableForms = 0;
  for (const form of config.registrationForms) {
    const definition = parseFormDefinition(form.definition);
    if (!definition) {
      skippedForms.push({ label: form.name, reason: "Its published definition no longer passes the current form rules." });
      continue;
    }
    copyableForms += 1;
    latePricing.push(...latePricingItems(form.formId, form.name, definition));
    capacityLimits += capacityLimitCount(definition);
    attendeeTypeFields += attendeeTypeFieldCount(definition);
  }
  if (config.formsWithoutPublishedVersion > 0) {
    skippedForms.push({ label: plural(config.formsWithoutPublishedVersion, "form"), reason: "No published version to copy." });
  }

  const skippedMessages: ClonePlanDomain["skipped"] = [];
  let copyableMessages = 0;
  for (const template of config.messageTemplates) {
    const valid = isEventMessageTemplateKey(template.key)
      && validateMessageTemplate({ subject: template.subjectTemplate, body: template.bodyTemplate }).issues.length === 0;
    if (valid) copyableMessages += 1;
    else skippedMessages.push({ label: template.key, reason: "Its published text no longer passes the message rules." });
  }
  if (config.messageTemplatesWithoutPublishedVersion > 0) {
    skippedMessages.push({ label: plural(config.messageTemplatesWithoutPublishedVersion, "message template"), reason: "No published version to copy." });
  }

  const assetLinks = config.contentSections.reduce((total, section) => total + section.assetLinkCount, 0);
  const linkCount = config.contentSections.reduce((total, section) => total + section.links.length, 0);
  const moduleCount = 4 + (config.moduleToggles.community ? 1 : 0);

  const notes: Record<CloneDomainKey, string[]> = {
    eventDetails: [],
    moduleToggles: [`${moduleCount - (config.moduleToggles.community ? 1 : 0)} switches${config.moduleToggles.community ? " and community settings" : ""} are copied as they are, on or off.`],
    contentSections: [
      linkCount > 0 ? `${plural(linkCount, "web link")} copied.` : "No web links.",
      ...(assetLinks > 0 ? [`${plural(assetLinks, "link")} to uploaded files will be skipped.`] : []),
    ],
    registrationForms: [
      ...(latePricing.length > 0 ? [`${plural(latePricing.length, "late-pricing date")} need a new date.`] : []),
      ...(capacityLimits > 0 ? [`${plural(capacityLimits, "choice capacity limit")} will be cleared.`] : []),
      ...(attendeeTypeFields > 0 && config.attendeeTypes.length > 0 ? ["Some fields choose from attendee types: include attendee types too."] : []),
    ],
    attendeeTypes: [],
    attendeeClassifications: [],
    messageTemplates: [],
    tags: [],
    promoCodes: config.promoCodes.length > 0 ? ["Copied inactive with usage reset to zero. Each needs a new date window."] : [],
    honors: config.honorOfferings.length > 0 ? ["Each offering needs a capacity you enter anew."] : [],
  };

  const counts: Record<CloneDomainKey, number> = {
    eventDetails: 1,
    moduleToggles: moduleCount,
    contentSections: config.contentSections.length,
    registrationForms: copyableForms,
    attendeeTypes: config.attendeeTypes.length,
    attendeeClassifications: config.attendeeClassifications.length,
    messageTemplates: copyableMessages,
    tags: config.tags.length,
    promoCodes: config.promoCodes.length,
    honors: config.honorOfferings.length,
  };
  const skipped: Record<CloneDomainKey, ClonePlanDomain["skipped"]> = {
    eventDetails: [], moduleToggles: [], contentSections: [], registrationForms: skippedForms, attendeeTypes: [],
    attendeeClassifications: [], messageTemplates: skippedMessages, tags: [], promoCodes: [], honors: [],
  };

  const supportCounts: Record<CloneUnsupportedKey, number> = {
    merchandise: config.unsupported.merchandiseProducts,
    paymentInstructions: config.unsupported.paymentInstructionVersions,
    messageDelivery: config.unsupported.messageDeliverySettings,
    uploadedFiles: config.unsupported.uploadedFiles,
  };

  return {
    source: config.event,
    fingerprint,
    domains: cloneDomainKeys.map((key) => ({
      key,
      label: cloneDomainLabels[key].label,
      description: cloneDomainLabels[key].description,
      count: counts[key],
      notes: notes[key],
      skipped: skipped[key],
    })),
    review: {
      latePricing,
      promoCodes: config.promoCodes.map((promo) => ({ promoCodeId: promo.id, code: promo.code, sourceStartsOn: promo.startsOn, sourceEndsOn: promo.endsOn })),
      honorOfferings: config.honorOfferings.map((offering) => ({
        offeringId: offering.id, honorName: offering.honorName, sessionName: offering.sessionName, sourceCapacity: offering.capacity,
      })),
    },
    resets: [...cloneAlwaysReset],
    unsupported: (Object.keys(cloneUnsupportedLabels) as CloneUnsupportedKey[]).map((key) => ({
      key, ...cloneUnsupportedLabels[key], sourceCount: supportCounts[key],
    })),
    neverCopied: cloneNeverCopied,
  };
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const previewEventCloneInputSchema = z.object({
  sourceEventId: z.string().trim().min(1).max(100),
}).strict();

const includeShape = Object.fromEntries(cloneDomainKeys.map((key) => [key, z.boolean()])) as Record<CloneDomainKey, z.ZodBoolean>;

/**
 * The confirm body (#157). Strict: an unknown key is refused. Every domain is
 * an explicit true/false, and every date-bound or capacity value is a key the
 * caller must send (`null` is a reviewed "none", never an omission), so the
 * clone can never fall back to a silent default or a shifted date. Built from
 * the same rules event settings enforces, so the new event re-saves there
 * unchanged.
 */
export const confirmEventCloneInputSchema = z.object({
  sourceEventId: z.string().trim().min(1).max(100),
  /** Echo of `ClonePlan.fingerprint`: the source configuration the reviewer saw. */
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/, "Preview the source again."),
  requestKey: z.string().trim().min(8).max(200),
  name: eventNameSchema,
  slug: eventSlugSchema,
  startsOn: calendarDateSchema,
  endsOn: calendarDateSchema,
  capacity: z.number().int().min(1).max(100_000).nullable(),
  registrationOpensOn: calendarDateSchema.nullable(),
  registrationClosesOn: calendarDateSchema.nullable(),
  include: z.object(includeShape).strict(),
  formLatePricingDates: z.array(z.object({
    formId: z.string().trim().min(1).max(100),
    fieldKey: z.string().trim().min(1).max(60),
    startsOn: calendarDateSchema,
  }).strict()).max(500).default([]),
  promoCodeWindows: z.array(z.object({
    promoCodeId: z.string().trim().min(1).max(100),
    startsOn: calendarDateSchema.nullable(),
    endsOn: calendarDateSchema.nullable(),
  }).strict()).max(500).default([]),
  honorOfferingCapacities: z.array(z.object({
    offeringId: z.string().trim().min(1).max(100),
    capacity: z.number().int().min(1).max(10_000),
  }).strict()).max(1000).default([]),
}).strict().superRefine((value, context) => {
  if (value.endsOn < value.startsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "The event cannot end before it starts." });
  }
  if (value.registrationOpensOn && value.registrationClosesOn && value.registrationOpensOn > value.registrationClosesOn) {
    context.addIssue({ code: "custom", path: ["registrationClosesOn"], message: "Registration cannot close before it opens." });
  }
  if (value.registrationOpensOn && value.registrationOpensOn > value.endsOn) {
    context.addIssue({ code: "custom", path: ["registrationOpensOn"], message: "Registration cannot open after the event ends." });
  }
  value.promoCodeWindows.forEach((window, index) => {
    if (window.startsOn && window.endsOn && window.startsOn > window.endsOn) {
      context.addIssue({ code: "custom", path: ["promoCodeWindows", index, "endsOn"], message: "A promo code cannot end before it starts." });
    }
  });
});

export type ConfirmEventCloneInput = z.infer<typeof confirmEventCloneInputSchema>;

/** The confirm body without its key: what a retry is compared against. */
export function cloneRequestInputOf(input: ConfirmEventCloneInput) {
  const { requestKey, ...rest } = input;
  void requestKey;
  return rest;
}

/** Thrown when the reviewed values are incomplete for the selected domains. */
export class EventCloneReviewError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Review is incomplete: ${issues.join(" ")}`);
    this.name = "EventCloneReviewError";
  }
}

/**
 * Checks that every date-bound or capacity value the selected domains need
 * was supplied anew (#157), and that nothing was supplied for something that
 * is not being copied. A reused source date is refused: carrying last year's
 * date forward is exactly the silent copy this review exists to stop.
 * Returns every problem at once.
 */
export function reviewIssues(config: SourceConfiguration, input: ConfirmEventCloneInput): string[] {
  const issues: string[] = [];

  const expectedLate = new Map<string, FormLatePricingItem>();
  if (input.include.registrationForms) {
    for (const form of config.registrationForms) {
      const definition = parseFormDefinition(form.definition);
      if (!definition) continue;
      for (const item of latePricingItems(form.formId, form.name, definition)) expectedLate.set(`${item.formId}:${item.fieldKey}`, item);
    }
  }
  const suppliedLate = new Map<string, string>();
  for (const entry of input.formLatePricingDates) {
    const key = `${entry.formId}:${entry.fieldKey}`;
    const item = expectedLate.get(key);
    if (!item) issues.push(`A late-pricing date was supplied for something that is not being copied (${entry.fieldKey}).`);
    else if (suppliedLate.has(key)) issues.push(`The late-pricing date for ${item.fieldLabel} was supplied twice.`);
    else if (entry.startsOn === item.sourceStartsOn) issues.push(`Choose a new late-pricing date for ${item.fieldLabel} on ${item.formName}; it still has the source event's date.`);
    suppliedLate.set(key, entry.startsOn);
  }
  for (const [key, item] of expectedLate) {
    if (!suppliedLate.has(key)) issues.push(`Enter a new late-pricing date for ${item.fieldLabel} on ${item.formName}.`);
  }

  const promoById = new Map(config.promoCodes.map((promo) => [promo.id, promo]));
  const suppliedPromo = new Set<string>();
  for (const window of input.promoCodeWindows) {
    const promo = promoById.get(window.promoCodeId);
    if (!input.include.promoCodes || !promo) issues.push("A promo code window was supplied for a code that is not being copied.");
    else if (suppliedPromo.has(promo.id)) issues.push(`The window for promo code ${promo.code} was supplied twice.`);
    else if ((promo.startsOn && window.startsOn === promo.startsOn) || (promo.endsOn && window.endsOn === promo.endsOn)) {
      issues.push(`Choose new dates for promo code ${promo.code}; a date is still the source event's.`);
    }
    if (promo) suppliedPromo.add(promo.id);
  }
  if (input.include.promoCodes) {
    for (const promo of config.promoCodes) {
      if (!suppliedPromo.has(promo.id)) issues.push(`Enter a date window for promo code ${promo.code} (leave both blank for no window).`);
    }
  }

  const offeringById = new Map(config.honorOfferings.map((offering) => [offering.id, offering]));
  const suppliedOfferings = new Set<string>();
  for (const entry of input.honorOfferingCapacities) {
    const offering = offeringById.get(entry.offeringId);
    if (!input.include.honors || !offering) issues.push("A class capacity was supplied for an offering that is not being copied.");
    else if (suppliedOfferings.has(offering.id)) issues.push(`The capacity for ${offering.honorName} was supplied twice.`);
    if (offering) suppliedOfferings.add(offering.id);
  }
  if (input.include.honors) {
    for (const offering of config.honorOfferings) {
      if (!suppliedOfferings.has(offering.id)) issues.push(`Enter a capacity for ${offering.honorName}${offering.sessionName ? ` (${offering.sessionName})` : ""}.`);
    }
  }
  return issues;
}

/** Recursively sorts object keys so equal configurations serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortKeys(entry)]));
  }
  return value;
}

export function excludedDomains(include: ConfirmEventCloneInput["include"]): CloneDomainKey[] {
  return cloneDomainKeys.filter((key) => !include[key]);
}
