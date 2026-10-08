import { z } from "zod";
import { shirtSizeOptions } from "@/modules/registrations/shirt-sizes";
import { hasAddressValue, isPlainAddressObject, validateAddressValue } from "@/modules/forms/address";

export const formFieldTypes = ["TEXT", "LONG_TEXT", "EMAIL", "PHONE", "SELECT", "RADIO", "MULTISELECT", "RANKED_CHOICE", "CHECKBOX", "DATE", "NUMBER", "CALCULATED", "ADDRESS"] as const;
export const formFieldScopes = ["REGISTRATION", "ATTENDEE"] as const;
export const choiceFieldTypes = ["SELECT", "RADIO", "MULTISELECT", "RANKED_CHOICE"] as const;
export const conditionOperators = ["EQUALS", "NOT_EQUALS", "INCLUDES", "NOT_EMPTY"] as const;
export const availabilityModes = ["NONE", "CAPACITY", "RANKED_INTEREST"] as const;
const attendeeNameKeys = ["full_name", "name", "attendee_name", "guest_name"] as const;

const priceCentsSchema = z.number().int().min(0).max(10000000);
// A credit is entered as a negative price per unit on a REGISTRATION-scope
// NUMBER field (e.g. Camporee's per-person meal sponsorship, #409): each unit
// in the answer subtracts this amount, optionally capped at the
// registration's headcount so a club can never claim more meal credit than
// it has people to feed. `finalizeCalculation` floors the whole total at $0,
// so a credit can discount a registration to free but never below it.
const creditCentsPerUnitSchema = z.number().int().min(-10000000).max(0);
const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date in YYYY-MM-DD format.").refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date.");

export function isChoiceFieldType(type: string): type is typeof choiceFieldTypes[number] {
  return choiceFieldTypes.includes(type as typeof choiceFieldTypes[number]);
}

/**
 * Live directory option sources (#482): "Clubs directory" and "Churches
 * directory" read current `Organization` records instead of a hand-typed
 * list, alongside the existing `ATTENDEE_TYPES` mechanism.
 */
export const directoryOptionSources = ["CLUBS_DIRECTORY", "CHURCHES_DIRECTORY", "SCHOOLS_DIRECTORY"] as const;
export type DirectoryOptionSource = typeof directoryOptionSources[number];

export function isDirectoryOptionSource(source: string | undefined): source is DirectoryOptionSource {
  return source === "CLUBS_DIRECTORY" || source === "CHURCHES_DIRECTORY" || source === "SCHOOLS_DIRECTORY";
}

/** Plural noun for a directory source, for builder labels. */
export function directorySourceNoun(source: DirectoryOptionSource) {
  return source === "CLUBS_DIRECTORY" ? "clubs" : source === "SCHOOLS_DIRECTORY" ? "schools" : "churches";
}

/**
 * The sentinel choice for "my club/church isn't on this list" (#482): kept
 * alongside the live directory entries so it validates as an ordinary
 * configured choice. Paired, by the existing "show only when" convention, with
 * a free-text field the director fills in instead — the same pattern the
 * templates already use for a static "Other" choice.
 */
export const DIRECTORY_NOT_LISTED_VALUE = "Not listed";

/** The NUMBER field keys that hold an attendee's age (#483). */
export const AGE_FIELD_KEYS = ["attendee_age", "age"] as const;

export function isAgeFieldKey(key: string) {
  return (AGE_FIELD_KEYS as readonly string[]).includes(key);
}

/** Age can't be entered outside a plausible human range when a field carries
 * no more specific `ageBounds` (#483). */
export const DEFAULT_AGE_BOUNDS = { minimumAge: 0, maximumAge: 120 } as const;

/** The general cap on a NUMBER field that has no age-specific bound. */
export const GENERAL_NUMBER_MAXIMUM = 100000;

/** The allowed numeric range for a NUMBER field: its own `ageBounds` when
 * configured, else the default age range for a recognized age field key, else
 * null (no age-specific bound — the general 0–100,000 numeric check applies). */
export function numberFieldBounds(
  field: Pick<RegistrationFormField, "key" | "ageBounds">,
): { minimumAge: number; maximumAge: number } | null {
  if (field.ageBounds) {
    return {
      minimumAge: field.ageBounds.minimumAge ?? DEFAULT_AGE_BOUNDS.minimumAge,
      // An unset maximum on a non-age number falls back to the general numeric cap.
      maximumAge: field.ageBounds.maximumAge ?? (isAgeFieldKey(field.key) ? DEFAULT_AGE_BOUNDS.maximumAge : GENERAL_NUMBER_MAXIMUM),
    };
  }
  return isAgeFieldKey(field.key) ? { ...DEFAULT_AGE_BOUNDS } : null;
}

export function getAvailabilityMode(field: Pick<RegistrationFormField, "type" | "choiceLimits" | "availabilityMode">) {
  if (field.availabilityMode) return field.availabilityMode;
  if (field.choiceLimits !== undefined) return field.type === "RANKED_CHOICE" ? "RANKED_INTEREST" : "CAPACITY";
  return "NONE";
}

export const formFieldSchema = z.object({
  id: z.string().trim().min(3).max(80),
  key: z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9_]*$/, "Field keys use lowercase letters, numbers, and underscores."),
  label: z.string().trim().min(2, "Every field needs a label.").max(120),
  helpText: z.string().trim().max(240).default(""),
  placeholder: z.string().trim().max(120).optional(),
  type: z.enum(formFieldTypes),
  scope: z.enum(formFieldScopes),
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
  optionSource: z.enum(["ATTENDEE_TYPES", "CLUBS_DIRECTORY", "CHURCHES_DIRECTORY", "SCHOOLS_DIRECTORY"]).optional(),
  optionLabels: z.record(z.string(), z.string().trim().min(1).max(120)).optional(),
  optionDescriptions: z.record(
    z.string(),
    z.string().trim().max(2000),
  ).optional(),
  minSelections: z.number().int().min(1).max(10).optional(),
  maxSelections: z.number().int().min(1).max(10).optional(),
  availabilityMode: z.enum(availabilityModes).optional(),
  choiceLimits: z.record(z.string(), z.number().int().min(1).max(10000)).optional(),
  priceCents: priceCentsSchema.optional(),
  choicePricesCents: z.record(z.string(), priceCentsSchema).optional(),
  creditCentsPerUnit: creditCentsPerUnitSchema.optional(),
  capUnitsAtAttendeeCount: z.boolean().optional(),
  latePricing: z.object({
    startsOn: calendarDateSchema,
    label: z.string().trim().min(2).max(80).default("Late registration pricing"),
    priceCents: priceCentsSchema.optional(),
    choicePricesCents: z.record(z.string(), priceCentsSchema).optional(),
  }).optional(),
  conditional: z.object({ fieldKey: z.string().trim().min(2).max(60), operator: z.enum(conditionOperators), value: z.string().max(120).default("") }).optional(),
  /**
   * A required field that becomes optional when this matches, e.g. seminar
   * rankings for Teens (WR26): shown with a note, answerable, never forced.
   */
  optionalWhen: z.object({ fieldKey: z.string().trim().min(2).max(60), operator: z.enum(conditionOperators), value: z.string().max(120).default("") }).optional(),
  /**
   * A numeric field's allowed range (#483), e.g. the configured age bands
   * (#133) narrowed to one attendee type. Only meaningful on a NUMBER field;
   * a bare age field (`attendee_age`/`age`) without this falls back to
   * `DEFAULT_AGE_BOUNDS` rather than accepting any number.
   */
  ageBounds: z.object({
    minimumAge: z.number().int().min(0).max(GENERAL_NUMBER_MAXIMUM).nullable(),
    maximumAge: z.number().int().min(0).max(GENERAL_NUMBER_MAXIMUM).nullable(),
  }).optional(),
  /**
   * A DATE field that fills in today's date (Chicago) on its own (#719): a
   * signing or application date. Club forms only; a private link shows it
   * read-only and the server sets it on submit, a director's form
   * pre-fills it but lets them change it.
   */
  autoDate: z.literal("TODAY").optional(),
  /**
   * "Show as a filter" (#743): the field is offered in the People &
   * registrations answer filter. Absent means the read-time default in
   * `modules/forms/field-flags.ts`. Only a choice field with options is ever
   * offered, whatever this says.
   */
  filterable: z.boolean().optional(),
  /**
   * A small heading shared by consecutive fields (#856), e.g. "1. Pastor" over
   * a reference's name, address and phone. The fill-in form lays each run of
   * fields with the same group out as its own row under that heading, so the
   * labels inside can be short ("Name"); read-only views, CSV headings and the
   * builder prefix the group ("1. Pastor — Name") so a label is never
   * ambiguous. Display only: the field key and stored answer are unchanged.
   */
  group: z.string().trim().min(2).max(80).optional(),
  /**
   * "Sensitive" (#743): only staff with VIEW_SENSITIVE_DATA see the answer or
   * filter on it. Absent means the read-time default (health-type fields are
   * sensitive) in `modules/forms/field-flags.ts`.
   */
  sensitive: z.boolean().optional(),
}).superRefine((field, context) => {
  if (field.autoDate && field.type !== "DATE") {
    context.addIssue({ code: "custom", path: ["autoDate"], message: "Only a date question can fill in today's date." });
  }
  if (field.ageBounds) {
    const { minimumAge, maximumAge } = field.ageBounds;
    const isAge = isAgeFieldKey(field.key);
    // Age fields keep their 130 cap; other numbers may go to the general cap.
    for (const edge of ["minimumAge", "maximumAge"] as const) {
      const bound = field.ageBounds[edge];
      if (isAge && bound !== null && bound > 130) {
        context.addIssue({ code: "custom", path: ["ageBounds", edge], message: "Age bounds cannot exceed 130." });
      }
    }
    if (minimumAge !== null && maximumAge !== null && minimumAge > maximumAge) {
      context.addIssue({ code: "custom", path: ["ageBounds"], message: isAge ? "Minimum age cannot exceed maximum age." : "Minimum value cannot exceed maximum value." });
    }
  }
  if (isChoiceFieldType(field.type) && field.options.length < 2 && !field.optionSource) {
    context.addIssue({ code: "custom", path: ["options"], message: "Choice fields need at least two choices." });
  }
  if ((field.type === "MULTISELECT" || field.type === "RANKED_CHOICE") && field.maxSelections && field.maxSelections > field.options.length) {
    context.addIssue({ code: "custom", path: ["maxSelections"], message: "Maximum selections cannot exceed the number of choices." });
  }
  if ((field.type === "MULTISELECT" || field.type === "RANKED_CHOICE") && field.minSelections && field.maxSelections && field.minSelections > field.maxSelections) {
    context.addIssue({ code: "custom", path: ["minSelections"], message: "Minimum selections cannot exceed the maximum." });
  }
  for (const choice of Object.keys(field.choiceLimits ?? {})) {
    if (!field.options.includes(choice)) context.addIssue({ code: "custom", path: ["choiceLimits", choice], message: "Choice limits must reference a configured choice." });
  }
  for (const choice of Object.keys(field.optionDescriptions ?? {})) {
    if (!field.options.includes(choice)) context.addIssue({ code: "custom", path: ["optionDescriptions", choice], message: "Choice descriptions must reference a configured choice." });
  }
  for (const choice of Object.keys(field.optionLabels ?? {})) {
    if (!field.options.includes(choice)) context.addIssue({ code: "custom", path: ["optionLabels", choice], message: "Choice labels must reference a configured choice." });
  }
  if (field.optionSource === "ATTENDEE_TYPES" && (!isChoiceFieldType(field.type) || field.scope !== "ATTENDEE" || field.type === "MULTISELECT" || field.type === "RANKED_CHOICE")) {
    context.addIssue({ code: "custom", path: ["optionSource"], message: "The attendee-type selector must be a single-choice attendee field." });
  }
  if (field.optionSource === "ATTENDEE_TYPES" && !field.required) {
    context.addIssue({ code: "custom", path: ["required"], message: "The attendee-type selector must be required." });
  }
  if (
    isDirectoryOptionSource(field.optionSource)
    && ((field.type !== "SELECT" && field.type !== "RADIO") || field.scope !== "REGISTRATION")
  ) {
    context.addIssue({ code: "custom", path: ["optionSource"], message: "A directory-sourced field must be a single-choice select or radio field that applies to the whole registration." });
  }
  for (const choice of Object.keys(field.choicePricesCents ?? {})) {
    if (!field.options.includes(choice)) context.addIssue({ code: "custom", path: ["choicePricesCents", choice], message: "Choice prices must reference a configured choice." });
  }
  for (const choice of Object.keys(field.latePricing?.choicePricesCents ?? {})) {
    if (!field.options.includes(choice)) context.addIssue({ code: "custom", path: ["latePricing", "choicePricesCents", choice], message: "Late choice prices must reference a configured choice." });
  }
  if (field.latePricing && field.priceCents === undefined && !field.choicePricesCents) {
    context.addIssue({ code: "custom", path: ["latePricing"], message: "Late pricing requires a regular field or choice price." });
  }
  if (field.creditCentsPerUnit !== undefined) {
    if (field.type !== "NUMBER" || field.scope !== "REGISTRATION") {
      context.addIssue({ code: "custom", path: ["creditCentsPerUnit"], message: "A per-unit credit can only be set on a registration-level number field." });
    }
    if (field.priceCents !== undefined || field.choicePricesCents || field.latePricing) {
      context.addIssue({ code: "custom", path: ["creditCentsPerUnit"], message: "A field can charge a price or apply a credit, not both." });
    }
  }
  if (field.capUnitsAtAttendeeCount && field.creditCentsPerUnit === undefined) {
    context.addIssue({ code: "custom", path: ["capUnitsAtAttendeeCount"], message: "Capping at the headcount requires a per-unit credit." });
  }
});

/** A field's label with its group heading in front ("1. Pastor — Name"), for views where the heading is not shown beside it. */
export function fieldDisplayLabel(field: { label: string; group?: string }) {
  return field.group ? `${field.group} \u2014 ${field.label}` : field.label;
}

/** Splits a section's fields into runs of consecutive fields with the same group (or none), keeping their order. */
export function fieldRuns<T extends { group?: string }>(fields: readonly T[]) {
  const runs: { group: string | undefined; fields: T[] }[] = [];
  for (const field of fields) {
    const last = runs[runs.length - 1];
    if (last && last.group === field.group) last.fields.push(field);
    else runs.push({ group: field.group, fields: [field] });
  }
  return runs;
}

export const formSectionSchema = z.object({
  id: z.string().trim().min(3).max(80),
  title: z.string().trim().min(2, "Every section needs a title.").max(120),
  description: z.string().trim().max(300).default(""),
  stepLabel: z.string().trim().min(2).max(40).optional(),
  isReviewStep: z.boolean().optional(),
  fields: z.array(formFieldSchema).min(1, "Every section needs at least one field.").max(20),
});

export const RESERVED_CHOICE_VALUE_MESSAGE = "Choice values can't start with two underscores.";

/**
 * Save-time check only (the form builder's PATCH). It is deliberately not part
 * of `registrationFormDefinitionSchema`, which also READS stored definitions:
 * a form already saved with such an option must keep loading. The answer
 * filter reserves the "__" prefix for its no-answer / other buckets, and drops
 * any such option as a backstop. Throws a ZodError so callers use the existing
 * INVALID_FORM response.
 */
export function assertNoReservedChoiceValues(definition: z.infer<typeof registrationFormDefinitionSchema>) {
  const issues: z.core.$ZodIssue[] = [];
  definition.sections.forEach((section, sectionIndex) => section.fields.forEach((field, fieldIndex) => field.options.forEach((option, optionIndex) => {
    if (option.startsWith("__")) {
      issues.push({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "options", optionIndex], message: RESERVED_CHOICE_VALUE_MESSAGE, input: option });
    }
  })));
  if (issues.length > 0) throw new z.ZodError(issues);
}

