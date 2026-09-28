import { z } from "zod";
import { getFormTemplate } from "@/modules/forms/definition";
import { isEventMessageTemplateKey, validateMessageTemplate, type MessageTemplateKey } from "@/modules/communications/templates";
import { calendarDateSchema, eventNameSchema, eventSlugSchema } from "@/modules/events/schemas";
import { operationalReportKinds } from "@/modules/reporting/operational-reports";
import { attendeeClassificationInputSchema, attendeeTypeInputSchema } from "@/modules/attendee-types/domain";

/**
 * The fixed set of optional feature toggles a template may set on the new
 * event (#152). This is deliberately a closed, `.strict()` shape rather than
 * a free-form map: an unrecognized key is exactly the "unavailable module
 * reference" the issue requires to fail before any event is created, and
 * every key here already exists as a real `Event` column.
 */
export const moduleEnablementSchema = z.object({
  waitlistEnabled: z.boolean().default(false),
  autoPromoteWaitlist: z.boolean().default(false),
  collectsShirtSizes: z.boolean().default(false),
  checksAdultBackgrounds: z.boolean().default(false),
}).strict();

export type ModuleEnablement = z.infer<typeof moduleEnablementSchema>;

/** A template-authored attendee type definition. Applying a template always
 * creates brand-new `EventAttendeeType` rows for the new event — never a
 * reference to another event's rows, since attendee types are event-owned. */
export const templateAttendeeTypeSchema = attendeeTypeInputSchema;
export const templateAttendeeClassificationSchema = attendeeClassificationInputSchema;

/** An override for one of the event's message templates (#152). Only keys a
 * real event can carry its own version of (`isEventMessageTemplateKey`) are
 * accepted; the account-only keys (activation, password reset) can never
 * appear here.
 *
 * Applying a template writes these as the new event's PUBLISHED message
 * template versions, so they must pass exactly what the communications
 * editor enforces (`messageTemplateInputSchema`): the same length limits and
 * `validateMessageTemplate` (known tokens only, a one-line subject). */
export const templateMessageDefaultSchema = z.object({
  key: z.string().trim().min(1).max(80),
  isEnabled: z.boolean().default(true),
  subjectTemplate: z.string().trim().min(1).max(180),
  bodyTemplate: z.string().trim().min(1).max(12_000),
}).superRefine((input, context) => {
  const validation = validateMessageTemplate({ subject: input.subjectTemplate, body: input.bodyTemplate });
  for (const issue of validation.issues) {
    context.addIssue({
      code: "custom",
      path: [issue.field === "subject" ? "subjectTemplate" : "bodyTemplate"],
      message: issue.message,
    });
  }
});

export type TemplateMessageDefault = z.infer<typeof templateMessageDefaultSchema>;

export const templateBrandingDefaultsSchema = z.object({
  publicInfoUrl: z.string().trim().url("Enter a complete http:// or https:// web address.").max(300).nullable().default(null),
  supportContact: z.string().trim().max(200).nullable().default(null),
  calendarCategory: z.string().trim().max(80).nullable().default(null),
}).strict();

const MESSAGE_TEMPLATE_DEFAULT_LIMIT = 30;

/**
 * The immutable payload a published `EventTemplateVersion` carries (#152).
 * Everything here can be validated on its own shape at draft/publish time;
 * `validateEventTemplatePayloadReferences` below does the second check that
 * can only happen against the *current* code and configuration, at apply
 * time — the one that actually blocks "invalid or unavailable module
 * references" from ever reaching a created event.
 */
export const eventTemplatePayloadSchema = z.object({
  audience: z.enum(["GENERAL", "CLUB"]).default("GENERAL"),
  formTemplateKeys: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  attendeeTypes: z.array(templateAttendeeTypeSchema).max(60).default([]),
  attendeeClassifications: z.array(templateAttendeeClassificationSchema).max(60).default([]),
  moduleEnablement: moduleEnablementSchema.default({
    waitlistEnabled: false,
    autoPromoteWaitlist: false,
    collectsShirtSizes: false,
    checksAdultBackgrounds: false,
  }),
  /** Snapshot-only in this slice (#152): no reporting domain consumes a
   * per-event report selection yet, so applying a template records these in
   * `EventTemplateApplication.payloadSnapshot` and creates nothing from them.
   * A later slice that adds per-event report configuration reads them from
   * there. */
  reportSelections: z.array(z.enum(operationalReportKinds)).max(operationalReportKinds.length).default([]),
  messageTemplateDefaults: z.array(templateMessageDefaultSchema).max(MESSAGE_TEMPLATE_DEFAULT_LIMIT).default([]),
  brandingDefaults: templateBrandingDefaultsSchema.default({
    publicInfoUrl: null,
    supportContact: null,
    calendarCategory: null,
  }),
}).superRefine((payload, ctx) => {
  const attendeeTypeCodes = new Set<string>();
  payload.attendeeTypes.forEach((type, index) => {
    if (attendeeTypeCodes.has(type.code)) {
      ctx.addIssue({ code: "custom", path: ["attendeeTypes", index, "code"], message: `Attendee type code ${type.code} is repeated.` });
    }
    attendeeTypeCodes.add(type.code);
  });
  const classificationCodes = new Set<string>();
  payload.attendeeClassifications.forEach((classification, index) => {
    const dedupeKey = `${classification.kind}:${classification.code}`;
    if (classificationCodes.has(dedupeKey)) {
      ctx.addIssue({ code: "custom", path: ["attendeeClassifications", index, "code"], message: `Classification code ${classification.code} is repeated for ${classification.kind}.` });
    }
    classificationCodes.add(dedupeKey);
  });
  const messageKeys = new Set<string>();
  payload.messageTemplateDefaults.forEach((entry, index) => {
    if (messageKeys.has(entry.key)) {
      ctx.addIssue({ code: "custom", path: ["messageTemplateDefaults", index, "key"], message: `Message template key ${entry.key} is repeated.` });
    }
    messageKeys.add(entry.key);
  });
});

