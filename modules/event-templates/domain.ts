import { z } from "zod";
import { getFormTemplate } from "@/modules/forms/definition";
import { isEventMessageTemplateKey, type MessageTemplateKey } from "@/modules/communications/templates";
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
 * appear here. */
export const templateMessageDefaultSchema = z.object({
  key: z.string().trim().min(1).max(80),
  isEnabled: z.boolean().default(true),
  subjectTemplate: z.string().trim().min(1).max(200),
  bodyTemplate: z.string().trim().min(1).max(20000),
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
    super(`Template references are invalid or unavailable: ${issues.join("; ")}`);
    this.name = "EventTemplateReferenceError";
  }
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
   * `expectedUpdatedAt`: required whenever a draft version already exists so
   * a stale tab can't silently overwrite a newer draft. */
  expectedUpdatedAt: z.string().datetime().optional(),
});

export const applyEventTemplateInputSchema = z.object({
  name: z.string().trim().min(2, "Name the event.").max(200),
  slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers, and hyphens."),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date in YYYY-MM-DD format."),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date in YYYY-MM-DD format."),
  /** The caller's idempotency key: retrying an apply with the same key
   * returns the event the first attempt created instead of creating a
   * second one (#152). */
  requestKey: z.string().trim().min(8).max(200),
});

export type ApplyEventTemplateInput = z.infer<typeof applyEventTemplateInputSchema>;