export const registrationFormDefinitionSchema = z.object({
  title: z.string().trim().min(3, "Form title must be at least 3 characters.").max(120),
  description: z.string().trim().max(500).default(""),
  confirmationMessage: z.string().trim().min(3).max(500),
  sections: z.array(formSectionSchema).min(1, "Add at least one section.").max(12),
  attendeeRoster: z.object({
    enabled: z.boolean(),
    minAttendees: z.number().int().min(1).max(50).default(1),
    maxAttendees: z.number().int().min(1).max(50).default(8),
    attendeeLabel: z.string().trim().min(2).max(40).default("Attendee"),
    addButtonLabel: z.string().trim().min(2).max(80).default("Add another attendee"),
  }).optional(),
  /**
   * At least one of these fields must be answered with something (#606): a positive number for a NUMBER
   * field, any answer otherwise. For an order form whose every quantity may be left at 0 individually.
   */
  requireAtLeastOne: z.object({
    fieldKeys: z.array(z.string().trim().min(2).max(60)).min(2).max(10),
    message: z.string().trim().min(3).max(120),
  }).optional(),
  payment: z.object({
    enabled: z.boolean(),
    currency: z.literal("USD").default("USD"),
    paymentMethodFieldKey: z.string().trim().min(2).max(60),
    cardOptionValue: z.string().trim().min(1).max(120),
    percentageBasisPoints: z.number().int().min(0).max(2000).default(290),
    fixedFeeCents: z.number().int().min(0).max(1000).default(30),
    passFeeToRegistrant: z.boolean().default(true),
  }).optional(),
}).superRefine((definition, context) => {
  const sectionIds = new Set<string>();
  const fieldIds = new Set<string>();
  const fieldKeys = new Set<string>();
  const reviewSectionIndexes: number[] = [];
  definition.sections.forEach((section, sectionIndex) => {
    if (sectionIds.has(section.id)) context.addIssue({ code: "custom", path: ["sections", sectionIndex, "id"], message: "Section IDs must be unique." });
    sectionIds.add(section.id);
    if (section.isReviewStep) reviewSectionIndexes.push(sectionIndex);
    section.fields.forEach((field, fieldIndex) => {
      if (fieldIds.has(field.id)) context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "id"], message: "Field IDs must be unique." });
      if (fieldKeys.has(field.key)) context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "key"], message: `Field key ${field.key} is already in use.` });
      fieldIds.add(field.id);
      fieldKeys.add(field.key);
      if (
        field.key === "promo_code"
        && (
          field.type !== "TEXT"
          || field.required
          // Per-person codes (#397) need an attendee roster to price each share.
          || (field.scope === "ATTENDEE" && !definition.attendeeRoster?.enabled)
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["sections", sectionIndex, "fields", fieldIndex],
          message: "The Promo code module must be an optional short text field, asked once per registration or once per attendee on a roster form.",
        });
      }
    });
  });
  if (reviewSectionIndexes.length > 1) {
    for (const sectionIndex of reviewSectionIndexes.slice(1)) {
      context.addIssue({ code: "custom", path: ["sections", sectionIndex, "isReviewStep"], message: "Only one section can be the final review step." });
    }
  }
  if (
    reviewSectionIndexes.length === 1
    && reviewSectionIndexes[0] !== definition.sections.length - 1
  ) {
    context.addIssue({ code: "custom", path: ["sections", reviewSectionIndexes[0], "isReviewStep"], message: "The review section must be the final section." });
  }
  definition.sections.forEach((section, sectionIndex) => section.fields.forEach((field, fieldIndex) => {
    if (field.conditional && (!fieldKeys.has(field.conditional.fieldKey) || field.conditional.fieldKey === field.key)) context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "conditional"], message: "Conditional logic must reference another configured field." });
    const controller = field.conditional
      ? definition.sections.flatMap((candidate) => candidate.fields).find((candidate) => candidate.key === field.conditional?.fieldKey)
      : null;
    if (field.scope === "REGISTRATION" && controller?.scope === "ATTENDEE") {
      context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "conditional"], message: "A registration-level field cannot depend on an attendee answer." });
    }
    if (field.capUnitsAtAttendeeCount && !definition.attendeeRoster?.enabled) {
      context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "capUnitsAtAttendeeCount"], message: "Capping at the headcount requires a repeatable attendee roster." });
    }
    if (field.optionalWhen) {
      const optionalController = definition.sections.flatMap((candidate) => candidate.fields).find((candidate) => candidate.key === field.optionalWhen?.fieldKey);
      if (!optionalController || optionalController.key === field.key) {
        context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "optionalWhen"], message: "\"Optional when\" must reference another configured field." });
      } else if (field.scope === "REGISTRATION" && optionalController.scope === "ATTENDEE") {
        context.addIssue({ code: "custom", path: ["sections", sectionIndex, "fields", fieldIndex, "optionalWhen"], message: "A registration-level field cannot depend on an attendee answer." });
      }
    }
  }));
  const allFields = definition.sections.flatMap((section) => section.fields);
  if (allFields.filter((field) => field.optionSource === "ATTENDEE_TYPES").length > 1) {
    context.addIssue({ code: "custom", path: ["sections"], message: "A form can designate only one attendee-type selector." });
  }
  const requiredKeys = definition.requireAtLeastOne?.fieldKeys ?? [];
  for (const key of requiredKeys) {
    if (!fieldKeys.has(key)) context.addIssue({ code: "custom", path: ["requireAtLeastOne", "fieldKeys"], message: `Field ${key} is not configured.` });
  }
  // One scope only: a registration-level and an attendee-level answer are checked in different places.
  const requiredScopes = new Set(requiredKeys.flatMap((key) => {
    const found = definition.sections.flatMap((section) => section.fields).find((field) => field.key === key);
    return found ? [found.scope] : [];
  }));
  if (requiredScopes.size > 1) {
    context.addIssue({ code: "custom", path: ["requireAtLeastOne", "fieldKeys"], message: "The fields in an \"at least one\" rule must all apply to the registration, or all to each attendee." });
  }
  const paymentField = definition.payment ? allFields.find((field) => field.key === definition.payment?.paymentMethodFieldKey) : null;
  if (definition.payment && !paymentField) context.addIssue({ code: "custom", path: ["payment", "paymentMethodFieldKey"], message: "Payment settings must reference a configured payment-method field." });
  if (definition.payment && paymentField?.scope === "ATTENDEE") context.addIssue({ code: "custom", path: ["payment", "paymentMethodFieldKey"], message: "The payment method must apply to the registration, not each attendee." });
  if (definition.attendeeRoster?.enabled) {
    if (definition.attendeeRoster.minAttendees > definition.attendeeRoster.maxAttendees) {
      context.addIssue({ code: "custom", path: ["attendeeRoster", "minAttendees"], message: "Minimum attendees cannot exceed the maximum." });
    }
    const attendeeFields = allFields.filter((field) => field.scope === "ATTENDEE");
    if (attendeeFields.length === 0) {
      context.addIssue({ code: "custom", path: ["attendeeRoster"], message: "Repeatable rosters require at least one attendee-level field." });
    }
    const hasSplitName = attendeeFields.some((field) => field.key === "first_name")
      && attendeeFields.some((field) => field.key === "last_name");
    const hasFullName = attendeeFields.some((field) => attendeeNameKeys.includes(field.key as typeof attendeeNameKeys[number]));
    if (!hasSplitName && !hasFullName) {
      context.addIssue({ code: "custom", path: ["attendeeRoster"], message: "Repeatable rosters require attendee first/last name fields or a supported full-name field." });
    }
    const hasRequiredSplitName = attendeeFields.some((field) => field.key === "first_name" && field.required && !field.conditional)
      && attendeeFields.some((field) => field.key === "last_name" && field.required && !field.conditional);
    const hasRequiredFullName = attendeeFields.some((field) => (
      attendeeNameKeys.includes(field.key as typeof attendeeNameKeys[number])
      && field.required
      && !field.conditional
    ));
    if ((hasSplitName || hasFullName) && !hasRequiredSplitName && !hasRequiredFullName) {
      context.addIssue({
        code: "custom",
        path: ["attendeeRoster"],
        message: "Each roster entry needs an always-visible required attendee name. Require both first and last name, or one supported full-name field.",
      });
    }
  }
});

/**
 * Best-effort read of the club/church running a deferred-organization
 * registration, from whatever registration-level answer already names it.
 * There is no relational link from a registration to an organization record,
 * so this reads the same well-known response keys the Spring Camporee
 * template already collects rather than requiring a new one.
 */
export function resolveResponsibleOrganization(responses: Record<string, unknown>): string | null {
  const explicit = typeof responses.responsible_organization === "string"
    ? responses.responsible_organization.trim()
    : "";
  if (explicit) return explicit;
  const clubName = typeof responses.club_name === "string" ? responses.club_name.trim() : "";
  if (clubName && clubName !== "Other" && clubName !== DIRECTORY_NOT_LISTED_VALUE) return clubName;
  const clubNameOther = typeof responses.club_name_other === "string" ? responses.club_name_other.trim() : "";
  if (clubNameOther) return clubNameOther;
  const churchName = typeof responses.church_name === "string" ? responses.church_name.trim() : "";
  if (churchName && churchName !== "Other" && churchName !== DIRECTORY_NOT_LISTED_VALUE) return churchName;
  // A "Not listed" church (#482) falls back to the name the director typed,
  // as the club side does.
  const churchNameOther = typeof responses.church_name_other === "string" ? responses.church_name_other.trim() : "";
  if (churchNameOther) return churchNameOther;
  return null;
}

/**
 * Best-effort read of the deferred-organization billing contact, separate
 * from the registration submitter's own contact identity. Same rationale as
 * `resolveResponsibleOrganization`: no relational billing-contact record
 * exists, so this reads the well-known response key the Spring Camporee
 * template already collects.
 */
export function resolveBillingContactName(responses: Record<string, unknown>): string | null {
  const explicit = typeof responses.billing_contact_name === "string"
    ? responses.billing_contact_name.trim()
    : "";
  if (explicit) return explicit;
  const directorName = typeof responses.director_name === "string" ? responses.director_name.trim() : "";
  return directorName || null;
}

export type RegistrationFormDefinition = z.infer<typeof registrationFormDefinitionSchema>;
export type RegistrationFormField = z.infer<typeof formFieldSchema>;
export type ChoiceUsage = Record<string, Record<string, { total: number; first: number; second: number }>>;
export type FormCalculation = { subtotalCents: number; processingFeeCents: number; totalCents: number; lineItems: Array<{ key: string; label: string; amountCents: number; pricingLabel?: string; attendeeIndex?: number; attendeeLabel?: string }> };
export type AttendeeRosterConfig = {
  enabled: boolean;
  minAttendees: number;
  maxAttendees: number;
  attendeeLabel: string;
  addButtonLabel: string;
};

export type FormTemplate = {
  key: string;
  name: string;
  description: string;
  audience: string;
  definition: RegistrationFormDefinition;
};

function templateField(id: string, key: string, label: string, type: RegistrationFormField["type"], required = false, options: string[] = [], extra: Partial<RegistrationFormField> = {}): RegistrationFormField {
  return { id, key, label, helpText: "", type, scope: "REGISTRATION", required, options, ...extra };
}

export const imsdaChurchOptions = [
  "Albany SDA Church",
  "Albia SDA Church",
  "Ames SDA Church",
  "Ankeny SDA Church",
  "Atlantic SDA Church",
  "Ava SDA Church",
  "Bedford SDA Church",
  "Belton 3 Angels SDA Company",
  "Bolivar SDA Church",
  "Boone SDA Church",
  "Boonville SDA Church",
  "Bourbon SDA Church",
  "Branson East SDA Church",
  "Burlington SDA Church",
  "Butler Living Word SDA Company",
  "Campbell SDA Church",
  "Cape Girardeau SDA Church",
  "Carthage SDA Church",
  "Carthage Hispanic SDA Company",
  "Cedar Rapids SDA Church",
  "Centerville SDA Church",
  "Charles City SDA Church",
  "Clinton (IA) SDA Church",
  "Clinton (MO) SDA Church",
  "Columbia Hope SDA",
  "Columbia SDA Church",
  "Council Bluffs SDA Church",
  "Davenport SDA Church",
  "Des Moines Karen SDA Company",
  "Des Moines Mizo SDA Company",
  "Des Moines SDA Church",
  "Des Moines Spanish SDA Church",
  "Doniphan SDA Church",
  "Dubuque SDA Church",
  "Exira SDA Church",
  "Fairfield SDA Church",
  "Farmington SDA Church",
  "Fort Dodge SDA Church",
  "Fort Madison SDA Church",
  "Fredericktown SDA Church",
  "Fulton SDA Church",
  "Gallatin SDA Church",
  "Gladstone SDA Church",
  "Guthrie Center SDA Church",
  "Hampton SDA Church",
  "Hannibal SDA Church",
  "Harlan SDA Church",
  "Hawkeye SDA Church",
  "Houston SDA Fellowship",
  "Independence SDA Church",
  "Independence Ebenezer Spanish SDA Church",
  "Independence Samoan-English SDA Church",
  "Iowa City Hispanic Group",
  "Iowa City SDA Church",
  "Jefferson City SDA Church",
  "Joplin SDA Church",
  "Kahoka SDA Church",
  "Kansas City Central SDA Church",
  "Kansas City Latin-American SDA Church",
  "Kansas City Ububyutse SDA Group",
  "Kimberling City SDA Church",
  "Kingsville Adventist Church",
  "Kirksville SDA Church",
  "Knoxville SDA Church",
  "Lake of the Ozarks SDA Church",
  "Lamar SDA Church",
  "Lebanon SDA Church",
  "Lee's Summit SDA Church",
  "Lewistown SDA Company",
  "Lineville Group",
  "Macon SDA Church",
  "Marceline SDA Church",
  "Marshall SDA Church",
  "Marshalltown SDA Church",
  "Mason City SDA Church",
  "Mexico SDA Church",
  "Moberly SDA Church",
  "Monett Bilingual SDA Company",
  "Mountain Grove SDA Church",
  "Multicultural Church for the Community",
  "Muscatine SDA Church",
  "Neosho Granby SDA Church",
  "Nevada IA SDA Church",
  "Nevada MO SDA Church",
  "Newton SDA Church",
  "Nixa SDA Church",
  "Nixa Slavic Seventh-day Adventist Church of Hope",
  "NC4Y",
  "Oak Grove SDA Church",
  "Oak Grove Heights SDA Church",
  "Osceola SDA Church",
  "Ottumwa SDA Church",
  "Poplar Bluff SDA Church",
  "Prescott SDA School",
  "Republic New Horizons SDA Church",
  "Richville SDA Church",
  "Riverside Hispanic SDA Church",
  "Rolla SDA Church",
  "Salem SDA Church",
  "Sedalia SDA Church",
  "Sedalia SDA School",
  "Sikeston Peace Point Chapel",
  "Sioux City SDA Church",
  "South West City Spanish Company",
  "Spencer SDA Church",
  "Springfield SDA Church",
  "Springfield Seventh-day Adventist Jr Aca",
  "St James Hope SDA Group",
  "St Joseph Hispanic SDA Company",
  "St Joseph Three Angels SDA Church",
  "St Louis Central SDA Church",
  "St Louis Immanuel SDA Group",
  "St Louis Korean SDA Church",
  "St Louis Mid-Rivers SDA Church",
  "St Louis Southside French SDA Group",
  "St Louis Southside SDA Church",
  "St Louis Spanish SDA Church",
  "St Louis Urumuri (Light House) SDA",
  "St Louis West County SDA Church",
  "Sullivan SDA Church",
  "Summersville (MO) SDA Group",
  "Summit View Adventist School",
  "Sunnydale Adventist Academy",
  "Sunnydale SDA Church",
  "Sunnydale SDA Elementary School",
  "Trenton-Chillicothe SDA Church",
  "Warrensburg Crossroads SDA Church",
  "Waterloo SDA Church",
  "Waukon SDA Church",
  "Waynesville SDA Church",
  "West Des Moines (Jordan Crossing) SDA Co",
  "West Plains SDA Church",
  "Willow Springs SDA Church",
  "Winterset SDA Church",
  "Woodland Hills SDA",
  "Other",
];

const manCampRegistrationPackages = [
  "Shared cabin — connected restroom",
  "Shared cabin — detached restroom",
  "RV hookup",
  "Tent camping",
  "Sabbath attendance only",
  "Volunteer — no registration fee",
];

const campMeetingHousingOptions = [
  "Dorm room",
  "RV / camper hookup",
  "Tent campsite",
  "No housing needed",
];