export type EventTemplatePayload = z.infer<typeof eventTemplatePayloadSchema>;

export class EventTemplateReferenceError extends Error {
  constructor(
    public readonly issues: string[],
  ) {
    super(`This template is invalid or references something unavailable: ${issues.join("; ")}`);
    this.name = "EventTemplateReferenceError";
  }
}

/**
 * Strictly parses a stored version payload for publish and apply (#152).
 * A payload that no longer satisfies the current schema — for example a
 * message default saved before its token rules tightened — is reported as an
 * `EventTemplateReferenceError` naming every problem, so publish and apply
 * refuse it before anything is written. Display paths use `safeParse`
 * instead so one stale version can never break a whole page.
 */
export function parseEventTemplatePayload(value: unknown): EventTemplatePayload {
  const result = eventTemplatePayloadSchema.safeParse(value);
  if (!result.success) {
    throw new EventTemplateReferenceError(result.error.issues.map((issue) => (
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message
    )));
  }
  return result.data;
}

/**
 * The second, apply-time validation pass (#152): a published template's
 * payload was valid when it was published, but the *referenced* form
 * templates and message template keys live in code that can change
 * afterward. This re-checks every reference against what is available right
 * now and throws `EventTemplateReferenceError` — naming every problem found,
 * not just the first — so a stale or disabled reference is caught before any
 * event, attendee type, or form is created. Nothing in this function reads
 * or writes the database; it is pure so applying can validate before opening
 * a transaction.
 */
export function validateEventTemplatePayloadReferences(payload: EventTemplatePayload): void {
  const issues: string[] = [];

  for (const key of payload.formTemplateKeys) {
    if (!getFormTemplate(key)) {
      issues.push(`Registration form template "${key}" is not available.`);
    }
  }

  for (const entry of payload.messageTemplateDefaults) {
    if (!isEventMessageTemplateKey(entry.key)) {
      issues.push(`Message template "${entry.key}" is not an event message template.`);
    }
  }

  if (issues.length > 0) {
    throw new EventTemplateReferenceError(issues);
  }
}

/** Narrows a payload's message template keys to the type the communications
 * module expects, once `validateEventTemplatePayloadReferences` has already
 * confirmed every key is a real event message template. */
export function asEventMessageTemplateKey(key: string): MessageTemplateKey {
  if (!isEventMessageTemplateKey(key)) {
    throw new EventTemplateReferenceError([`Message template "${key}" is not an event message template.`]);
  }
  return key;
}

export const eventTemplateNameSchema = z.string().trim().min(2, "Name the template.").max(120);
export const eventTemplateDescriptionSchema = z.string().trim().max(2000).default("");

export const createEventTemplateInputSchema = z.object({
  name: eventTemplateNameSchema,
  description: eventTemplateDescriptionSchema,
});

export const draftEventTemplateInputSchema = z.object({
  name: eventTemplateNameSchema,
  description: eventTemplateDescriptionSchema,
  payload: eventTemplatePayloadSchema,
  /** Optimistic-concurrency guard, mirroring `updateRegistrationForm`'s
   * `expectedUpdatedAt`: the `updatedAt` of the version the editor loaded
   * (its draft, or the published version a new draft is opened from). Every
   * template has a version from the moment it is created, so this is always
   * required: a stale tab can never silently overwrite a newer draft. */
  expectedUpdatedAt: z.string().datetime(),
});

/**
 * The new event's details when applying a template (#152). Built from the
 * same rules `eventSettingsInputSchema` enforces (name, slug, real calendar
 * dates, the event not ending before it starts), so an event created from a
 * template can always be re-saved in event settings unchanged.
 */
export const applyEventTemplateInputSchema = z.object({
  name: eventNameSchema,
  slug: eventSlugSchema,
  startsOn: calendarDateSchema,
  endsOn: calendarDateSchema,
  /** The caller's idempotency key, scoped to the signed-in actor: retrying an
   * apply with the same key and the same details returns the event the first
   * attempt created instead of creating a second one, and reusing a key with
   * different details is refused (#152). */
  requestKey: z.string().trim().min(8).max(200),
}).superRefine((value, context) => {
  if (value.endsOn < value.startsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "The event cannot end before it starts." });
  }
});

export type ApplyEventTemplateInput = z.infer<typeof applyEventTemplateInputSchema>;
