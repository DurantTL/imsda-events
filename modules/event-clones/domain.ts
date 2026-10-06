import { z } from "zod";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { isEventMessageTemplateKey, validateMessageTemplate } from "@/modules/communications/templates";
import { calendarDateSchema, eventNameSchema, eventSlugSchema } from "@/modules/events/schemas";
import { privateLinkReasonLabels, privateLinkValue, stripPrivateLinks, type PrivateLinkContext, type PrivateLinkMatch } from "@/modules/event-clones/private-links";

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
  "locations",
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
    description: "Location, time zone, public info link, support contact, calendar category and whether it shows on the calendar, lodging, audience, and billing mode.",
  },
  locations: {
    label: "Locations",
    description: "Each active location's name, address, capacity, and order. Its dates (first and last day, registration closing) move by the same number of days as the event's start date.",
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
    description: "The current published definition of each form, copied as a new draft to review and publish. Prices, late prices, and card fees are copied as they are.",
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
    description: "The current published subject and body of each event message, copied already published, and whether it is enabled.",
  },
  tags: {
    label: "Staff tags",
    description: "Tag names, colors, and descriptions (never who was tagged).",
  },
  promoCodes: {
    label: "Promo codes",
    description: "Discount rules copied inactive, with a new date window reviewed for each and usage reset to zero. Discount amounts and limits are copied as they are.",
  },
  honors: {
    label: "Honors sessions and classes",
    description: "Class sessions and offerings, each with a capacity and per-club limit you enter anew (never enrollments). Minimum ages carry over.",
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
  tagline: string | null;
  subtitle: string | null;
  helpEmail: string | null;
  calendarCategory: string | null;
  showOnCalendar: boolean;
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
    /**
     * The event's team rules (#809), when it has any. Optional so a source without them reads as before. The age date
     * and the dates of the later levels are for one year, so a copy never carries them.
     */
    teamSettings?: { allowMultipleTeams: boolean; minTeamMembers: number | null; maxTeamMembers: number | null; maxAlternates: number; maxMemberAge: number | null; booksLine: string } | null;
  };
  contentSections: Array<{
    kind: "RICH_TEXT" | "RESOURCE_LINKS" | "NOTICE" | "STEPS" | "CHECKLIST";
    title: string;
    body: string;
    position: number;
    /** Info cards (#652). Absent on older sources, which read as no tone, public page, no items. */
    tone?: "INFO" | "DEADLINE" | "REQUIREMENT" | "SUCCESS" | "HELP" | null;
    placement?: "PUBLIC_PAGE" | "REGISTRATION_FORM" | "BOTH";
    items?: Array<{ title: string; text: string }>;
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
  /** Active locations of a multi-location event (#413); their dates move with the new event's start date. */
  locations: Array<{
    name: string;
    address: string | null;
    capacity: number | null;
    sortOrder: number;
    firstDay: string | null;
    lastDay: string | null;
    registrationClosesOn: string | null;
    /** The location's Area Coordinator (#599); carried to the copy only while still active. */
    coordinatorAccountId?: string | null;
  }>;
  honorSessions: Array<{
    id: string;
    name: string;
    normalizedName: string;
    sortOrder: number;
    /** The site the session is at (#589), matched by name in the new event; null when it has none. */
    locationName: string | null;
    locationNormalizedName: string | null;
  }>;
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
    additionalCostCents: number | null;
    requirementNote: string;
    isActive: boolean;
    locationName: string | null;
    locationNormalizedName: string | null;
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

export type FormChoiceLimitItem = {
  formId: string;
  formName: string;
  fieldKey: string;
  fieldLabel: string;
  choice: string;
  sourceLimit: number;
};

/** Every choice capacity limit in a definition: each one is re-entered on a clone. */
export function choiceLimitItems(formId: string, formName: string, definition: ParsedDefinition): FormChoiceLimitItem[] {
  return definition.sections.flatMap((section) => section.fields.flatMap((field) => Object.entries(field.choiceLimits ?? {})
    .map(([choice, sourceLimit]) => ({ formId, formName, fieldKey: field.key, fieldLabel: field.label, choice, sourceLimit }))));
}

/** One key per (form, field, choice); choices are free text, so no separator is safe. */
export function choiceLimitKey(formId: string, fieldKey: string, choice: string) {
  return JSON.stringify([formId, fieldKey, choice]);
}

function attendeeTypeFieldCount(definition: ParsedDefinition) {
  return definition.sections.reduce((total, section) => total + section.fields.filter((field) => field.optionSource === "ATTENDEE_TYPES").length, 0);
}

/** Priced fields in a definition, for the "prices copied" summary. */
function pricedFieldCounts(definition: ParsedDefinition) {
  const fields = definition.sections.flatMap((section) => section.fields);
  return {
    priced: fields.filter((field) => field.priceCents !== undefined || field.choicePricesCents !== undefined || field.creditCentsPerUnit !== undefined).length,
    latePriced: fields.filter((field) => field.latePricing).length,
    cardFees: definition.payment?.enabled ? 1 : 0,
  };
}

/**
 * The definition a clone stores: the source's current published definition
 * with its date-bound and capacity values replaced by reviewed ones (#157).
 * Each late-pricing start date is the date the reviewer supplied, and each
 * choice capacity limit is the limit the reviewer re-entered (a reviewed
 * `null` removes that choice's limit). Nothing is shifted, guessed, or
 * silently cleared; choices, prices, and the availability mode stay.
 */
export function rewriteFormDefinitionForClone(
  definition: ParsedDefinition,
  latePricingDates: ReadonlyMap<string, string>,
  choiceLimits: ReadonlyMap<string, ReadonlyMap<string, number | null>>,
): ParsedDefinition {
  const next = structuredClone(definition);
  for (const section of next.sections) {
    for (const field of section.fields) {
      if (field.latePricing) {
        const startsOn = latePricingDates.get(field.key);
        if (startsOn) field.latePricing.startsOn = startsOn;
      }
      if (field.choiceLimits !== undefined) {
        const reviewed = choiceLimits.get(field.key);
        const limits: Record<string, number> = {};
        for (const choice of Object.keys(field.choiceLimits)) {
          const limit = reviewed?.get(choice);
          if (typeof limit === "number") limits[choice] = limit;
        }
        field.choiceLimits = limits;
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Private links inside copied text
// ---------------------------------------------------------------------------

export type PrivateLinkFinding = {
  domain: CloneDomainKey;
  /** Where the link was found, in words (never the text around it). */
  location: string;
  /** The link with any token or manage path masked. */
  link: string;
  reasons: string[];
};

/** A confirmation message must stay at least three characters after stripping. */
const strippedConfirmationFallback = "Thank you. Your registration was received.";

/**
 * The source configuration as a clone copies it (#157): every private link in
 * copied free text is found and removed (see `private-links.ts`). Section
 * bodies, content links, form help, placeholder, description, and choice text,
 * message template subjects and bodies, and the event's own info and lodging
 * links are scanned. A private content link row or settings URL is dropped
 * entirely; inside text, only the link itself is removed. Choice values are
 * never rewritten, because prices, limits, and conditions refer to them.
 */
/**
 * A NOTICE whose only content was an uploaded-file link (not copied) and whose
 * text is empty would be copied as an empty card, so the clone drops it.
 */
export function isEmptyAfterClone(section: { kind: string; body: string; links: unknown[]; items?: unknown[] }): boolean {
  return section.kind === "NOTICE" && section.body.trim() === "" && section.links.length === 0;
}

export function sanitizeSourceForClone(
  config: SourceConfiguration,
  appOrigins: readonly string[] = [],
): { config: SourceConfiguration; findings: PrivateLinkFinding[] } {
  const context: PrivateLinkContext = { sourceEventId: config.event.id, sourceSlug: config.event.slug, appOrigins };
  const findings: PrivateLinkFinding[] = [];
  const record = (domain: CloneDomainKey, location: string, matches: PrivateLinkMatch[]) => {
    for (const match of matches) {
      findings.push({ domain, location, link: match.redacted, reasons: match.reasons.map((reason) => privateLinkReasonLabels[reason]) });
    }
  };
  const text = (domain: CloneDomainKey, location: string, value: string) => {
    const result = stripPrivateLinks(value, context);
    record(domain, location, result.matches);
    return result.text;
  };
  /** A nullable detail: stripped like text, and null when nothing is left. */
  const optionalText = (domain: CloneDomainKey, location: string, value: string | null | undefined) => {
    // A source that predates a column gives undefined; treat it as empty.
    if (value === null || value === undefined) return null;
    const next = text(domain, location, value).trim();
    return next.length > 0 ? next : null;
  };
  const url = (domain: CloneDomainKey, location: string, value: string | null) => {
    if (value === null) return null;
    const match = privateLinkValue(value, context);
    if (!match) return value;
    record(domain, location, [match]);
    return null;
  };

  const eventDetails: SourceEventDetails = {
    ...config.eventDetails,
    publicInfoUrl: url("eventDetails", "Public info link", config.eventDetails.publicInfoUrl),
    hotelBookingUrl: url("eventDetails", "Lodging booking link", config.eventDetails.hotelBookingUrl),
    hotelInstructions: optionalText("eventDetails", "Lodging instructions", config.eventDetails.hotelInstructions),
    location: optionalText("eventDetails", "Location", config.eventDetails.location),
    supportContact: optionalText("eventDetails", "Support contact", config.eventDetails.supportContact),
    tagline: optionalText("eventDetails", "Tagline", config.eventDetails.tagline),
    subtitle: optionalText("eventDetails", "Subtitle", config.eventDetails.subtitle),
    helpEmail: optionalText("eventDetails", "Help email", config.eventDetails.helpEmail),
    hotelName: optionalText("eventDetails", "Lodging name", config.eventDetails.hotelName),
    hotelPhone: optionalText("eventDetails", "Lodging phone", config.eventDetails.hotelPhone),
    hotelGroupName: optionalText("eventDetails", "Lodging group name", config.eventDetails.hotelGroupName),
    hotelRate: optionalText("eventDetails", "Lodging rate", config.eventDetails.hotelRate),
  };

  const contentSections = config.contentSections.map((section) => ({
    ...section,
    body: text("contentSections", `Section "${section.title}" text`, section.body),
    // An entry whose title was only a private link has nothing left to show.
    items: section.items
      ?.map((item, index) => ({
        title: text("contentSections", `Section "${section.title}" entry ${index + 1} title`, item.title).trim(),
        text: text("contentSections", `Section "${section.title}" entry ${index + 1} text`, item.text),
      }))
      .filter((item) => item.title !== ""),
    links: section.links.flatMap((link) => {
      if (url("contentSections", `Section "${section.title}" link "${link.label}"`, link.url) === null) return [];
      return [{ ...link, description: text("contentSections", `Section "${section.title}" link "${link.label}" description`, link.description) }];
    }),
  }));

  const registrationForms = config.registrationForms.map((form) => {
    const definition = parseFormDefinition(form.definition);
    if (!definition) return form;
    const next = structuredClone(definition);
    const where = (detail: string) => `Form "${form.name}" ${detail}`;
    next.description = text("registrationForms", where("description"), next.description);
    const confirmation = text("registrationForms", where("confirmation message"), next.confirmationMessage).trim();
    next.confirmationMessage = confirmation.length >= 3 ? confirmation : strippedConfirmationFallback;
    for (const section of next.sections) {
      section.description = text("registrationForms", where(`section "${section.title}" description`), section.description);
      for (const field of section.fields) {
        field.helpText = text("registrationForms", where(`field "${field.label}" help`), field.helpText);
        if (field.placeholder !== undefined) field.placeholder = text("registrationForms", where(`field "${field.label}" placeholder`), field.placeholder);
        for (const [choice, value] of Object.entries(field.optionDescriptions ?? {})) {
          field.optionDescriptions![choice] = text("registrationForms", where(`field "${field.label}" choice "${choice}" description`), value);
        }
        for (const [choice, value] of Object.entries(field.optionLabels ?? {})) {
          const label = text("registrationForms", where(`field "${field.label}" choice "${choice}" label`), value).trim();
          if (label.length > 0) field.optionLabels![choice] = label;
          else delete field.optionLabels![choice];
        }
      }
    }
    return { ...form, definition: next };
  });

  const messageTemplates = config.messageTemplates.map((template) => ({
    ...template,
    subjectTemplate: text("messageTemplates", `Message ${template.key} subject`, template.subjectTemplate),
    bodyTemplate: text("messageTemplates", `Message ${template.key} body`, template.bodyTemplate),
  }));

  // A class requirement is free text; it is scanned like the other copied text.
  const honorOfferings = config.honorOfferings.map((offering) => ({
    ...offering,
    requirementNote: text("honors", `Class ${offering.honorName} requirement`, offering.requirementNote ?? "").trim(),
  }));

  return { config: { ...config, eventDetails, contentSections, registrationForms, messageTemplates, honorOfferings }, findings };
}

// ---------------------------------------------------------------------------
// Prices copied as they are
// ---------------------------------------------------------------------------

export type ClonePricingSummary = {
  /** Form fields that charge a price, a choice price, or a per-unit credit. */
  pricedFormFields: number;
  /** Form fields with a late price. */
  lateFormFields: number;
  /** Forms that take card payments and so carry a card processing fee. */
  formsWithCardFees: number;
  /** Promo codes, each with its discount amount and limits. */
  promoCodes: number;
};

/**
 * What a clone copies without a per-value review (#157): prices, late prices,
 * card fees, and promo discount rules. Copied forms are drafts and copied
 * codes are inactive; those are the human review points, and this summary is
 * shown in the preview and on the result so the reviewer checks them before
 * publishing. Counts only what `include` selects (everything when omitted).
 */
export function clonePricingSummary(
  config: SourceConfiguration,
  include?: Pick<Record<CloneDomainKey, boolean>, "registrationForms" | "promoCodes">,
): ClonePricingSummary {
  const summary: ClonePricingSummary = { pricedFormFields: 0, lateFormFields: 0, formsWithCardFees: 0, promoCodes: 0 };
  if (!include || include.registrationForms) {
    for (const form of config.registrationForms) {
      const definition = parseFormDefinition(form.definition);
      if (!definition) continue;
      const counts = pricedFieldCounts(definition);
      summary.pricedFormFields += counts.priced;
      summary.lateFormFields += counts.latePriced;
      summary.formsWithCardFees += counts.cardFees;
    }
  }
  if (!include || include.promoCodes) summary.promoCodes = config.promoCodes.length;
  return summary;
}

/** The one-line "prices copied" message, or null when nothing priced is copied. */
export function pricingSummaryMessage(summary: ClonePricingSummary) {
  const parts = [
    summary.pricedFormFields > 0 ? plural(summary.pricedFormFields, "priced form field") : null,
    summary.lateFormFields > 0 ? plural(summary.lateFormFields, "late price", "late prices") : null,
    summary.formsWithCardFees > 0 ? plural(summary.formsWithCardFees, "form with card fees", "forms with card fees") : null,
    summary.promoCodes > 0 ? plural(summary.promoCodes, "promo code") : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return `Prices copied, review before publishing: ${parts.join(", ")}.`;
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
    /** Every choice capacity limit in a copyable form: each is re-entered. */
    formChoiceLimits: FormChoiceLimitItem[];
    promoCodes: Array<{ promoCodeId: string; code: string; sourceStartsOn: string | null; sourceEndsOn: string | null }>;
    honorOfferings: Array<{
      offeringId: string;
      honorName: string;
      sessionName: string | null;
      sourceCapacity: number;
      sourcePerClubLimit: number | null;
      /** Carried over as it is; shown so the reviewer sees it. */
      minimumAge: number | null;
      additionalCostCents: number | null;
      requirementNote: string;
    }>;
    /** Private links found in copied text: each "needs review" and is removed from the copy. */
    privateLinks: PrivateLinkFinding[];
  };
  /** What is copied without a per-value review: prices, late prices, fees, and promo rules. */
  pricing: ClonePricingSummary;
  pricingMessage: string | null;
  /** Values that are always reset on the new draft, whatever is selected. */
  resets: string[];
  unsupported: Array<{ key: CloneUnsupportedKey; label: string; reason: string; sourceCount: number }>;
  neverCopied: readonly string[];
};

/**
 * How the clone treats what it copies (#157), shown in every preview. Dates,
 * capacities, and limits are never copied or shifted: each is entered anew.
 * The one exception is locations (#413): their capacity is copied, and their
 * dates move by the same number of days as the event's start date.
 * Message templates are the one thing copied live: their published text is
 * copied as a PUBLISHED version and each keeps its `isEnabled` switch.
 */
export const cloneAlwaysReset = [
  "Publication: the new event is an unpublished draft.",
  "Event dates, registration open and close dates, and the event capacity are entered below (or marked as none).",
  "The seminar preference deadline and lock are cleared.",
  "Public content sections are copied unpublished.",
  "Copied registration forms are new drafts; publish them after review.",
  "Choice capacity limits in copied forms, class capacities, and per-club limits are entered below (or marked as no limit).",
  "Promo codes are copied inactive with usage reset to zero; each date window is entered below.",
  "Message templates are copied as their current published text, already published, and each keeps whether it is enabled.",
  "Private links and tokens found in copied text are removed.",
] as const;

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function buildClonePlan(rawConfig: SourceConfiguration, fingerprint: string, appOrigins: readonly string[] = []): ClonePlan {
  // Counts and validity come from the text as it would be copied.
  const { config, findings } = sanitizeSourceForClone(rawConfig, appOrigins);
  const skippedForms: ClonePlanDomain["skipped"] = [];
  const latePricing: FormLatePricingItem[] = [];
  const formChoiceLimits: FormChoiceLimitItem[] = [];
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
    formChoiceLimits.push(...choiceLimitItems(form.formId, form.name, definition));
    attendeeTypeFields += attendeeTypeFieldCount(definition);
  }
  if (config.formsWithoutPublishedVersion > 0) {
    skippedForms.push({ label: plural(config.formsWithoutPublishedVersion, "form"), reason: "No published version to copy." });
  }

  const skippedMessages: ClonePlanDomain["skipped"] = [];
  let copyableMessages = 0;
  for (const template of config.messageTemplates) {
    if (isCopyableMessageTemplate(template)) copyableMessages += 1;
    else skippedMessages.push({ label: template.key, reason: "Its published text no longer passes the message rules." });
  }
  if (config.messageTemplatesWithoutPublishedVersion > 0) {
    skippedMessages.push({ label: plural(config.messageTemplatesWithoutPublishedVersion, "message template"), reason: "No published version to copy." });
  }

  const assetLinks = config.contentSections.reduce((total, section) => total + section.assetLinkCount, 0);
  const linkCount = config.contentSections.reduce((total, section) => total + section.links.length, 0);
  const moduleCount = 4 + (config.moduleToggles.community ? 1 : 0) + (config.moduleToggles.teamSettings ? 1 : 0);
  const privateLinkNote = (key: CloneDomainKey) => {
    const count = findings.filter((finding) => finding.domain === key).length;
    return count > 0 ? [`${plural(count, "private link")} need${count === 1 ? "s" : ""} review and will be removed from the copy.`] : [];
  };
  const pricing = clonePricingSummary(config);

  const notes: Record<CloneDomainKey, string[]> = {
    eventDetails: privateLinkNote("eventDetails"),
    moduleToggles: [
      `${4} switches${config.moduleToggles.community ? " and community settings" : ""} are copied as they are, on or off.`,
      ...(config.moduleToggles.teamSettings ? ["Team rules (teams, team size, alternate, oldest age) are copied. The date ages are counted on and the dates of the later levels are not: enter them on the new event."] : []),
    ],
    contentSections: [
      linkCount > 0 ? `${plural(linkCount, "web link")} copied.` : "No web links.",
      ...(assetLinks > 0 ? [`${plural(assetLinks, "link")} to uploaded files will be skipped.`] : []),
      ...privateLinkNote("contentSections"),
    ],
    registrationForms: [
      ...(latePricing.length > 0 ? [`${plural(latePricing.length, "late-pricing date")} need a new date.`] : []),
      ...(formChoiceLimits.length > 0 ? [`${plural(formChoiceLimits.length, "choice capacity limit")} need${formChoiceLimits.length === 1 ? "s" : ""} to be entered again.`] : []),
      ...(pricing.pricedFormFields + pricing.lateFormFields + pricing.formsWithCardFees > 0 ? ["Prices, late prices, and card fees are copied as they are: review them before publishing."] : []),
      ...(attendeeTypeFields > 0 && config.attendeeTypes.length > 0 ? ["Some fields choose from attendee types: include attendee types too."] : []),
      ...privateLinkNote("registrationForms"),
    ],
    attendeeTypes: [],
    attendeeClassifications: [],
    messageTemplates: [
      ...(copyableMessages > 0 ? ["Copied already published, each keeping whether it is enabled."] : []),
      ...privateLinkNote("messageTemplates"),
    ],
    tags: [],
    promoCodes: config.promoCodes.length > 0 ? ["Copied inactive with usage reset to zero. Each needs a new date window. Discount amounts and limits are copied as they are."] : [],
    honors: [
      ...(config.honorOfferings.length > 0 ? ["Each offering needs a capacity and a per-club limit you enter anew. Minimum ages carry over."] : []),
      ...(config.honorSessions.some((session) => session.locationName)
        ? ["Sessions follow their site by name. A session whose site has no same-named site in the new event is copied with no site, and the result says so."]
        : []),
    ],
    locations: config.locations.length > 0
      ? ["Name, address, capacity, and order are copied. Dates move by the same number of days as the event's start date; review them on the new event."]
      : [],
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
    locations: config.locations.length,
  };
  const skipped: Record<CloneDomainKey, ClonePlanDomain["skipped"]> = {
    eventDetails: [], moduleToggles: [], contentSections: [], registrationForms: skippedForms, attendeeTypes: [],
    attendeeClassifications: [], messageTemplates: skippedMessages, tags: [], promoCodes: [], honors: [], locations: [],
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
      formChoiceLimits,
      promoCodes: config.promoCodes.map((promo) => ({ promoCodeId: promo.id, code: promo.code, sourceStartsOn: promo.startsOn, sourceEndsOn: promo.endsOn })),
      honorOfferings: config.honorOfferings.map((offering) => ({
        offeringId: offering.id, honorName: offering.honorName, sessionName: offering.sessionName,
        sourceCapacity: offering.capacity, sourcePerClubLimit: offering.perClubLimit, minimumAge: offering.minimumAge,
        additionalCostCents: offering.additionalCostCents ?? null, requirementNote: offering.requirementNote ?? "",
      })),
      privateLinks: findings,
    },
    pricing,
    pricingMessage: pricingSummaryMessage(pricing),
    resets: [...cloneAlwaysReset],
    unsupported: (Object.keys(cloneUnsupportedLabels) as CloneUnsupportedKey[]).map((key) => ({
      key, ...cloneUnsupportedLabels[key], sourceCount: supportCounts[key],
    })),
    neverCopied: cloneNeverCopied,
  };
}

/** A message template a clone can copy: an event key whose text still validates. */
export function isCopyableMessageTemplate(template: Pick<SourceConfiguration["messageTemplates"][number], "key" | "subjectTemplate" | "bodyTemplate">) {
  return isEventMessageTemplateKey(template.key)
    && validateMessageTemplate({ subject: template.subjectTemplate, body: template.bodyTemplate }).issues.length === 0;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const previewEventCloneInputSchema = z.object({
  sourceEventId: z.string().trim().min(1).max(100),
}).strict();

const includeShape = Object.fromEntries(cloneDomainKeys.map((key) => [
  key,
  // `locations` (#413) is newer than the confirm bodies already in flight, so an absent value means "not selected".
  key === "locations" ? z.boolean().default(false) : z.boolean(),
])) as Record<CloneDomainKey, z.ZodBoolean>;

/**
 * A reviewed value that may be "none" (#157): either `{ value }` or the
 * explicit `{ value: null, none: true }`. A blank or a bare `null` is
 * refused, so "not answered" can never be read as "no limit" or "no date".
 */
function reviewed<T extends z.ZodType>(schema: T, message: string) {
  return z.union([
    z.object({ value: schema }).strict(),
    z.object({ value: z.null(), none: z.literal(true) }).strict(),
  ], { error: message });
}

/**
 * The confirm body (#157). Strict: an unknown key is refused. Every domain is
 * an explicit true/false, and every date-bound or capacity value is a key the
 * caller must send. The event capacity, the registration dates, and each side
 * of a promo window are `{ value }` or an explicit `{ value: null, none: true }`.
 * A choice limit or per-club limit is a number or a reviewed `null` inside an
 * entry that must be present for every source value. So the clone can never
 * fall back to a silent default, a carried-over limit, or a shifted date.
 * Built from the same rules event settings enforces, so the new event re-saves
 * there unchanged.
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
  capacity: reviewed(z.number().int().min(1).max(100_000), "Enter the event capacity, or choose no limit."),
  registrationOpensOn: reviewed(calendarDateSchema, "Enter the registration opening date, or choose no date."),
  registrationClosesOn: reviewed(calendarDateSchema, "Enter the registration closing date, or choose no date."),
  include: z.object(includeShape).strict(),
  formLatePricingDates: z.array(z.object({
    formId: z.string().trim().min(1).max(100),
    fieldKey: z.string().trim().min(1).max(60),
    startsOn: calendarDateSchema,
  }).strict()).max(500).default([]),
  /** Required: one entry per source choice limit in a copied form. */
  formChoiceLimits: z.array(z.object({
    formId: z.string().trim().min(1).max(100),
    fieldKey: z.string().trim().min(1).max(60),
    choice: z.string().min(1).max(120),
    /** A reviewed limit, or `null` for an explicit "no limit". */
    limit: z.number().int().min(1).max(10_000).nullable(),
  }).strict()).max(2000),
  promoCodeWindows: z.array(z.object({
    promoCodeId: z.string().trim().min(1).max(100),
    startsOn: reviewed(calendarDateSchema, "Enter a promo code start date, or choose no start date."),
    endsOn: reviewed(calendarDateSchema, "Enter a promo code end date, or choose no end date."),
  }).strict()).max(500).default([]),
  honorOfferingCapacities: z.array(z.object({
    offeringId: z.string().trim().min(1).max(100),
    capacity: z.number().int().min(1).max(10_000),
    /** A reviewed per-club limit, or `null` for an explicit "no per-club limit". */
    perClubLimit: z.number().int().min(1).max(1_000).nullable(),
  }).strict()).max(1000).default([]),
}).strict().superRefine((value, context) => {
  const opensOn = value.registrationOpensOn.value;
  const closesOn = value.registrationClosesOn.value;
  if (value.endsOn < value.startsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "The event cannot end before it starts." });
  }
  if (opensOn && closesOn && opensOn > closesOn) {
    context.addIssue({ code: "custom", path: ["registrationClosesOn"], message: "Registration cannot close before it opens." });
  }
  if (opensOn && opensOn > value.endsOn) {
    context.addIssue({ code: "custom", path: ["registrationOpensOn"], message: "Registration cannot open after the event ends." });
  }
  value.promoCodeWindows.forEach((window, index) => {
    if (window.startsOn.value && window.endsOn.value && window.startsOn.value > window.endsOn.value) {
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

  // Choice capacity limits: like class capacities, every one is re-entered,
  // and a reviewed `null` is the only way to copy a choice without a limit.
  const expectedLimits = new Map<string, FormChoiceLimitItem>();
  if (input.include.registrationForms) {
    for (const form of config.registrationForms) {
      const definition = parseFormDefinition(form.definition);
      if (!definition) continue;
      for (const item of choiceLimitItems(form.formId, form.name, definition)) expectedLimits.set(choiceLimitKey(item.formId, item.fieldKey, item.choice), item);
    }
  }
  const suppliedLimits = new Set<string>();
  for (const entry of input.formChoiceLimits) {
    const key = choiceLimitKey(entry.formId, entry.fieldKey, entry.choice);
    const item = expectedLimits.get(key);
    if (!item) issues.push(`A choice limit was supplied for something that is not being copied (${entry.fieldKey}: ${entry.choice}).`);
    else if (suppliedLimits.has(key)) issues.push(`The limit for ${item.choice} (${item.fieldLabel}) was supplied twice.`);
    suppliedLimits.add(key);
  }
  for (const [key, item] of expectedLimits) {
    if (!suppliedLimits.has(key)) issues.push(`Enter a limit for ${item.choice} (${item.fieldLabel} on ${item.formName}), or choose no limit.`);
  }

  const promoById = new Map(config.promoCodes.map((promo) => [promo.id, promo]));
  const suppliedPromo = new Set<string>();
  for (const window of input.promoCodeWindows) {
    const promo = promoById.get(window.promoCodeId);
    if (!input.include.promoCodes || !promo) issues.push("A promo code window was supplied for a code that is not being copied.");
    else if (suppliedPromo.has(promo.id)) issues.push(`The window for promo code ${promo.code} was supplied twice.`);
    else if ((promo.startsOn && window.startsOn.value === promo.startsOn) || (promo.endsOn && window.endsOn.value === promo.endsOn)) {
      issues.push(`Choose new dates for promo code ${promo.code}; a date is still the source event's.`);
    }
    if (promo) suppliedPromo.add(promo.id);
  }
  if (input.include.promoCodes) {
    for (const promo of config.promoCodes) {
      if (!suppliedPromo.has(promo.id)) issues.push(`Enter a date window for promo code ${promo.code}, or choose no start and no end date.`);
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
      if (!suppliedOfferings.has(offering.id)) issues.push(`Enter a capacity and per-club limit for ${offering.honorName}${offering.sessionName ? ` (${offering.sessionName})` : ""}.`);
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