const campMeetingNights = ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const wr26SeminarDescriptions = {
  "Color Me Golden: Embracing Life in Every Season":
    "Panel Discussion — Every season of a woman’s life holds unique beauty, but later chapters often bring transitions that feel like winding down. God views this stage not as a time of fading, but as a vibrant season of deep impact and fruitfulness. Come hear real stories of faith and uncover fresh avenues for kingdom purpose while exploring practical ways to transform your life experience into a lasting legacy.",
  "Refined by Fire, Revealed in Beauty":
    "Rita Tasche — In this seminar we will learn how hard seasons shape strength, depth and resilience. We will learn how to walk through trials without losing our faith and how to find purpose in pain while developing a strength that comes only through surrender to God.",
  "Repainted by Grace":
    "Valerie Haveman — So many women carry the stains of past mistakes, shame, regret, or feelings of not being enough. But God does not define us by the colors of our past. In this breakout session, we’ll explore what it means to accept God’s forgiveness, stop condemning ourselves, and allow His grace to repaint our hearts with truth, freedom, and hope. Through Scripture and personal stories, we’ll discover how God makes broken things beautiful and invites us to see ourselves through His eyes instead of our own.",
  "Color Me Open":
    "Mary Kendall — The door is open. Are you? And what does a root canal have to do with church hospitality? More than you’d think. Mary and her husband built Touchstone Endodontics around one mission: “Unforgettable care, start to finish” — and the same principles that turn nervous patients into raving fans can transform how we love our neighbors, our church family, and the stranger in our pew. Mary draws from business, home, and church ministry to share what she’s learning about what it means to truly see the people around us. She doesn’t have it all figured out — but she’s convinced the journey is worth taking, and she’d love some company.",
  "Nourished by Color":
    "Stephanie Richards — This seminar explores simple, evidence-based ways to improve overall health by focusing on colorful nutrition, regular movement, and healthy sun exposure. Participants will learn how “eating the rainbow” — incorporating a variety of brightly colored fruits and vegetables — supports immunity, heart health, gut health, and energy. The session will also highlight how daily activity and safe sunshine exposure work together with nutrition to promote long-term wellness and healthy aging.",
  "Color Me Prayerful: Discovering the Beautiful Ways We Talk With God":
    "Shannon Pigsley and Penny Gallant — Prayer is powerful—an intimate, ongoing conversation with a God who listens, loves, and responds. In this session, we will explore why prayer matters so deeply in our relationship and discover the many beautiful ways we can communicate with our Heavenly Father. From kneeling in quiet surrender, to praying in community, to whispering private heart-conversations throughout the day, we’ll reflect on how the privilege of prayer draws us closer to God’s heart. Participants will also have the opportunity to visit interactive prayer stations, each designed to help you experience different forms of prayer in meaningful, hands-on ways. This is a space to learn, to practice, and to rediscover the joy of talking with God in every shade of life.",
  "Shades of Peace":
    "Melissa Morris — This is a practical and encouraging seminar on letting go of anger and resentment while discovering the peace that comes through forgiveness in God. Together, we will explore how releasing past hurts can bring healing, restore relationships, and help us experience greater emotional and spiritual freedom.",
  "Coloring Through the Chaos: Raising Children with Grace and Truth":
    "Panel Discussion — Raising children today can feel unpredictable and overwhelming but God is still at work both in your child and in you. This season doesn’t require us to control every detail but does require us to guide, love and trust God with the outcome.",
  "Broken Crayons Still Color":
    "Domestic violence and alcohol use affect families inside and outside our church. This session is about awareness, growth and safety regarding domestic violence and alcohol use and empowering women to be the hands and feet of Jesus in our struggling world. Matthew 22: 37–39",
  "Attending":
    "Brushstrokes of Leadership — Ami Cook. God uses ordinary women to create extraordinary ministry. In this practical and encouraging workshop, discover how small acts of faith, kindness, and leadership become beautiful brushstrokes in God’s masterpiece. Learn creative ways to build women’s ministry in your local church, encourage connection, and lead with both grace and purpose.",
} satisfies Record<string, string>;

function wr26DescriptionsFor(options: string[]) {
  const descriptions = wr26SeminarDescriptions as Record<string, string>;
  return Object.fromEntries(
    options.flatMap((option) => (
      descriptions[option] ? [[option, descriptions[option]]] : []
    )),
  );
}

export const BLANK_FORM_KEY = "blank_form";
export const BLANK_CLUB_FORM_KEY = "blank_club_form";

/** The blank form for an event audience (#592): the club variant for CLUB events, the general one otherwise. */
export function blankFormTemplateKey(audience: string | null | undefined) {
  return audience === "CLUB" ? BLANK_CLUB_FORM_KEY : BLANK_FORM_KEY;
}

export function isBlankFormTemplateKey(key: string) {
  return key === BLANK_FORM_KEY || key === BLANK_CLUB_FORM_KEY;
}

/**
 * The template picker's list for one event (#592): the blank form that fits
 * the event's audience first (shown as "Blank form"), the other audience's
 * blank form left out, then the remaining templates in their given order.
 * On a church-billed event (#606) a template that collects card payment is
 * left out too: a deferred-billing event refuses a form with payment enabled.
 */
export function templatesForPicker<T extends { key: string; name: string; collectsPayment?: boolean }>(
  templates: T[],
  eventAudience: string | null | undefined,
  billingMode?: string | null,
): T[] {
  const blankKey = blankFormTemplateKey(eventAudience);
  const blank = templates.find((template) => template.key === blankKey);
  const churchBilled = billingMode === "DEFERRED_ORGANIZATION_INVOICE";
  const rest = templates.filter((template) => !isBlankFormTemplateKey(template.key) && !(churchBilled && template.collectsPayment));
  return blank ? [{ ...blank, name: "Blank form" }, ...rest] : rest;
}

export const formTemplates: FormTemplate[] = [
  {
    key: "simple_rsvp",
    name: "Simple RSVP",
    description: "A short individual response form for meals, meetings, and simple events.",
    audience: "Individual",
    definition: {
      title: "Event RSVP",
      description: "Reserve your place and provide the best way to reach you.",
      confirmationMessage: "Thank you. Your RSVP has been received.",
      sections: [{ id: "section_contact", title: "Your information", description: "Tell us who is attending.", fields: [
        { id: "field_first_name", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "field_last_name", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "field_email", key: "email", label: "Email address", helpText: "We will send event updates here.", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
      ] }],
    },
  },
  {
    key: "retreat_registration",
    name: "Retreat registration",
    description: "Contact, attendance, and lodging questions for a weekend retreat.",
    audience: "Individual or household",
    definition: {
      title: "Women’s Retreat registration",
      description: "Complete this form for each person attending.",
      confirmationMessage: "Your registration has been received.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 8, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
      sections: [
        { id: "section_attendee", title: "Attendee details", description: "Information specific to the person attending.", fields: [
          { id: "field_first_name", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
          { id: "field_last_name", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
          { id: "field_attendee_type", key: "attendee_type", label: "Registration type", helpText: "Choose the closest match.", type: "SELECT", scope: "ATTENDEE", required: true, options: ["Attendee", "Worker"] },
        ] },
        { id: "section_contact", title: "Contact & stay", description: "Used for this event registration.", fields: [
          { id: "field_email", key: "email", label: "Email address", helpText: "Registration confirmation and event updates use this address.", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
          { id: "field_phone", key: "phone", label: "Mobile phone", helpText: "", type: "PHONE", scope: "REGISTRATION", required: false, options: [] },
          { id: "field_lodging", key: "lodging", label: "Lodging preference", helpText: "Choose what best fits this attendee’s plans.", type: "SELECT", scope: "ATTENDEE", required: true, options: ["Conference hotel", "Commuting", "Not sure yet"] },
        ] },
      ],
    },
  },
  {
    key: "household_interest",
    name: "Household interest",
    description: "A lightweight household-oriented form without pricing or payment collection.",
    audience: "Household",
    definition: {
      title: "Household event interest",
      description: "Share a household contact and an estimated party size.",
      confirmationMessage: "Thank you. Your household response has been received.",
      sections: [{ id: "section_household", title: "Household contact", description: "One response per household.", fields: [
        { id: "field_household_name", key: "household_name", label: "Household name", helpText: "For example, Miller household.", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
        { id: "field_email", key: "email", label: "Primary email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
        { id: "field_party_size", key: "party_size", label: "Estimated party size", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: true, options: [] },
      ] }],
    },
  },
  {
    key: "womens_retreat_export",
    name: "Women’s Retreat 2026",
    description: "Primary contact, repeatable attendee roster, shirts, meals, childcare, ranked seminars, late pricing, and payment.",
    audience: "Retreat",
    definition: {
      title: "Women’s Retreat 2026 registration",
      description: "Register each attendee, rank two choices for every breakout block, and review the full amount before submitting.",
      confirmationMessage: "Your Women’s Retreat registration has been received. Check your email for payment and edit-registration details.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
      payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Credit / debit card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true },
      sections: [
        { id: "wr_contact", title: "Primary contact", description: "Confirmation and emergency contact details.", fields: [
          templateField("wr_contact_first", "primary_contact_first_name", "Primary contact first name", "TEXT", true),
          templateField("wr_contact_last", "primary_contact_last_name", "Primary contact last name", "TEXT", true),
          templateField("wr_email", "email", "Primary contact email", "EMAIL", true),
          templateField("wr_phone", "phone", "Primary contact phone", "PHONE", true),
          templateField("wr_church", "church", "Church", "SELECT", true, [], { optionSource: "CHURCHES_DIRECTORY" }),
          templateField("wr_church_other", "church_other", "Church — not listed, or notes", "TEXT", true, [], { conditional: { fieldKey: "church", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("wr_emergency_name", "emergency_contact_name", "Emergency contact name", "TEXT", true),
          templateField("wr_emergency_phone", "emergency_contact_phone", "Emergency contact phone", "PHONE", true),
          templateField("wr_special", "special_needs", "Special needs / accessibility", "LONG_TEXT"),
        ] },
        { id: "wr_attendee", title: "Attendees", description: "Add each person once. Shirt, meal, childcare, and seminar answers stay with that attendee.", fields: [
          templateField("wr_attendee_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("wr_attendee_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("wr_attendee_phone", "attendee_phone", "Phone", "PHONE", false, [], { scope: "ATTENDEE" }),
          templateField("wr_type", "attendee_type", "Attendee type", "RADIO", true, ["Adult", "Teen", "Child"], { scope: "ATTENDEE" }),
          templateField("wr_shirt_size", "shirt_size", "T-shirt size", "SELECT", true, [...shirtSizeOptions], { scope: "ATTENDEE", helpText: "Choose the size this attendee wants for the convention shirt. The private confirmation page can be used to reconfirm it later." }),
          templateField("wr_meal", "meal_preference", "Meal preference", "SELECT", true, ["Standard", "Vegetarian", "Vegan", "Gluten-free", "Other"], { scope: "ATTENDEE" }),
          templateField("wr_dietary", "dietary_needs", "Dietary needs / allergies", "LONG_TEXT", false, [], { scope: "ATTENDEE" }),
          templateField("wr_childcare", "childcare_needed", "Childcare needed?", "RADIO", false, ["No", "Yes"], { scope: "ATTENDEE" }),
          templateField("wr_childcare_details", "childcare_details", "Childcare ages and notes", "LONG_TEXT", false, [], { scope: "ATTENDEE", conditional: { fieldKey: "childcare_needed", operator: "EQUALS", value: "Yes" } }),
          templateField("wr_childcare_children", "childcare_children", "Number of children needing care", "NUMBER", true, [], { scope: "ATTENDEE", conditional: { fieldKey: "childcare_needed", operator: "EQUALS", value: "Yes" }, helpText: "Childcare availability will be confirmed closer to the retreat based on registered need." }),
          templateField("wr_volunteer", "volunteer", "Willing to volunteer to help at the retreat?", "RADIO", true, ["No", "Yes"], { scope: "ATTENDEE" }),
          templateField("wr_session_1", "session_1_preferences", "Friday 4:00–5:00 PM — rank both choices", "RANKED_CHOICE", true, ["Color Me Golden: Embracing Life in Every Season", "Refined by Fire, Revealed in Beauty"], { scope: "ATTENDEE", minSelections: 2, maxSelections: 2, availabilityMode: "RANKED_INTEREST", choiceLimits: {}, optionDescriptions: wr26DescriptionsFor(["Color Me Golden: Embracing Life in Every Season", "Refined by Fire, Revealed in Beauty"]) }),
          templateField("wr_session_2", "session_2_preferences", "Sabbath 2:00–3:15 PM — rank two choices", "RANKED_CHOICE", true, ["Repainted by Grace", "Color Me Open", "Nourished by Color", "Color Me Prayerful: Discovering the Beautiful Ways We Talk With God"], { scope: "ATTENDEE", minSelections: 2, maxSelections: 2, availabilityMode: "RANKED_INTEREST", choiceLimits: {}, optionDescriptions: wr26DescriptionsFor(["Repainted by Grace", "Color Me Open", "Nourished by Color", "Color Me Prayerful: Discovering the Beautiful Ways We Talk With God"]) }),
          templateField("wr_session_3", "session_3_preferences", "Sabbath 4:15–5:30 PM — rank two choices", "RANKED_CHOICE", true, ["Shades of Peace", "Coloring Through the Chaos: Raising Children with Grace and Truth", "Broken Crayons Still Color"], { scope: "ATTENDEE", minSelections: 2, maxSelections: 2, availabilityMode: "RANKED_INTEREST", choiceLimits: {}, optionDescriptions: wr26DescriptionsFor(["Shades of Peace", "Coloring Through the Chaos: Raising Children with Grace and Truth", "Broken Crayons Still Color"]) }),
          templateField("wr_session_4", "session_4_attendance", "Sunday 8:15–9:15 AM — Brushstrokes of Leadership", "RADIO", true, ["Attending", "Not attending"], { scope: "ATTENDEE", optionDescriptions: wr26DescriptionsFor(["Attending"]) }),
          templateField("wr_fee", "registration_fee", "Registration fee", "CALCULATED", false, [], { scope: "ATTENDEE", priceCents: 12500, latePricing: { startsOn: "2026-08-15", label: "Regular registration pricing", priceCents: 14500 } }),
        ] },
        { id: "wr_payment", title: "Payment & acknowledgment", description: "Choose how you would like to pay and review the final amount.", stepLabel: "Payment", isReviewStep: true, fields: [
          templateField("wr_payment_method", "payment_method", "Payment method", "RADIO", true, ["Pay later", "Credit / debit card"]),
          templateField("wr_promo", "promo_code", "Promo code", "TEXT", false, [], { helpText: "Enter a code supplied by the event team, then select Apply." }),
          templateField("wr_notes", "attendee_notes", "Additional notes", "LONG_TEXT", false),
          templateField("wr_ack", "acknowledgment", "Acknowledgment", "CHECKBOX", true, [], { placeholder: "Yes, I understand payment and edit details will be sent by email." }),
        ] },
      ],
    },
  },
  {
    key: "man_camp_export",
    name: "Man Camp 2026",
    description: "Contact and address, party roster, lodging packages, minors and guardians, apparel, dietary needs, and payment.",
    audience: "Camp",
    definition: {
      title: "Man Camp 2026 registration",
      description: "Register everyone in your party, choose each person’s lodging package, and review the total before payment.",
      confirmationMessage: "Your Man Camp registration has been received. A confirmation and payment summary will be sent by email.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 20, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
      payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Credit / debit card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true },
      sections: [
        { id: "mc_contact", title: "Primary contact & address", description: "The person who will receive the party confirmation and payment summary.", fields: [
          templateField("mc_primary_first", "primary_first_name", "First name", "TEXT", true),
          templateField("mc_primary_last", "primary_last_name", "Last name", "TEXT", true),
          templateField("mc_email", "email", "Email", "EMAIL", true),
          templateField("mc_phone", "phone", "Mobile phone", "PHONE", true),
          templateField("mc_address_1", "address_line_1", "Address line 1", "TEXT", true),
          templateField("mc_address_2", "address_line_2", "Address line 2", "TEXT"),
          templateField("mc_city", "city", "City", "TEXT", true),
          templateField("mc_state", "state", "State / province", "TEXT", true),
          templateField("mc_zip", "zip", "ZIP / postal code", "TEXT", true),
          templateField("mc_country", "country", "Country", "SELECT", true, ["United States", "Canada", "Other"]),
          templateField("mc_church", "church", "Church", "SELECT", true, [], { optionSource: "CHURCHES_DIRECTORY" }),
          templateField("mc_church_other", "church_other", "Church — not listed", "TEXT", true, [], { conditional: { fieldKey: "church", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("mc_primary_age", "primary_age", "Primary contact age", "NUMBER", true),
          templateField("mc_primary_accommodations", "primary_accommodations", "Accessibility or accommodation needs", "LONG_TEXT"),
        ] },
        { id: "mc_attendees", title: "Attendee roster", description: "Add every person, including yourself and volunteers. Young Men’s Program is for ages 10–14.", fields: [
          templateField("mc_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("mc_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("mc_age", "attendee_age", "Age", "NUMBER", true, [], { scope: "ATTENDEE" }),
          templateField("mc_program", "program_selection", "Program", "SELECT", true, ["Adult program", "Young Men’s Program (ages 10–14)", "Child / family attendee", "Volunteer / event worker"], { scope: "ATTENDEE" }),
          templateField("mc_package", "registration_package", "Registration / lodging category", "RADIO", true, manCampRegistrationPackages, {
            scope: "ATTENDEE",
            helpText: "Choose the party’s lodging rate for paid attendees. Volunteers are not charged.",
            availabilityMode: "CAPACITY",
            choiceLimits: {},
            choicePricesCents: {
              "Shared cabin — connected restroom": 12000,
              "Shared cabin — detached restroom": 10000,
              "RV hookup": 9000,
              "Tent camping": 8000,
              "Sabbath attendance only": 7000,
              "Volunteer — no registration fee": 0,
            },
          }),
          templateField("mc_shirt", "shirt_size", "Shirt size", "SELECT", false, ["Youth S", "Youth M", "Youth L", "Adult S", "Adult M", "Adult L", "Adult XL", "Adult 2XL", "Adult 3XL"], { scope: "ATTENDEE", helpText: "Shirts are available for attendees registered by the event’s shirt deadline." }),
          templateField("mc_minor", "is_minor", "Is this attendee under 18?", "RADIO", true, ["No", "Yes"], { scope: "ATTENDEE" }),
          templateField("mc_guardian", "guardian_name", "Guardian attending at camp", "TEXT", true, [], { scope: "ATTENDEE", conditional: { fieldKey: "is_minor", operator: "EQUALS", value: "Yes" } }),
          templateField("mc_rv_amp", "rv_amp_service", "RV amp service", "RADIO", true, ["30 amp", "50 amp", "Either / not sure"], { scope: "ATTENDEE", conditional: { fieldKey: "registration_package", operator: "EQUALS", value: "RV hookup" } }),
          templateField("mc_rv_length", "rv_length", "RV length and type", "TEXT", true, [], { scope: "ATTENDEE", conditional: { fieldKey: "registration_package", operator: "EQUALS", value: "RV hookup" } }),
          templateField("mc_dietary", "dietary_needs", "Vegan, gluten-free, or food-allergy needs", "LONG_TEXT", false, [], { scope: "ATTENDEE", helpText: "All meals are vegetarian. Note vegan, gluten-free, and allergy needs." }),
          templateField("mc_accommodations", "accommodations", "Other accommodations", "LONG_TEXT", false, [], { scope: "ATTENDEE" }),
        ] },
        { id: "mc_payment", title: "Review & payment", description: "Card payments include the configured processing fee; cash or check does not.", stepLabel: "Payment", isReviewStep: true, fields: [
          templateField("mc_pay", "payment_method", "Payment option", "RADIO", true, ["Cash or check", "Credit / debit card"]),
          templateField("mc_notes", "registration_notes", "Party notes", "LONG_TEXT"),
        ] },
      ],
    },
  },
  {
    key: "spring_camporee_export",
    name: "Spring Camporee 2026",
    description: "Club contact, campsite footprint, complete roster, duties, activities, meal sponsorship, milestones, and late pricing.",
    audience: "Club / group",
    definition: {
      title: "Spring Camporee 2026 registration",
      description: "Register the club once, add every attendee, and choose duties and activities for the weekend.",
      confirmationMessage: "Your Spring Camporee registration has been received. The calculated registration amount will be invoiced.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add another club member" },
      sections: [
        { id: "sc_club", title: "Club & contact", description: "Select the Pathfinder club and enter the director’s contact information.", fields: [
          templateField("sc_club_name", "club_name", "Pathfinder club", "SELECT", true, [], { optionSource: "CLUBS_DIRECTORY" }),
          templateField("sc_club_other", "club_name_other", "Club name — not listed", "TEXT", true, [], { conditional: { fieldKey: "club_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("sc_director", "director_name", "Club director", "TEXT", true),
          templateField("sc_church", "church_name", "Church", "SELECT", false, [], { optionSource: "CHURCHES_DIRECTORY" }),
          templateField("sc_church_other", "church_name_other", "Church — not listed", "TEXT", true, [], { conditional: { fieldKey: "church_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("sc_email", "email", "Email", "EMAIL", true),
          templateField("sc_phone", "phone", "Mobile phone", "PHONE", true),
        ] },
        { id: "sc_camping", title: "Camping", description: "Describe the full campsite footprint. No generators or pets; hookups require a medical need.", fields: [
          templateField("sc_tents", "tents", "Number of tents and sizes", "TEXT", true),
          templateField("sc_trailers", "trailers", "Trailers", "TEXT", true),
          templateField("sc_canopy", "kitchen_canopy", "Kitchen canopy and size", "TEXT", true),
          templateField("sc_sqft", "total_sqft", "Total square feet needed", "NUMBER", true),
          templateField("sc_neighbor", "camp_next_to", "Club you would like to camp next to", "TEXT"),
        ] },
        { id: "sc_roster", title: "Club roster", description: "Add Pathfinders, TLTs, staff, and children using full first and last names.", fields: [
          templateField("sc_member_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("sc_member_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("sc_member_age", "attendee_age", "Age", "NUMBER", true, [], { scope: "ATTENDEE" }),
          templateField("sc_member_gender", "gender", "Gender", "SELECT", false, ["Female", "Male", "Prefer not to answer"], { scope: "ATTENDEE" }),
          templateField("sc_member_role", "attendee_type", "Roster role", "RADIO", true, ["Pathfinder", "TLT", "Staff", "Child"], { scope: "ATTENDEE" }),
          templateField("sc_member_first_time", "first_time_camper", "First time at Camporee?", "CHECKBOX", false, [], { scope: "ATTENDEE" }),
          templateField("sc_member_medical_personnel", "medical_personnel", "Medical personnel?", "CHECKBOX", false, [], { scope: "ATTENDEE", conditional: { fieldKey: "attendee_type", operator: "EQUALS", value: "Staff" } }),
          templateField("sc_member_master_guide", "master_guide_investiture", "Master Guide investiture?", "CHECKBOX", false, [], { scope: "ATTENDEE", conditional: { fieldKey: "attendee_type", operator: "EQUALS", value: "Staff" } }),
          templateField("sc_member_dietary", "dietary_needs", "Dietary restrictions", "LONG_TEXT", false, [], { scope: "ATTENDEE" }),
          templateField("sc_member_medical_flag", "medical_or_accessibility_need", "Has a medical or accessibility need the club director knows about", "RADIO", false, ["No", "Yes"], { scope: "ATTENDEE", helpText: "No details here — talk with your club director about any support the attendee needs." }),
          templateField("sc_member_fee", "registration_fee", "Registration fee", "CALCULATED", false, [], { scope: "ATTENDEE", priceCents: 900, latePricing: { startsOn: "2026-04-11", label: "Late registration pricing", priceCents: 1400 } }),
        ] },
        { id: "sc_activities", title: "Schedule & activities", description: "Choose the club’s duties and activities. Duty choices can be given limits as assignments fill.", fields: [
          templateField("sc_duties", "duty_areas", "Required duty area", "MULTISELECT", true, ["Flag raising / lowering", "Bathroom clean-up"], { minSelections: 1, maxSelections: 2 }),
          templateField("sc_flag_slots", "flag_slots", "Flag raising / lowering times", "MULTISELECT", true, ["Thursday evening", "Friday morning", "Friday evening", "Saturday morning — TLTs", "Saturday evening"], { minSelections: 1, maxSelections: 5, availabilityMode: "CAPACITY", choiceLimits: {}, conditional: { fieldKey: "duty_areas", operator: "INCLUDES", value: "Flag raising / lowering" } }),
          templateField("sc_bathroom_days", "bathroom_days", "Bathroom clean-up days", "MULTISELECT", true, ["Thursday", "Friday", "Saturday", "Sunday morning"], { minSelections: 1, maxSelections: 4, availabilityMode: "CAPACITY", choiceLimits: {}, conditional: { fieldKey: "duty_areas", operator: "INCLUDES", value: "Bathroom clean-up" } }),
          templateField("sc_special_activities", "special_activities", "Club activities — choose at least one", "MULTISELECT", true, ["Lead mixer Thursday night at vespers", "Special music, poem or skit — Friday vespers", "Adult assist with Oregon Trail Friday afternoon", "Set up chairs in pavilion Friday 4 PM", "Lead singing around campfire at your campsite", "Special music, poem or skit — church or Sabbath School", "Bring a game and/or lead a game Saturday night"], { minSelections: 1, maxSelections: 5 }),
          templateField("sc_friday_type", "friday_special_type", "Friday vespers contribution", "RADIO", true, ["Special music", "Poem", "Skit"], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — Friday vespers" } }),
          templateField("sc_friday_name", "friday_special_name", "Name of Friday special, poem, or skit", "TEXT", true, [], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — Friday vespers" } }),
          templateField("sc_friday_av", "friday_av_equipment", "Friday AV equipment", "MULTISELECT", false, ["CD", "Apple device", "Computer", "AUX"], { maxSelections: 4, conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — Friday vespers" } }),
          templateField("sc_church_type", "church_special_type", "Church / Sabbath School contribution", "RADIO", true, ["Special music", "Poem", "Skit"], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — church or Sabbath School" } }),
          templateField("sc_church_name_special", "church_special_name", "Name of church or Sabbath School special", "TEXT", true, [], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — church or Sabbath School" } }),
          templateField("sc_church_av", "church_av_equipment", "Church / Sabbath School AV equipment", "MULTISELECT", false, ["CD", "Apple device", "Computer", "AUX"], { maxSelections: 4, conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Special music, poem or skit — church or Sabbath School" } }),
          templateField("sc_campfire", "campfire_night", "Campfire singing night", "RADIO", true, ["Friday", "Saturday"], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Lead singing around campfire at your campsite" } }),
          templateField("sc_game_support", "game_support", "Saturday night game help", "MULTISELECT", true, ["Bring a game", "Lead a game"], { minSelections: 1, maxSelections: 2, conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Bring a game and/or lead a game Saturday night" } }),
          templateField("sc_game", "game_name", "Game name", "TEXT", true, [], { conditional: { fieldKey: "game_support", operator: "INCLUDES", value: "Bring a game" } }),
          templateField("sc_oregon", "oregon_trail_adult", "Adult assisting with Oregon Trail", "TEXT", true, [], { conditional: { fieldKey: "special_activities", operator: "INCLUDES", value: "Adult assist with Oregon Trail Friday afternoon" } }),
          templateField("sc_sponsor", "sponsoring_meals", "Will the club sponsor meals?", "RADIO", true, ["No", "Yes"], { helpText: "Sponsoring meals earns a $5 credit per person sponsored, once, off the amount your church owes." }),
          templateField("sc_sponsor_count", "meal_sponsorship_count", "People your club is sponsoring a meal for", "NUMBER", true, [], { helpText: "A $5 credit per person sponsored (once, however many meals) comes off the amount your church owes, up to the number of people registered.", conditional: { fieldKey: "sponsoring_meals", operator: "EQUALS", value: "Yes" }, creditCentsPerUnit: -500, capUnitsAtAttendeeCount: true }),
          templateField("sc_meal_times", "meal_times", "Sponsored meal times", "MULTISELECT", true, ["Friday lunch", "Friday lunch — delivered to office", "Friday supper", "Friday supper — delivered to office", "Sabbath lunch", "Sabbath supper"], { minSelections: 1, maxSelections: 6, conditional: { fieldKey: "sponsoring_meals", operator: "EQUALS", value: "Yes" } }),
          templateField("sc_partner", "partner_club", "Partner club for events", "TEXT"),
          templateField("sc_ribbons", "event_ribbons", "Would your club like event ribbons?", "RADIO", true, ["Yes", "No"]),
          templateField("sc_skit", "sabbath_skit", "Name of the club’s Sabbath afternoon skit", "TEXT", true),
        ] },
        { id: "sc_milestones", title: "Spiritual milestones", description: "Optional names for pastoral and recognition follow-up.", fields: [
          templateField("sc_baptism", "baptism_names", "Names interested in baptism", "LONG_TEXT"),
          templateField("sc_bible", "bible_names", "Names who read the Bible through in a year", "LONG_TEXT"),
        ] },
      ],
    },
  },
  {
    key: "camp_meeting_export",
    name: "Camp Meeting 2026",
    description: "Household contact, capacity-aware housing by night, guest roster, adult and child meal tickets, and payment.",
    audience: "Household / camp",
    definition: {
      title: "Camp Meeting 2026 registration",
      description: "Choose housing and nights, add every guest, order meal tickets, and review the complete total.",
      confirmationMessage: "Your Camp Meeting registration has been received. Watch for an email with confirmation, payment, and check-in details.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 20, attendeeLabel: "Guest", addButtonLabel: "Add another guest" },
      payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Credit / debit card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true },
      sections: [
        { id: "cm_contact", title: "Contact information", description: "Primary household contact and mailing address.", fields: [
          templateField("cm_first", "primary_first_name", "First name", "TEXT", true),
          templateField("cm_middle", "primary_middle_name", "Middle name", "TEXT"),
          templateField("cm_last", "primary_last_name", "Last name", "TEXT", true),
          templateField("cm_address_1", "address_line_1", "Address line 1", "TEXT", true),
          templateField("cm_address_2", "address_line_2", "Address line 2", "TEXT"),
          templateField("cm_city", "city", "City", "TEXT", true),
          templateField("cm_state", "state", "State / province", "TEXT", true),
          templateField("cm_zip", "zip", "ZIP / postal code", "TEXT", true),
          templateField("cm_country", "country", "Country", "SELECT", true, ["United States", "Canada", "Other"]),
          templateField("cm_email", "email", "Email", "EMAIL", true),
          templateField("cm_phone", "phone", "Mobile phone", "PHONE", true),
          templateField("cm_church", "church_name", "Home church", "SELECT", false, [], { optionSource: "CHURCHES_DIRECTORY" }),
          templateField("cm_church_other", "church_other", "Home church — not listed", "TEXT", true, [], { conditional: { fieldKey: "church_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
        ] },
        { id: "cm_housing", title: "Housing selection", description: "Pricing is per night. RV capacity begins at 16 spots and every housing limit can be adjusted.", fields: [
          templateField("cm_housing_choice", "housing_selection", "Housing", "RADIO", true, campMeetingHousingOptions, { availabilityMode: "CAPACITY", choiceLimits: { "RV / camper hookup": 16 } }),
          templateField("cm_dorm_nights", "dorm_nights", "Dorm nights — $25 per night", "MULTISELECT", true, campMeetingNights, { minSelections: 4, maxSelections: 5, choicePricesCents: Object.fromEntries(campMeetingNights.map((night) => [night, 2500])), conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "Dorm room" }, helpText: "Dorm rooms require at least four nights. Each room has two twin beds; bring linens." }),
          templateField("cm_rv_nights", "rv_nights", "RV / camper nights — $15 per night", "MULTISELECT", true, campMeetingNights, { minSelections: 1, maxSelections: 5, choicePricesCents: Object.fromEntries(campMeetingNights.map((night) => [night, 1500])), conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "RV / camper hookup" } }),
          templateField("cm_tent_nights", "tent_nights", "Tent campsite nights — $5 per night", "MULTISELECT", true, campMeetingNights, { minSelections: 1, maxSelections: 5, choicePricesCents: Object.fromEntries(campMeetingNights.map((night) => [night, 500])), conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "Tent campsite" }, helpText: "Primitive camping; no hookups or campfires." }),
          templateField("cm_floor", "first_floor_needed", "First-floor room needed for health or medical reasons?", "RADIO", true, ["No", "Yes"], { conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "Dorm room" } }),
          templateField("cm_rv", "rv_details", "RV / camper length and type", "TEXT", true, [], { conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "RV / camper hookup" } }),
        ] },
        { id: "cm_guests", title: "Guest information", description: "Enter the party totals, then add every adult and child—including yourself—to the guest roster.", fields: [
          templateField("cm_adults", "num_adults", "Number of adults (18 and older)", "NUMBER", true),
          templateField("cm_children", "num_children", "Number of children", "NUMBER", true),
          templateField("cm_guest_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("cm_guest_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("cm_guest_age", "guest_age", "Age", "NUMBER", true, [], { scope: "ATTENDEE", helpText: "Children’s ages are used for Sabbath School class placement." }),
        ] },
        { id: "cm_meals", title: "Meal tickets", description: "Enter combined ticket totals for everyone. Sabbath lunch is donation-only and needs no ticket.", fields: [
          templateField("cm_bf_adult", "breakfast_adult_qty", "Adult breakfast tickets — $7 each", "NUMBER", false, [], { priceCents: 700, helpText: "Available Wednesday through Saturday." }),
          templateField("cm_bf_child", "breakfast_child_qty", "Child breakfast tickets — $6 each", "NUMBER", false, [], { priceCents: 600, helpText: "Available Wednesday through Saturday." }),
          templateField("cm_lunch_adult", "lunch_adult_qty", "Adult lunch tickets — $8 each", "NUMBER", false, [], { priceCents: 800, helpText: "Available Wednesday through Friday." }),
          templateField("cm_lunch_child", "lunch_child_qty", "Child lunch tickets — $7 each", "NUMBER", false, [], { priceCents: 700, helpText: "Available Wednesday through Friday." }),
          templateField("cm_supper_adult", "supper_adult_qty", "Adult supper tickets — $8 each", "NUMBER", false, [], { priceCents: 800, helpText: "Available Tuesday through Saturday." }),
          templateField("cm_supper_child", "supper_child_qty", "Child supper tickets — $7 each", "NUMBER", false, [], { priceCents: 700, helpText: "Available Tuesday through Saturday." }),
          templateField("cm_dietary", "dietary_restrictions", "Dietary restrictions or allergies", "LONG_TEXT"),
        ] },
        { id: "cm_payment", title: "Review & payment", description: "Card payments include the processing fee. Checks require a $65 deposit to hold the reservation.", stepLabel: "Payment", isReviewStep: true, fields: [
          templateField("cm_pay", "payment_method", "Payment method", "RADIO", true, ["Pay by check", "Credit / debit card"]),
          templateField("cm_deposit", "check_deposit_acknowledgment", "Check deposit acknowledgment", "CHECKBOX", true, [], { conditional: { fieldKey: "payment_method", operator: "EQUALS", value: "Pay by check" }, placeholder: "I understand a $65 mailed deposit is required to hold this reservation." }),
          templateField("cm_comments", "comments", "Comments", "LONG_TEXT"),
        ] },
      ],
    },
  },
  {
    key: "honors_weekend",
    name: "Honors Weekend",
    description: "Club contact and a complete roster for church-billed honor class registration. Add each site under Event settings → Locations; clubs pick a site when they register, and each site has its own sessions and classes.",
    audience: "Club / group",
    definition: {
      title: "Honors Weekend registration",
      description: "Register the club once and add every attendee who is going. Honor class choices are made after the roster is saved.",
      confirmationMessage: "Your Honors Weekend registration has been received. The calculated registration amount will be invoiced to your church.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add another club member" },
      sections: [
        { id: "hw_club", title: "Club & contact", description: "Select the Pathfinder club and enter the director’s contact information.", fields: [
          templateField("hw_club_name", "club_name", "Pathfinder club", "SELECT", true, [], { optionSource: "CLUBS_DIRECTORY" }),
          templateField("hw_club_other", "club_name_other", "Club name — not listed", "TEXT", true, [], { conditional: { fieldKey: "club_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("hw_director", "director_name", "Club director", "TEXT", true),
          templateField("hw_church", "church_name", "Church", "SELECT", false, [], { optionSource: "CHURCHES_DIRECTORY" }),
          templateField("hw_church_other", "church_name_other", "Church — not listed", "TEXT", true, [], { conditional: { fieldKey: "church_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("hw_email", "email", "Email", "EMAIL", true),
          templateField("hw_phone", "phone", "Mobile phone", "PHONE", true),
        ] },
        { id: "hw_roster", title: "Club roster", description: "Add Pathfinders, TLTs, staff, other adults, and children attending this site, using full first and last names. Honor classes are selected after the roster is saved.", fields: [
          templateField("hw_member_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("hw_member_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("hw_member_age", "attendee_age", "Age", "NUMBER", true, [], { scope: "ATTENDEE" }),
          templateField("hw_member_gender", "gender", "Gender", "SELECT", false, ["Female", "Male", "Prefer not to answer"], { scope: "ATTENDEE" }),
          templateField("hw_member_role", "attendee_type", "Roster role", "RADIO", true, ["Pathfinder", "TLT", "Staff", "Child"], { scope: "ATTENDEE", helpText: "Class seats follow each person’s type on the club roster, not this answer." }),
          templateField("hw_member_dietary", "dietary_needs", "Dietary restrictions", "LONG_TEXT", false, [], { scope: "ATTENDEE" }),
          templateField("hw_member_medical_flag", "medical_or_accessibility_need", "Has a medical or accessibility need the club director knows about", "RADIO", false, ["No", "Yes"], { scope: "ATTENDEE", helpText: "No details here — talk with your club director about any support the attendee needs." }),
          templateField("hw_member_fee", "registration_fee", "Registration fee", "CALCULATED", false, [], { scope: "ATTENDEE" }),
        ] },
      ],
    },
  },
  {
    key: "pbe_registration",
    name: "Pathfinder Bible Experience",
    description: "One team's registration: the team coordinator, a partner club for a joint team, the team members (with one alternate) and coaches, the director's confirmation and the photo release. Use with the Pathfinder Bible Experience starter, which sets teams per club, team size, the alternate and the age rule. Free: no fee fields.",
    audience: "Club / group",
    definition: {
      title: "Pathfinder Bible Experience team registration",
      description: "Register one team. A club can enter more than one team, each with its own name. Team members are inducted Pathfinders and TLTs; adults who come with the team register as coaches and do not count toward the team.",
      confirmationMessage: "Your Pathfinder Bible Experience team registration has been received. There is no fee.",
      attendeeRoster: { enabled: true, minAttendees: 2, maxAttendees: 20, attendeeLabel: "Team member or coach", addButtonLabel: "Add another team member or coach" },
      sections: [
        { id: "pbe_club", title: "Club & contact", description: "Select the Pathfinder club and enter the director’s contact information.", fields: [
          templateField("pbe_club_name", "club_name", "Pathfinder club", "SELECT", true, [], { optionSource: "CLUBS_DIRECTORY" }),
          templateField("pbe_club_other", "club_name_other", "Club name — not listed", "TEXT", true, [], { conditional: { fieldKey: "club_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("pbe_church", "church_name", "Church", "SELECT", false, [], { optionSource: "CHURCHES_DIRECTORY" }),
          templateField("pbe_church_other", "church_name_other", "Church — not listed", "TEXT", true, [], { conditional: { fieldKey: "church_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("pbe_director", "director_name", "Pathfinder director", "TEXT", true),
          templateField("pbe_email", "email", "Director or club email", "EMAIL", true),
          templateField("pbe_phone", "phone", "Director contact number", "PHONE", true),
        ] },
        { id: "pbe_coordinator", title: "Team coordinator", description: "We would like a contact person’s name and number to be able to send out updates and information as needed. This starts as the club director; change it if someone else leads the team.", fields: [
          templateField("pbe_coord_name", "coordinator_name", "Contact person / team coordinator", "TEXT", true),
          templateField("pbe_coord_address", "coordinator_address", "Address", "TEXT", true),
          templateField("pbe_coord_city", "coordinator_city", "City", "TEXT", true),
          templateField("pbe_coord_state", "coordinator_state", "State", "TEXT", true),
          templateField("pbe_coord_zip", "coordinator_zip", "Zip", "TEXT", true),
          templateField("pbe_coord_phone", "coordinator_phone", "Phone", "PHONE", true),
          templateField("pbe_coord_email", "coordinator_email", "Email", "EMAIL", true),
          templateField("pbe_partner", "partner_club", "Partner club (joint team)", "TEXT", false, [], { helpText: "A club with 4 or fewer interested Pathfinders may join with one other club. Name the other club here, and add its Pathfinders under Who’s going as people not on your roster." }),
        ] },
        { id: "pbe_roster", title: "Team members and coaches", description: "A team has 2 to 7 team members. The 7th is the alternate. Adults and staff are coaches: they are listed with the team and do not count toward the 2 to 7. All adults 18 and over must complete NAD background screening, and all drivers with passengers must be 21 or over.", fields: [
          templateField("pbe_member_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("pbe_member_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("pbe_member_age", "attendee_age", "Age", "NUMBER", true, [], { scope: "ATTENDEE", helpText: "Counted on the date set for this event, not the event day." }),
          templateField("pbe_member_role", "attendee_type", "Role", "RADIO", true, ["Pathfinder", "TLT", "Coach"], { scope: "ATTENDEE", helpText: "Team members are inducted Pathfinders or TLTs, in good standing, who have not graduated from high school. Adults are coaches." }),
          templateField("pbe_member_alternate", "alternate", "Alternate team member", "CHECKBOX", false, [], { scope: "ATTENDEE", placeholder: "This team member is the alternate.", helpText: "At most one team member is the alternate. If a team member is absent, they can still go on to the next level if the team qualifies." }),
        ] },
        { id: "pbe_confirmation", title: "Director confirmation & release", description: "A checked box replaces the director’s signature. The date is recorded when you submit.", fields: [
          templateField("pbe_confirm", "director_confirmation", "Director confirmation", "CHECKBOX", true, [], { placeholder: "I confirm this about every team member.", helpText: "Every team member is an inducted Pathfinder/TLT in good standing, has not graduated from high school, and is within the event's age limit on the age date shown in the team rules." }),
          templateField("pbe_release", "photo_video_release", "Photo, video and liability release", "RADIO", true, ["Yes", "No"], { helpText: "Do you understand and agree with the release below?", optionDescriptions: { Yes: "Participants agree to be photographed and/or videotaped by or on behalf of the IA-MO Conference Youth Department during Youth Department events, and grants the IA-MO Conference Youth Department permission to use any such photographs and/or videotapes in any future promotional and/or advertising publications, and further releases Camp Heritage and/or the Conference from any and all liability in connection with such use." } }),
        ] },
      ],
    },
  },
  {
    key: BLANK_FORM_KEY,
    name: "Blank form",
    description: "Just a Contact section (first name, last name, email, phone). Add your own questions. No fees.",
    audience: "Blank form",
    definition: {
      title: "Event registration",
      description: "",
      confirmationMessage: "Thank you. Your registration has been received.",
      sections: [{ id: "section_contact", title: "Contact", description: "", fields: [
        { id: "field_first_name", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "field_last_name", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "field_email", key: "email", label: "Email address", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
        { id: "field_phone", key: "phone", label: "Phone", helpText: "", type: "PHONE", scope: "REGISTRATION", required: false, options: [] },
      ] }],
    },
  },
  {
    key: BLANK_CLUB_FORM_KEY,
    name: "Blank form (club event)",
    description: "Club and contact section plus an empty club roster with name and role fields. Add your own questions. No fees.",
    audience: "Blank form",
    definition: {
      title: "Club event registration",
      description: "Register the club once and add every attendee who is going.",
      confirmationMessage: "Thank you. Your club registration has been received.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add another club member" },
      sections: [
        { id: "blank_club", title: "Club & contact", description: "Select the Pathfinder club and enter the director’s contact information.", fields: [
          templateField("blank_club_name", "club_name", "Pathfinder club", "SELECT", true, [], { optionSource: "CLUBS_DIRECTORY" }),
          templateField("blank_club_other", "club_name_other", "Club name — not listed", "TEXT", true, [], { conditional: { fieldKey: "club_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("blank_director", "director_name", "Club director", "TEXT", true),
          templateField("blank_church", "church_name", "Church", "SELECT", false, [], { optionSource: "CHURCHES_DIRECTORY" }),
          templateField("blank_church_other", "church_name_other", "Church — not listed", "TEXT", true, [], { conditional: { fieldKey: "church_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
          templateField("blank_email", "email", "Email", "EMAIL", true),
          templateField("blank_phone", "phone", "Mobile phone", "PHONE", true),
        ] },
        { id: "blank_roster", title: "Club roster", description: "Add each attendee using their full first and last name.", fields: [
          templateField("blank_member_first", "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("blank_member_last", "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
          templateField("blank_member_age", "attendee_age", "Age", "NUMBER", false, [], { scope: "ATTENDEE" }),
          templateField("blank_member_role", "attendee_type", "Roster role", "RADIO", true, ["Pathfinder", "TLT", "Staff", "Child"], { scope: "ATTENDEE" }),
        ] },
      ],
    },
  },
];

/**
 * Fall Camporee (#593), derived from the Spring Camporee export so the club
 * contact fields and the roster fields stay in step: only the club section,
 * the tents and kitchen canopy, and the roster carry over. Spring's duties,
 * special activities, meal sponsorship and milestones are left out. The fee
 * field deliberately has no amount: pricing is a human decision, and
 * readiness flags it ("Set the Fall Camporee fee").
 */
function buildFallCamporeeTemplate(spring: FormTemplate): FormTemplate {
  const rekey = (id: string) => id.replace(/^sc_/, "fc_");
  const section = (id: string) => {
    const found = spring.definition.sections.find((entry) => entry.id === id);
    if (!found) throw new Error(`Spring Camporee section ${id} is missing.`);
    return found;
  };
  const cloneFields = (fields: RegistrationFormField[]) => fields.map((field) => ({ ...field, id: rekey(field.id) }));
  const camping = section("sc_camping");
  const roster = section("sc_roster");
  return {
    key: "fall_camporee",
    name: "Fall Camporee",
    description: "Club contact, campsite needs, complete roster, photo and video release, and the adult Sterling Volunteers requirement. No prices are set.",
    audience: "Club / group",
    definition: {
      title: "Fall Camporee registration",
      description: "Register the club once, choose the Camporee location, and add every attendee.",
      confirmationMessage: "Your Fall Camporee registration has been received. The calculated registration amount will be invoiced.",
      attendeeRoster: { ...spring.definition.attendeeRoster!, enabled: true },
      sections: [
        { ...section("sc_club"), id: "fc_club", fields: cloneFields(section("sc_club").fields) },
        {
          id: "fc_camping",
          title: "Camping",
          description: "Describe the campsite the club needs.",
          fields: cloneFields(camping.fields.filter((field) => field.key === "tents" || field.key === "kitchen_canopy")),
        },
        {
          ...roster,
          id: "fc_roster",
          fields: cloneFields(roster.fields).map((field) => field.key === "registration_fee"
            ? templateField(field.id, "registration_fee", "Fall Camporee fee", "CALCULATED", false, [], { scope: "ATTENDEE" })
            : field),
        },
        { id: "fc_acknowledgments", title: "Release & Sterling Volunteers", description: "The director confirms both before submitting.", fields: [
          templateField("fc_photo_release", "photo_video_release", "Photo and video release", "CHECKBOX", true, [], { placeholder: "I give permission for photos and video of our club's members to be taken and used by the Camporee organizers." }),
          templateField("fc_background_ack", "background_check_acknowledgment", "Adult Sterling Volunteers", "CHECKBOX", true, [], { placeholder: "I understand every adult attending with our club must be in compliance with Sterling Volunteers." }),
        ] },
      ],
    },
  };
}

{
  const springIndex = formTemplates.findIndex((template) => template.key === "spring_camporee_export");
  if (springIndex >= 0) formTemplates.splice(springIndex + 1, 0, buildFallCamporeeTemplate(formTemplates[springIndex]!));
}

/**
 * The 2026 Fluent Forms turned into templates (#606). Four are the forms of
 * event starters (Leadership Weekend, TLT Retreat, Outdoor School, Hispanic
 * Institute of Evangelism); three are add-on forms picked from the builder's
 * template list (TLT Opportunities and the two "of the Year" nominations).
 *
 * Conventions: club and church answers come from the directories (with the
 * "Not listed" fallback and a text field), names are first/last name or the
 * `contact_name` full-name key, email and phone use the ordinary `email` and
 * `phone` keys. Nothing asks about driving, and nothing collects medical
 * details. Prices are the 2026 amounts, only where the pricing features express
 * them; a fee with no known amount is left unset so readiness flags it.
 */
const directoryClub = (prefix: string, key: string, label: string, extra: Partial<RegistrationFormField> = {}) => [
  templateField(`${prefix}_club`, key, label, "SELECT", true, [], { optionSource: "CLUBS_DIRECTORY", ...extra }),
  templateField(`${prefix}_club_other`, `${key}_other`, `${label} — not listed`, "TEXT", true, [], { conditional: { fieldKey: key, operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
];

const directoryChurch = (prefix: string) => [
  templateField(`${prefix}_church`, "church_name", "Home church", "SELECT", true, [], { optionSource: "CHURCHES_DIRECTORY" }),
  templateField(`${prefix}_church_other`, "church_name_other", "Home church — not listed", "TEXT", true, [], { conditional: { fieldKey: "church_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } }),
];

const attendeeName = (prefix: string) => [
  templateField(`${prefix}_first`, "first_name", "First name", "TEXT", true, [], { scope: "ATTENDEE" }),
  templateField(`${prefix}_last`, "last_name", "Last name", "TEXT", true, [], { scope: "ATTENDEE" }),
];

const leadershipTracks = ["Basic Staff Training Certification", "Spanish Basic Staff Training", "Master Guide", "New Directors", "Pathfinder Directors", "Pathfinder Counselor Jumpstart", "TLT Class for Directors", "N/A"];

const leadershipWeekendTemplate: FormTemplate = {
  key: "leadership_weekend",
  name: "Pathfinder Leadership Weekend",
  description: "Leader information, training track, lodging and meals with early-bird pricing, and the church-billing agreement. Individuals register; their church is billed after the event.",
  audience: "Individual",
  definition: {
    title: "Pathfinder Leadership Weekend registration",
    description: "Location: Camp Heritage. Due September 1; early bird discount until August 24.",
    confirmationMessage: "Your Leadership Weekend registration has been received. Your church will be billed for lodging and meals after the event.",
    sections: [
      { id: "lw_info", title: "Your information", description: "Tell us who is attending and which club and church you serve with.", fields: [
        ...attendeeName("lw"),
        templateField("lw_gender", "gender", "Gender", "RADIO", true, ["Male", "Female"], { scope: "ATTENDEE" }),
        templateField("lw_email", "email", "Email", "EMAIL", true),
        templateField("lw_position", "club_position", "Club position", "TEXT", true),
        templateField("lw_phone", "phone", "Mobile phone", "PHONE", true),
        templateField("lw_years", "years_as_leader", "Years as a leader", "NUMBER", true, [], { ageBounds: { minimumAge: 0, maximumAge: 100 } }),
        ...directoryClub("lw", "pathfinder_club", "Pathfinder club"),
        ...directoryChurch("lw"),
        templateField("lw_address", "mailing_address", "Mailing address", "ADDRESS", false),
      ] },
      { id: "lw_training", title: "Training track", description: "Choose the class track you will attend.", fields: [
        templateField("lw_track", "training_track", "Track", "RADIO", true, leadershipTracks, { scope: "ATTENDEE", helpText: "Duplicate leadership classes in two different tracks attended within a 3-year period only have to be attended one time. You must show proof of attendance to an Area Coordinator." }),
        templateField("lw_inducted", "induction", "Would you like to be inducted?", "RADIO", true, ["Yes", "No"], { scope: "ATTENDEE" }),
        templateField("lw_teaching", "teaching_class", "Will you be teaching a class?", "RADIO", true, ["Yes", "No"], { scope: "ATTENDEE" }),
      ] },
      { id: "lw_lodging", title: "Lodging & meals", description: "Classes start Friday 7:00 p.m.; Vespers 8:15 p.m. Camping has bathhouse facilities and RV hookups. Youth cabins have A/C and heat. Bring your own bedding and towels. No pets are allowed at Camp Heritage. Please bring your manuals for updates.", fields: [
        templateField("lw_lodging_choice", "lodging", "Lodging", "RADIO", true, ["Tent or Camper", "Youth Cabin", "Child under 10"], {
          scope: "ATTENDEE",
          helpText: "Early-bird prices apply until August 24; regular prices start August 24.",
          choicePricesCents: { "Tent or Camper": 2500, "Youth Cabin": 3500, "Child under 10": 2500 },
          latePricing: { startsOn: "2026-08-24", label: "Regular pricing", choicePricesCents: { "Tent or Camper": 3500, "Youth Cabin": 4500 } },
        }),
        templateField("lw_room_with", "room_with", "I would like to room with", "TEXT", false, [], { scope: "ATTENDEE" }),
        templateField("lw_meals", "meals", "Meals", "MULTISELECT", false, ["Friday Supper", "Sabbath Breakfast", "Sabbath Lunch", "Sabbath Supper", "Sunday Breakfast"], { scope: "ATTENDEE", helpText: "All meals are vegetarian." }),
        templateField("lw_dietary", "dietary_needs", "Dietary needs", "MULTISELECT", false, ["Vegan", "Gluten Free"], { scope: "ATTENDEE" }),
      ] },
      { id: "lw_agreement", title: "Agreement", description: "Confirm before submitting.", fields: [
        templateField("lw_billing_ack", "church_billing_acknowledgment", "Church billing", "CHECKBOX", true, [], { placeholder: "I understand my church will be billed for lodging and meals after the event." }),
      ] },
    ],
  },
};

const areaCoordinatorExcused = { fieldKey: "tlt_year", operator: "EQUALS", value: "Area Coordinator/Teacher" } as const;

const tltRetreatTemplate: FormTemplate = {
  key: "tlt_retreat",
  name: "TLT Retreat",
  description: "Participant, TLT year, club and director, dietary choice, and the retreat acknowledgments. No fees. One form for both the spring and fall retreats.",
  audience: "Individual",
  definition: {
    title: "TLT Retreat registration",
    description: "Register once for the TLT Retreat. There is no registration fee.",
    confirmationMessage: "Your TLT Retreat registration has been received. Check your email for details.",
    sections: [
      { id: "tr_participant", title: "Participant", description: "", fields: [
        ...attendeeName("tr"),
        templateField("tr_email", "email", "Participant email", "EMAIL", true),
        templateField("tr_year", "tlt_year", "TLT year", "RADIO", true, ["Year 1", "Year 2", "Year 3", "Year 4", "Staff/Chaperone", "Area Coordinator/Teacher"]),
      ] },
      { id: "tr_club", title: "Club & director", description: "Area Coordinators and teachers may leave the club and director questions blank.", fields: [
        ...directoryClub("tr", "club_name", "Pathfinder club", { optionalWhen: areaCoordinatorExcused }),
        templateField("tr_director", "club_director_name", "Club director name", "TEXT", true, [], { optionalWhen: areaCoordinatorExcused }),
        templateField("tr_director_email", "club_director_email", "Club director email", "EMAIL", true, [], { optionalWhen: areaCoordinatorExcused }),
      ] },
      { id: "tr_dietary", title: "Dietary needs", description: "", fields: [
        templateField("tr_diet", "dietary_needs", "Dietary needs", "RADIO", true, ["Vegan", "Gluten Free", "Both", "Neither"], { scope: "ATTENDEE" }),
      ] },
      { id: "tr_acknowledgments", title: "Acknowledgments", description: "Each participant confirms these before submitting.", fields: [
        templateField("tr_recommendations", "recommendation_forms", "I have registered and submitted three recommendation forms.", "RADIO", false, ["Yes", "N/A"], { helpText: "Spring retreat only. Leave blank at the fall retreat." }),
        templateField("tr_application_ack", "application_approved_acknowledgment", "Application approved", "CHECKBOX", true, [], { placeholder: "I understand that to attend the retreat I need to have completed my application and been approved." }),
        templateField("tr_health_ack", "health_record_acknowledgment", "Health record on file", "CHECKBOX", true, [], { placeholder: "I have a health record on file with my club and will bring a copy with me." }),
        templateField("tr_chaperone_ack", "chaperone_acknowledgment", "Attending with a chaperone", "CHECKBOX", true, [], { placeholder: "I will be attending with a staff member or chaperone from my club." }),
      ] },
    ],
  },
};

const outdoorSchoolTemplate: FormTemplate = {
  key: "outdoor_school",
  name: "Outdoor School",
  description: "School and contact, sponsors, a student roster, food and logistics, and the What to Bring reminder. The school is billed after the event; the fee has no amount set.",
  audience: "School group",
  definition: {
    title: "Outdoor School registration",
    description: "Location: Camp Heritage. The school will be billed for fees after the event. Please submit this registration by the deadline.",
    confirmationMessage: "Your Outdoor School registration has been received. The school will be billed for fees after the event.",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Student", addButtonLabel: "Add another student" },
    sections: [
      { id: "os_school", title: "School & contact", description: "The school named here is the one billed after the event.", fields: [
        templateField("os_school_name", "responsible_organization", "School name", "TEXT", true),
        templateField("os_contact", "contact_name", "Registering teacher or contact name", "TEXT", true, [], { helpText: "First and last name." }),
        templateField("os_email", "email", "Contact email", "EMAIL", true),
        templateField("os_phone", "phone", "Contact phone", "PHONE", true),
      ] },
      { id: "os_sponsors", title: "Sponsors", description: "Your school must provide both a male and a female sponsor if you have both boys and girls. If that isn't possible, you may ask another school whether their sponsor will be responsible for your students in the boys' or girls' cabins.", fields: [
        templateField("os_male_1", "male_sponsor_1", "Male Sponsor 1", "TEXT"),
        templateField("os_male_2", "male_sponsor_2", "Male Sponsor 2", "TEXT"),
        templateField("os_female_1", "female_sponsor_1", "Female Sponsor 1", "TEXT"),
        templateField("os_female_2", "female_sponsor_2", "Female Sponsor 2", "TEXT"),
      ] },
      { id: "os_students", title: "Students", description: "Add each student once, using full first and last names.", fields: [
        ...attendeeName("os"),
        templateField("os_age", "attendee_age", "Age", "NUMBER", true, [], { scope: "ATTENDEE" }),
        templateField("os_gender", "gender", "Gender", "RADIO", true, ["Male", "Female"], { scope: "ATTENDEE" }),
        templateField("os_fee", "registration_fee", "Outdoor School fee", "CALCULATED", false, [], { scope: "ATTENDEE" }),
      ] },
      { id: "os_food", title: "Food & logistics", description: "", fields: [
        templateField("os_dietary", "dietary_needs", "Dietary needs", "LONG_TEXT", false, [], { helpText: "Vegetarian meals will be provided." }),
        templateField("os_sack_lunches", "sack_lunches_thursday", "Number of sack lunches needed for Thursday", "NUMBER", false),
      ] },
      { id: "os_before", title: "Before you come", description: "Please review the What to Bring list.", fields: [
        templateField("os_bring_ack", "what_to_bring_reviewed", "What to Bring list", "CHECKBOX", false, [], { placeholder: "I have reviewed the What to Bring list." }),
      ] },
    ],
  },
};

const hispanicInstituteTemplate: FormTemplate = {
  key: "hispanic_institute",
  name: "Hispanic Institute of Evangelism",
  description: "Attendee and church, the $50 semester registration (2026 price), and card payment with the platform's card fee. Use on an attendee-pay event.",
  audience: "Individual",
  definition: {
    title: "Hispanic Institute of Evangelism registration",
    description: "Register for the semester, January to June.",
    confirmationMessage: "Your Hispanic Institute of Evangelism registration has been received. Check your email for payment details.",
    payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Credit / debit card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true },
    sections: [
      { id: "hi_attendee", title: "Attendee", description: "", fields: [
        ...attendeeName("hi"),
        ...directoryChurch("hi"),
        templateField("hi_position", "church_position", "Position in church", "TEXT", true),
        templateField("hi_phone", "phone", "Phone", "PHONE", true),
        templateField("hi_email", "email", "Email", "EMAIL", true),
      ] },
      { id: "hi_semester", title: "Semester registration", description: "", fields: [
        templateField("hi_fee", "registration_fee", "Semester registration, January to June", "CALCULATED", false, [], { scope: "ATTENDEE", priceCents: 5000 }),
      ] },
      { id: "hi_payment", title: "Payment & comments", description: "Card payments include the configured processing fee.", stepLabel: "Payment", isReviewStep: true, fields: [
        templateField("hi_pay", "payment_method", "Payment option", "RADIO", true, ["Pay later", "Credit / debit card"]),
        templateField("hi_comments", "comments", "Comments", "LONG_TEXT", false),
      ] },
    ],
  },
};

const tltSetupOpportunity = "Come early to set up campsites, fire rings, decorations, chairs/pavilion and trash barrels";
const tltOfficeOpportunity = "Help in the office for 1 hour with registration (Thu 3–6 PM)";
const tltPraiseTeamOpportunity = "Be on the praise team";
const tltLeadershipOpportunities = [
  tltSetupOpportunity,
  "Take pictures during camporee (bring your own camera)",
  tltOfficeOpportunity,
  "Call Pathfinders to attention and give and receive the flag for flag raising/lowering",
  "Lead the Pathfinder Song (English or Spanish)",
  "Play drums and lead the clubs to the flag at flag raising/lowering",
  "Play taps or reveille at flag raising/lowering",
  "Give out prizes after the flag ceremony",
  "Direct clubs where to stand for flag raising/lowering",
  "Ring the bell 10 minutes before each activity",
  "Read a cool fact about the flag at Saturday flag lowering",
  "Be MC at vespers, Sabbath School, Sabbath afternoon skits and worship",
  tltPraiseTeamOpportunity,
  "Score events in the office (Friday 4 PM)",
  "Be on the campsite inspection team (Friday 5 PM)",
  "Friday night trash removal before sunset",
  "Be on the uniform inspection team Saturday morning",
  "Pass out awards and trophies Saturday night",
  "Help with games Saturday night",
  "Town Crier",
  "Clean up Sunday morning",
];
const tltFridayMorningEvents = ["Lest We Forget matching game", "Marching out west blindfolded", "Canoe or duct tape boat races", "Build a fire without matches", "Which way is West", "Two-man saw", "Surprise"];
const tltOregonTrailStations = [
  "Bank and General Store",
  "Newspaper Office (need someone with a camera)",
  "Robber",
  "Archery",
  "Worship (say memory verses)",
  "Log in the road",
  "Injured family member (patch up a broken arm)",
  "Trade with the Native Americans",
  "Old-fashioned hoop game",
  "Fishing at the gaga ball pit",
  "Panning for gold",
  "Meet at the flag pole to add up scores",
];
const tltShirtTypes = ["Polo", "T-Shirt"];
const tltShirtSizes = ["Adult S", "Adult M", "Adult L", "Adult XL", "Adult 2XL"];
const tltMeetingNote = "There will be a meeting Thursday night in the Lodge right after activities to go over the schedule.";

const tltOpportunitiesTemplate: FormTemplate = {
  key: "tlt_opportunities",
  name: "TLT Opportunities",
  description: "Add-on form for Spring Camporee: TLT sign-up for leadership opportunities, Friday events and the Oregon Trail, and TLT shirts. No fees.",
  audience: "Individual",
  definition: {
    title: "TLT Opportunities",
    description: "Dear TLT, we need your help to make this the best camporee ever. Please sign up for any areas that interest you, and get approval from your director before submitting.",
    confirmationMessage: `Thank you for signing up. ${tltMeetingNote}`,
    sections: [
      { id: "to_details", title: "TLT details", description: "", fields: [
        ...attendeeName("to"),
        ...directoryClub("to", "club_name", "Pathfinder club"),
        templateField("to_email", "email", "Email", "EMAIL", true),
        templateField("to_phone", "phone", "Phone", "PHONE", true),
      ] },
      { id: "to_leadership", title: "Leadership opportunities", description: "Choose every area you would like to help with.", fields: [
        templateField("to_opportunities", "leadership_opportunities", "Leadership opportunities", "MULTISELECT", false, tltLeadershipOpportunities, {
          optionDescriptions: { [tltSetupOpportunity]: "Thursday breakfast and lunch are provided; you can sleep in the cabins Wednesday night." },
        }),
        templateField("to_office_arrival", "office_arrival_time", "If helping in the office, arrival time?", "TEXT", true, [], { conditional: { fieldKey: "leadership_opportunities", operator: "INCLUDES", value: tltOfficeOpportunity } }),
        templateField("to_praise_role", "praise_team_role", "Praise team role", "TEXT", true, [], { conditional: { fieldKey: "leadership_opportunities", operator: "INCLUDES", value: tltPraiseTeamOpportunity } }),
      ] },
      { id: "to_friday", title: "Friday events", description: "Optional. Choose the events you would like to help with.", fields: [
        templateField("to_friday_morning", "friday_morning_events", "Friday morning events (9–12)", "MULTISELECT", false, tltFridayMorningEvents),
        templateField("to_oregon_trail", "oregon_trail_stations", "Friday afternoon Oregon Trail (2–4)", "MULTISELECT", false, tltOregonTrailStations),
      ] },
      { id: "to_shirt", title: "Shirt & meeting", description: tltMeetingNote, fields: [
        templateField("to_need_shirt", "need_tlt_shirt", "Need a TLT shirt?", "RADIO", true, ["Yes", "No"], { scope: "ATTENDEE" }),
        templateField("to_shirt_type", "shirt_type", "Shirt type", "RADIO", true, tltShirtTypes, { scope: "ATTENDEE", conditional: { fieldKey: "need_tlt_shirt", operator: "EQUALS", value: "Yes" } }),
        templateField("to_shirt_size", "shirt_size", "Shirt size", "SELECT", true, tltShirtSizes, { scope: "ATTENDEE", conditional: { fieldKey: "need_tlt_shirt", operator: "EQUALS", value: "Yes" } }),
        templateField("to_trade_in", "trading_in_old_shirt", "Trading in an old shirt?", "RADIO", true, ["Yes", "No"], { scope: "ATTENDEE" }),
        templateField("to_trade_type", "trade_in_shirt_type", "Old shirt type", "RADIO", true, tltShirtTypes, { scope: "ATTENDEE", conditional: { fieldKey: "trading_in_old_shirt", operator: "EQUALS", value: "Yes" } }),
        templateField("to_trade_size", "trade_in_shirt_size", "Old shirt size", "SELECT", true, tltShirtSizes, { scope: "ATTENDEE", conditional: { fieldKey: "trading_in_old_shirt", operator: "EQUALS", value: "Yes" } }),
      ] },
    ],
  },
};

/** The Pathfinder of the Year and TLT of the Year nominations share one shape (#606). */
function buildYearNominationTemplate(kind: "Pathfinder" | "TLT"): FormTemplate {
  const prefix = kind === "Pathfinder" ? "poy" : "toy";
  const classes = ["Friend", "Friend Adv", "Companion", "Companion Adv", "Explorer", "Explorer Adv", ...(kind === "Pathfinder" ? ["Ranger", "Ranger Adv"] : [])];
  const essay = (id: string, key: string, label: string) => templateField(`${prefix}_${id}`, key, label, "LONG_TEXT", true);
  return {
    key: kind === "Pathfinder" ? "pathfinder_of_the_year" : "tlt_of_the_year",
    name: `${kind} of the Year nomination`,
    description: `Nominee, attendance, classes, Good Conduct Award, and five essay questions for the ${kind} of the Year award. No fees.`,
    audience: "Individual",
    definition: {
      title: `${kind} of the Year nomination`,
      description: `Nominate a ${kind} for ${kind} of the Year.`,
      confirmationMessage: `Your ${kind} of the Year nomination has been received. Thank you.`,
      sections: [
        { id: `${prefix}_nominee`, title: "Nominee", description: "", fields: [
          templateField(`${prefix}_nominee_name`, "nominee_name", `Name of the ${kind} nominated`, "TEXT", true),
          ...directoryClub(prefix, "club_name", "Pathfinder club"),
          templateField(`${prefix}_nominated_by`, "contact_name", "Nominated by", "TEXT", true, [], { helpText: "First and last name." }),
          templateField(`${prefix}_email`, "email", "Your email", "EMAIL", true, [], { helpText: "A confirmation is sent here." }),
          templateField(`${prefix}_age`, "nominee_age", "Age as of May 1 of the current year", "NUMBER", true, [], { ageBounds: { minimumAge: 0, maximumAge: 120 } }),
        ] },
        { id: `${prefix}_record`, title: "Attendance, classes & conduct", description: "", fields: [
          templateField(`${prefix}_attendance`, "meeting_attendance", "Attendance at Pathfinder meetings", "SELECT", true, ["80%", "85%", "90%", "95%", "100%"]),
          templateField(`${prefix}_classes`, "classes_completed", "Classes completed", "MULTISELECT", false, classes),
          templateField(`${prefix}_conduct`, "good_conduct_award", "Good Conduct Award", "RADIO", true, ["Yes", "No"]),
          templateField(`${prefix}_conduct_years`, "good_conduct_years", "How many years?", "NUMBER", true, [], { conditional: { fieldKey: "good_conduct_award", operator: "EQUALS", value: "Yes" } }),
        ] },
        { id: `${prefix}_essays`, title: "Essay questions", description: "Answer each question in your own words.", fields: [
          essay("essay_a", "essay_honor", "A. Honor completed and how the knowledge was applied"),
          essay("essay_b", "essay_service", "B. Community service projects and responsibilities"),
          essay("essay_c", "essay_talents", `C. How is this ${kind} using God-given talents?`),
          essay("essay_d", "essay_serving", `D. How is this ${kind} serving their club or church?`),
          essay("essay_e", "essay_why", `E. Why should this ${kind} be ${kind} of the Year?`),
        ] },
      ],
    },
  };
}

const tltApplicationTemplate: FormTemplate = {
  key: "tlt_application",
  name: "TLT Application",
  description: "Add-on form: the Conference TLT application with personal and club information, three application questions, and two required acknowledgments. No fees.",
  audience: "Individual",
  definition: {
    title: "TLT Application",
    description: "Iowa-Missouri Conference Pathfinders. Apply for the Conference TLT Program.",
    confirmationMessage: "Your TLT application has been received. Thank you.",
    sections: [
      { id: "ta_personal", title: "Personal information", description: "", fields: [
        templateField("ta_full_name", "full_name", "Full name", "TEXT", true, [], { helpText: "First and last name." }),
        templateField("ta_email", "email", "Email", "EMAIL", true),
        templateField("ta_grade", "grade_coming_school_year", "Grade in the coming school year", "TEXT", true),
        templateField("ta_address", "mailing_address", "Address", "ADDRESS", true),
        templateField("ta_gender", "gender", "Gender", "RADIO", true, ["Male", "Female"]),
      ] },
      { id: "ta_club", title: "Club information", description: "", fields: [
        ...directoryClub("ta", "club_name", "Pathfinder club"),
        templateField("ta_years_in_club", "years_in_club", "Number of years in the club", "NUMBER", true, [], { ageBounds: { minimumAge: 0, maximumAge: 100 } }),
        templateField("ta_director", "club_director_name", "Director's name", "TEXT", true),
        templateField("ta_director_email", "club_director_email", "Director's email", "EMAIL", true),
        templateField("ta_meal", "meal_preference", "Meal preferences", "SELECT", true, ["Vegan", "Gluten Free", "Both", "Neither"]),
        templateField("ta_previous_years", "previous_conference_tlt_years", "How many years previous have you been a Conference TLT?", "NUMBER", true, [], { ageBounds: { minimumAge: 0, maximumAge: 100 } }),
      ] },
      { id: "ta_questions", title: "Application questions", description: "Please answer each question thoughtfully and in your own words.", fields: [
        templateField("ta_why", "why_conference_tlt", "Why do you wish to be a part of the Conference TLT Program?", "LONG_TEXT", true),
        templateField("ta_purpose_pathfinders", "purpose_of_pathfinders", "In your opinion, what is the purpose of Pathfinders?", "LONG_TEXT", true),
        templateField("ta_purpose_tlt", "purpose_of_tlt_program", "In your opinion, what is the purpose of the TLT Program?", "LONG_TEXT", true),
      ] },
      { id: "ta_acknowledgments", title: "Acknowledgments", description: "Both are required before submitting.", fields: [
        templateField("ta_accuracy_ack", "accuracy_acknowledgment", "Accuracy and commitment", "CHECKBOX", true, [], { placeholder: "I affirm that the information above is accurate and I am committed to participating in the TLT Program." }),
        templateField("ta_approval_ack", "application_approved_acknowledgment", "Application approval", "CHECKBOX", true, [], { placeholder: "I understand that to attend the retreat, I need to have completed my application and have been approved." }),
      ] },
    ],
  },
};

// Quantity times unit price is expressible: a NUMBER field with `priceCents` charges quantity x price, and the
// registration total is the sum of the lines, so the three prices below are set (2026 sheet) and no total field is needed.
const quantityBounds = { minimumAge: 0, maximumAge: 1000 };
const conferencePatchesTemplate: FormTemplate = {
  key: "conference_patches_pins",
  name: "Conference shoulder patches and pins order",
  description: "Add-on form: an order for Pathfinder and Adventurer shoulder patches and the Conference pin at the 2026 unit prices, with card payment. Postage not included. Use on an attendee-pay event.",
  audience: "Individual",
  definition: {
    title: "Conference shoulder patches and pins order",
    description: "Postage not included.",
    confirmationMessage: "Your order has been received. Postage is not included. Check your email for payment details.",
    payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Credit / debit card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true },
    requireAtLeastOne: { fieldKeys: ["pathfinder_shoulder_patch_quantity", "pathfinder_conference_pin_quantity", "adventurer_shoulder_patch_quantity"], message: "Order at least one item." },
    sections: [
      { id: "cp_orderer", title: "Orderer", description: "", fields: [
        templateField("cp_name", "contact_name", "Name", "TEXT", true, [], { helpText: "First and last name." }),
        templateField("cp_email", "email", "Email", "EMAIL", true),
        ...directoryClub("cp", "club_name", "Club name"),
        templateField("cp_address", "mailing_address", "Mailing address", "ADDRESS", true),
      ] },
      { id: "cp_order", title: "Order", description: "Enter how many of each you want. The total is worked out for you. Postage not included.", fields: [
        templateField("cp_exchange", "patches_to_exchange", "Pathfinder shoulder patch to exchange", "NUMBER", false, [], { ageBounds: quantityBounds }),
        templateField("cp_pf_patch", "pathfinder_shoulder_patch_quantity", "Pathfinder Shoulder Patch", "NUMBER", false, [], { ageBounds: quantityBounds, priceCents: 125, helpText: "$1.25 each. 2 3/8 in H × 3 1/2 in W" }),
        templateField("cp_pin", "pathfinder_conference_pin_quantity", "Pathfinder Conference Pin", "NUMBER", false, [], { ageBounds: quantityBounds, priceCents: 275, helpText: "$2.75 each. Colorful 1½ inch epoxy pin on gold metal" }),
        templateField("cp_adv_patch", "adventurer_shoulder_patch_quantity", "Adventurer Shoulder Patch", "NUMBER", false, [], { ageBounds: quantityBounds, priceCents: 225, helpText: "$2.25 each. 2 in H × 3.13 in W" }),
      ] },
      { id: "cp_payment", title: "Payment", description: "Card payments include the configured processing fee. Postage not included.", stepLabel: "Payment", isReviewStep: true, fields: [
        templateField("cp_pay", "payment_method", "Payment option", "RADIO", true, ["Pay later", "Credit / debit card"]),
      ] },
    ],
  },
};

formTemplates.splice(
  formTemplates.findIndex((template) => template.key === "honors_weekend") + 1,
  0,
  leadershipWeekendTemplate,
  tltRetreatTemplate,
  outdoorSchoolTemplate,
  hispanicInstituteTemplate,
  tltOpportunitiesTemplate,
  buildYearNominationTemplate("Pathfinder"),
  buildYearNominationTemplate("TLT"),
  tltApplicationTemplate,
  conferencePatchesTemplate,
);

/**
 * Drops keys from the "at least one" rule (#606) that no longer name a field, and the rule itself once fewer
 * than two remain, so removing or renaming a referenced field never leaves a definition that cannot be saved.
 */
export function pruneRequireAtLeastOne<T extends { requireAtLeastOne?: { fieldKeys: string[]; message: string }; sections: ReadonlyArray<{ fields: ReadonlyArray<{ key: string }> }> }>(definition: T): T {
  const rule = definition.requireAtLeastOne;
  if (!rule) return definition;
  const existing = new Set(definition.sections.flatMap((section) => section.fields.map((field) => field.key)));
  const fieldKeys = rule.fieldKeys.filter((key) => existing.has(key));
  if (fieldKeys.length === rule.fieldKeys.length) return definition;
  if (fieldKeys.length >= 2) return { ...definition, requireAtLeastOne: { ...rule, fieldKeys } };
  const rest = { ...definition };
  delete rest.requireAtLeastOne;
  return rest;
}

export function getFormTemplate(key: string) {
  return formTemplates.find((template) => template.key === key) ?? null;
}

function hasValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainAddressObject(value)) return hasAddressValue(value);
  return typeof value === "string" && value.trim().length > 0;
}

type FieldCondition = NonNullable<RegistrationFormField["conditional"]>;

function conditionMatches(condition: FieldCondition, responses: Record<string, unknown>) {
  const actual = responses[condition.fieldKey];
  const expected = condition.value;
  if (condition.operator === "NOT_EMPTY") return hasValue(actual);
  if (condition.operator === "INCLUDES") return Array.isArray(actual) ? actual.map(String).includes(expected) : String(actual ?? "").includes(expected);
  if (condition.operator === "NOT_EQUALS") return String(actual ?? "") !== expected;
  return String(actual ?? "") === expected;
}

export function isFieldVisible(field: RegistrationFormField, responses: Record<string, unknown>) {
  if (!field.conditional) return true;
  return conditionMatches(field.conditional, responses);
}

/** Whether a required field has been made optional for this person by "optional when". */
export function isFieldOptionalByCondition(field: RegistrationFormField, responses: Record<string, unknown>) {
  return Boolean(field.required && field.optionalWhen && conditionMatches(field.optionalWhen, responses));
}

/** Required for this person: required, and not excused by "optional when". */
export function isFieldRequired(field: RegistrationFormField, responses: Record<string, unknown>) {
  return field.required && !isFieldOptionalByCondition(field, responses);
}

export function getAttendeeRosterConfig(definition: RegistrationFormDefinition): AttendeeRosterConfig {
  return definition.attendeeRoster ?? {
    enabled: false,
    minAttendees: 1,
    maxAttendees: 1,
    attendeeLabel: "Attendee",
    addButtonLabel: "Add another attendee",
  };
}

export function localCalendarDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isLatePricingActive(field: RegistrationFormField, pricingDate = localCalendarDate()) {
  return Boolean(field.latePricing && pricingDate >= field.latePricing.startsOn);
}

function attendeeDisplayName(responses: Record<string, unknown>, index: number, attendeeLabel: string) {
  const firstName = typeof responses.first_name === "string" ? responses.first_name.trim() : "";
  const lastName = typeof responses.last_name === "string" ? responses.last_name.trim() : "";
  const splitName = `${firstName} ${lastName}`.trim();
  if (splitName) return splitName;
  for (const key of attendeeNameKeys) {
    const value = responses[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `${attendeeLabel} ${index + 1}`;
}

/**
 * The prices a field charges in one pricing state, exactly as `pricedLineItem`
 * resolves them. A field is choice-priced whenever `choicePricesCents` is
 * defined (even empty), or the late map is defined while late pricing is active.
 * Shared so a display of prices can never disagree with what is charged.
 */
export function resolveFieldPrices(field: RegistrationFormField, latePricingActive: boolean) {
  const priceCents = latePricingActive ? field.latePricing?.priceCents ?? field.priceCents : field.priceCents;
  const hasChoicePrices = field.choicePricesCents !== undefined || (latePricingActive && field.latePricing?.choicePricesCents !== undefined);
  const choicePricesCents = hasChoicePrices ? { ...(field.choicePricesCents ?? {}), ...(latePricingActive ? field.latePricing?.choicePricesCents ?? {} : {}) } : undefined;
  return { priceCents, choicePricesCents };
}

function pricedLineItem(
  field: RegistrationFormField,
  responses: Record<string, unknown>,
  pricingDate: string,
  attendee?: { index: number; label: string },
  registrationContext?: { attendeeCount: number },
): FormCalculation["lineItems"][number] | null {
  if (!isFieldVisible(field, responses)) return null;
  const value = responses[field.key];
  if (field.creditCentsPerUnit !== undefined) {
    // A credit (#409, e.g. Camporee's per-person meal sponsorship): units
    // entered subtract from the total, capped at the registration's own
    // headcount when configured so a club can never claim more credit than
    // it has people to feed. `finalizeCalculation` floors the total at $0.
    const rawUnits = Math.max(0, Math.trunc(Number(value) || 0));
    const units = field.capUnitsAtAttendeeCount && registrationContext
      ? Math.min(rawUnits, registrationContext.attendeeCount)
      : rawUnits;
    const creditCents = units * field.creditCentsPerUnit;
    if (creditCents === 0) return null;
    return { key: field.key, label: field.label, amountCents: Math.round(creditCents) };
  }
  const latePricingActive = isLatePricingActive(field, pricingDate);
  const { priceCents, choicePricesCents } = resolveFieldPrices(field, latePricingActive);
  let amountCents = 0;
  if (choicePricesCents) {
    const selections = Array.isArray(value) ? value.map(String) : hasValue(value) ? [String(value)] : [];
    amountCents = selections.reduce((total, selection) => total + (choicePricesCents[selection] ?? 0), 0);
  } else if (priceCents !== undefined && field.type === "CALCULATED") amountCents = priceCents;
  else if (priceCents && field.type === "NUMBER") amountCents = Math.max(0, Number(value) || 0) * priceCents;
  else if (priceCents && hasValue(value)) amountCents = priceCents;
  if (amountCents <= 0) return null;
  return {
    key: attendee ? `attendees.${attendee.index}.${field.key}` : field.key,
    label: attendee ? `${field.label} — ${attendee.label}` : field.label,
    amountCents: Math.round(amountCents),
    ...(latePricingActive ? { pricingLabel: field.latePricing?.label } : {}),
    ...(attendee ? { attendeeIndex: attendee.index, attendeeLabel: attendee.label } : {}),
  };
}

function finalizeCalculation(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  rawLineItems: FormCalculation["lineItems"],
) {
  // A credit line item (a per-person meal sponsorship credit, #409) could
  // carry the sum negative. Clamp each credit, generically rather than in any
  // one form, to what the charges leave, so no registration is ever billed
  // less than $0 and the stored line items always add up to the subtotal.
  let remainingCents = rawLineItems.reduce(
    (total, item) => total + Math.max(item.amountCents, 0),
    0,
  );
  const lineItems: FormCalculation["lineItems"] = [];
  for (const item of rawLineItems) {
    if (item.amountCents >= 0) {
      lineItems.push(item);
      continue;
    }
    const appliedCents = Math.max(item.amountCents, -remainingCents);
    remainingCents += appliedCents;
    if (appliedCents !== 0) lineItems.push({ ...item, amountCents: appliedCents });
  }
  const subtotalCents = lineItems.reduce((total, item) => total + item.amountCents, 0);
  const payment = definition.payment;
  const cardSelected = Boolean(payment?.enabled && registrationResponses[payment.paymentMethodFieldKey] === payment.cardOptionValue);
  const processingFeeCents = processingFeeForSubtotal(
    payment,
    subtotalCents,
    cardSelected,
  );
  return { subtotalCents, processingFeeCents, totalCents: subtotalCents + processingFeeCents, lineItems };
}

/**
 * The same calculation with a registration-level line added, replaced (same key) or, with `null`, removed: a line the
 * form's own fields do not price, such as lodging (#199). The processing fee follows the new subtotal exactly as it
 * does for the form's own lines. Add the line **before** any promo code is applied (#803): a registration-level code
 * discounts the whole subtotal, lodging included.
 */
export function calculationWithLine(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  calculation: FormCalculation,
  key: string,
  line: FormCalculation["lineItems"][number] | null,
): FormCalculation {
  const others = calculation.lineItems.filter((item) => item.key !== key);
  return finalizeCalculation(definition, registrationResponses, line ? [...others, line] : others);
}

/**
 * Adds a registration-level line that no promo code touches to a calculation that may already carry a discount: the
 * discount was worked out on the other lines, so the line is added after it (subtotal, pre-discount subtotal and lines) and
 * the processing fee follows the new subtotal. Only an amendment of a registration submitted before promo codes covered
 * lodging (#803) uses it; every new calculation adds the line first (`calculationWithLine`).
 */
export function addUndiscountedLine<T extends FormCalculation & { preDiscountSubtotalCents?: number }>(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  calculation: T,
  line: FormCalculation["lineItems"][number],
): T {
  const payment = definition.payment;
  const cardSelected = Boolean(payment?.enabled && registrationResponses[payment.paymentMethodFieldKey] === payment.cardOptionValue);
  const before = calculation.lineItems.find((item) => item.key === line.key)?.amountCents ?? 0;
  const lineItems = [...calculation.lineItems.filter((item) => item.key !== line.key), line];
  const subtotalCents = calculation.subtotalCents - before + line.amountCents;
  const processingFeeCents = processingFeeForSubtotal(payment, subtotalCents, cardSelected);
  return {
    ...calculation,
    lineItems,
    subtotalCents,
    processingFeeCents,
    totalCents: subtotalCents + processingFeeCents,
    ...(calculation.preDiscountSubtotalCents !== undefined ? { preDiscountSubtotalCents: calculation.preDiscountSubtotalCents - before + line.amountCents } : {}),
  };
}

export function processingFeeForSubtotal(
  payment: RegistrationFormDefinition["payment"],
  subtotalCents: number,
  cardSelected = true,
) {
  if (
    !payment?.enabled
    || !payment.passFeeToRegistrant
    || !cardSelected
    || !Number.isSafeInteger(subtotalCents)
    || subtotalCents <= 0
  ) {
    return 0;
  }
  const rate = payment.percentageBasisPoints / 10_000;
  const grossTotal = Math.ceil(
    (subtotalCents + payment.fixedFeeCents) / (1 - rate),
  );
  return Math.max(0, grossTotal - subtotalCents);
}

/** The priced lines of a form with no roster, without any sum (church-billed events never total in the browser, #621). */
export function calculateFormLineItems(definition: RegistrationFormDefinition, responses: Record<string, unknown>, pricingDate = localCalendarDate()): FormCalculation["lineItems"] {
  // No repeatable roster: the registrant is the one person on it.
  const registrationContext = { attendeeCount: 1 };
  return definition.sections
    .flatMap((section) => section.fields)
    .map((field) => pricedLineItem(field, responses, pricingDate, undefined, registrationContext))
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export function calculateFormTotal(definition: RegistrationFormDefinition, responses: Record<string, unknown>, pricingDate = localCalendarDate()): FormCalculation {
  return finalizeCalculation(definition, responses, calculateFormLineItems(definition, responses, pricingDate));
}

/** The priced lines of a roster form, without any sum (church-billed events never total in the browser, #621). */
export function calculateRosterLineItems(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  attendeeResponses: Array<Record<string, unknown>>,
  pricingDate = localCalendarDate(),
): FormCalculation["lineItems"] {
  const fields = definition.sections.flatMap((section) => section.fields);
  const registrationContext = { attendeeCount: attendeeResponses.length };
  const lineItems: FormCalculation["lineItems"] = fields
    .filter((field) => field.scope === "REGISTRATION")
    .map((field) => pricedLineItem(field, registrationResponses, pricingDate, undefined, registrationContext))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const roster = getAttendeeRosterConfig(definition);
  attendeeResponses.forEach((responses, index) => {
    const mergedResponses = { ...registrationResponses, ...responses };
    const label = attendeeDisplayName(responses, index, roster.attendeeLabel);
    for (const field of fields) {
      if (field.scope !== "ATTENDEE") continue;
      const item = pricedLineItem(field, mergedResponses, pricingDate, { index, label });
      if (item) lineItems.push(item);
    }
  });
  return lineItems;
}

export function calculateRosterTotal(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  attendeeResponses: Array<Record<string, unknown>>,
  pricingDate = localCalendarDate(),
): FormCalculation {
  return finalizeCalculation(
    definition,
    registrationResponses,
    calculateRosterLineItems(definition, registrationResponses, attendeeResponses, pricingDate),
  );
}

export function summarizeChoiceUsage(definition: RegistrationFormDefinition, responseSets: Array<Record<string, unknown>>): ChoiceUsage {
  const usage: ChoiceUsage = {};
  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (!isChoiceFieldType(field.type) || getAvailabilityMode(field) === "NONE") continue;
      usage[field.key] = Object.fromEntries(field.options.map((option) => [option, { total: 0, first: 0, second: 0 }]));
    }
  }
  for (const responses of responseSets) {
    for (const [fieldKey, choices] of Object.entries(usage)) {
      const value = responses[fieldKey];
      const selected = Array.isArray(value) ? value.map(String) : hasValue(value) ? [String(value)] : [];
      selected.forEach((option, index) => {
        const stats = choices[option];
        if (!stats) return;
        stats.total += 1;
        if (index === 0) stats.first += 1;
        if (index === 1) stats.second += 1;
      });
    }
  }
  return usage;
}

/** FB-5 (#569): no date answer may fall before this year. */
export const EARLIEST_DATE_YEAR = 1900;
export const EARLIEST_DATE_VALUE = `${EARLIEST_DATE_YEAR}-01-01`;

/** Keys that explicitly hold a birth date. Labels are never guessed at, so a
 * "Expected birth date" field (a due date) is not treated as one. */
export const BIRTH_DATE_FIELD_KEYS = ["birth_date", "date_of_birth", "dob", "birthdate"] as const;

/** True for a DATE field whose key explicitly marks it as a birth date. */
export function isBirthDateField(field: Pick<RegistrationFormField, "type" | "key">) {
  return field.type === "DATE" && (BIRTH_DATE_FIELD_KEYS as readonly string[]).includes(field.key);
}

/** Today's calendar date in the event's zone (Chicago), YYYY-MM-DD: the latest a
 * birth date may be. Not UTC, so it doesn't flip at UTC midnight. */
export function todayDateValue(now: Date = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

/** The `min`/`max` attributes a DATE input should carry. */
export function dateFieldBounds(field: Pick<RegistrationFormField, "type" | "key" | "label">, now?: Date) {
  return { min: EARLIEST_DATE_VALUE, max: isBirthDateField(field) ? todayDateValue(now) : undefined };
}

/** Null when the (already well-formed) date is acceptable, else the reason. */
export function dateFieldProblem(
  field: Pick<RegistrationFormField, "type" | "key" | "label">,
  date: string,
  now: Date = new Date(),
) {
  if (date < EARLIEST_DATE_VALUE) return `${field.label} can't be before ${EARLIEST_DATE_YEAR}.`;
  if (isBirthDateField(field) && date > todayDateValue(now)) return `${field.label} can't be in the future.`;
  return null;
}

export function validateTestResponses(
  definition: RegistrationFormDefinition,
  responses: Record<string, unknown>,
  usage: ChoiceUsage = {},
  scope?: RegistrationFormField["scope"],
  options: {
    ignoreAvailability?: boolean;
    ignoredFieldKeys?: readonly string[];
    /** Required fields that may be left empty (checked normally when answered). */
    optionalFieldKeys?: readonly string[];
  } = {},
) {
  const ignoredFieldKeys = new Set(options.ignoredFieldKeys ?? []);
  const optionalFieldKeys = new Set(options.optionalFieldKeys ?? []);
  const issues: Array<{ fieldId: string; key: string; message: string }> = [];
  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (scope && field.scope !== scope) continue;
      if (ignoredFieldKeys.has(field.key)) continue;
      if (!isFieldVisible(field, responses)) continue;
      const value = responses[field.key];
      const requiredHere = isFieldRequired(field, responses);
      if (requiredHere && !optionalFieldKeys.has(field.key) && !hasValue(value)) {
        issues.push({ fieldId: field.id, key: field.key, message: `${field.label} is required.` });
        continue;
      }
      if (!hasValue(value)) continue;
      if ((field.type === "TEXT" || field.type === "LONG_TEXT" || field.type === "EMAIL" || field.type === "PHONE" || field.type === "DATE") && typeof value !== "string") {
        issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be text.` });
        continue;
      }
      if (field.type === "TEXT" && String(value).length > 500) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be 500 characters or fewer.` });
      if (field.type === "LONG_TEXT" && String(value).length > 5000) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be 5,000 characters or fewer.` });
      if (field.type === "EMAIL" && (String(value).length > 160 || !z.email().safeParse(value).success)) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be a valid email address.` });
      if (field.type === "PHONE" && String(value).length > 80) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be 80 characters or fewer.` });
      if (field.type === "DATE") {
        const date = String(value);
        const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
        if (!parsed || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be a valid date.` });
        else {
          const problem = dateFieldProblem(field, date);
          if (problem) issues.push({ fieldId: field.id, key: field.key, message: problem });
        }
      }
      if (field.type === "NUMBER") {
        const numeric = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
        const bounds = numberFieldBounds(field);
        if (bounds) {
          if (!Number.isInteger(numeric) || numeric < bounds.minimumAge || numeric > bounds.maximumAge) {
            issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be a whole number from ${bounds.minimumAge} to ${bounds.maximumAge}.` });
          }
        } else if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100000) {
          issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be a number from 0 to 100,000.` });
        }
      }
      if (field.type === "CHECKBOX" && typeof value !== "boolean") issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must be checked or unchecked.` });
      if (field.type === "ADDRESS") {
        for (const message of validateAddressValue(field.label, value)) {
          issues.push({ fieldId: field.id, key: field.key, message });
        }
      }
      if ((field.type === "SELECT" || field.type === "RADIO") && !field.options.includes(String(value))) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} must use one of its configured choices.` });
      if (field.type === "MULTISELECT" || field.type === "RANKED_CHOICE") {
        const selections = Array.isArray(value) ? value.map(String) : [];
        const maximum = field.maxSelections ?? (field.type === "RANKED_CHOICE" ? 2 : field.options.length);
        // Someone excused by "optional when" may give just one choice.
        const minimum = !requiredHere && field.required
          ? 1
          : field.minSelections ?? (field.required ? (field.type === "RANKED_CHOICE" ? Math.min(2, maximum) : 1) : 0);
        if (!Array.isArray(value) || selections.some((selection) => !field.options.includes(selection))) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} contains an invalid choice.` });
        else if (new Set(selections).size !== selections.length) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} cannot contain duplicate choices.` });
        else if (selections.length < minimum) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} requires ${minimum} choices.` });
        else if (selections.length > maximum) issues.push({ fieldId: field.id, key: field.key, message: `${field.label} allows up to ${maximum} choices.` });
      }
      if (
        !options.ignoreAvailability
        && isChoiceFieldType(field.type)
        && getAvailabilityMode(field) === "CAPACITY"
      ) {
        const selections = Array.isArray(value) ? value.map(String) : [String(value)];
        for (const selection of selections) {
          const limit = field.choiceLimits?.[selection];
          const current = usage[field.key]?.[selection]?.total ?? 0;
          if (limit && current >= limit) issues.push({ fieldId: field.id, key: field.key, message: `${selection} has reached its limit of ${limit}.` });
        }
      }
    }
  }
  const atLeastOne = definition.requireAtLeastOne;
  if (atLeastOne) {
    const referenced = definition.sections.flatMap((section) => section.fields).filter((field) => atLeastOne.fieldKeys.includes(field.key));
    const inScope = referenced.filter((field) => (!scope || field.scope === scope) && !ignoredFieldKeys.has(field.key));
    const answered = inScope.some((field) => (field.type === "NUMBER" ? Number(responses[field.key]) > 0 : hasValue(responses[field.key])));
    if (inScope.length > 0 && inScope.length === referenced.length && !answered) {
      issues.push({ fieldId: inScope[0]!.id, key: inScope[0]!.key, message: atLeastOne.message });
    }
  }
  return { isValid: issues.length === 0, issues };
}

export const createFormSchema = z.object({ templateKey: z.string().trim().min(1).max(80) });
export const updateFormSlugSchema = z.object({
  slug: z.string()
    .trim()
    .toLowerCase()
    .min(1, "Enter a short web address.")
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens only."),
});
export const updateFormSchema = z.object({
  definition: registrationFormDefinitionSchema,
  expectedUpdatedAt: z.iso.datetime(),
});
export const testSubmissionSchema = z.object({
  versionId: z.string().trim().min(1),
  responses: z.record(z.string(), z.unknown()),
  attendees: z.array(z.object({
    clientId: z.string().trim().min(1).max(80),
    responses: z.record(z.string(), z.unknown()),
  }).strict()).max(50).optional(),
});
