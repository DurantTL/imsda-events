import { z } from "zod";
import {
  calculateFormTotal,
  calculateRosterTotal,
  getAttendeeRosterConfig,
  getAvailabilityMode,
  isChoiceFieldType,
  isFieldVisible,
  summarizeChoiceUsage,
  validateTestResponses,
  type ChoiceUsage,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";

const publicAttendeeInputSchema = z.object({
  clientId: z.string().trim().min(1).max(80),
  responses: z.record(z.string(), z.unknown()),
}).strict();

export const publicRegistrationInputSchema = z.object({
  versionId: z.string().trim().min(1).max(100),
  idempotencyKey: z.uuid(),
  responses: z.record(z.string(), z.unknown()),
  attendees: z.array(publicAttendeeInputSchema).max(50).optional(),
  website: z.literal("").optional(),
}).strict().superRefine((input, context) => {
  const clientIds = new Set<string>();
  input.attendees?.forEach((attendee, index) => {
    if (clientIds.has(attendee.clientId)) {
      context.addIssue({
        code: "custom",
        path: ["attendees", index, "clientId"],
        message: "Each attendee row must have a unique client identifier.",
      });
    }
    clientIds.add(attendee.clientId);
  });
});

export type PublicRegistrationInput = z.infer<typeof publicRegistrationInputSchema>;

export type PublicRegistrationIssue = {
  kind: "configuration" | "validation";
  code:
    | "UNKNOWN_FIELD"
    | "INVALID_RESPONSE"
    | "CONTACT_EMAIL_REQUIRED"
    | "CONTACT_NAME_REQUIRED"
    | "ATTENDEE_NAME_REQUIRED"
    | "ATTENDEE_COUNT_INVALID"
    | "PROMO_CODE_INVALID";
  fieldId: string | null;
  key: string;
  path: string;
  attendeeIndex: number | null;
  message: string;
};

export type PublicContactIdentity = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

export type PublicAttendeeIdentity = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string;
};

export type PreparedPublicAttendee = {
  clientId: string;
  responses: Record<string, unknown>;
  identity: PublicAttendeeIdentity | null;
};

const fullNameKeys = [
  "full_name",
  "name",
  "contact_name",
  "primary_contact_name",
  "registrant_name",
  "attendee_name",
  "guest_name",
  "director_name",
  "household_name",
] as const;

function formFields(definition: RegistrationFormDefinition) {
  return definition.sections.flatMap((section) => section.fields);
}

function normalizeResponseValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item.trim() : item);
  return value;
}

function issuePath(key: string, attendeeIndex: number | null) {
  return attendeeIndex === null ? `responses.${key}` : `attendees.${attendeeIndex}.responses.${key}`;
}

function makeIssue(
  issue: Omit<PublicRegistrationIssue, "path" | "attendeeIndex">,
  attendeeIndex: number | null = null,
): PublicRegistrationIssue {
  return { ...issue, path: issuePath(issue.key, attendeeIndex), attendeeIndex };
}

export function calendarDateInTimeZone(date: Date, timeZone: string) {
  if (Number.isNaN(date.valueOf())) throw new RangeError("A valid date is required.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new RangeError("The calendar date could not be resolved for that time zone.");
  return `${year}-${month}-${day}`;
}

function normalizeResponsesForScope(
  definition: RegistrationFormDefinition,
  inputResponses: Record<string, unknown>,
  scope: RegistrationFormField["scope"] | null,
  sharedResponses: Record<string, unknown>,
  attendeeIndex: number | null,
) {
  const fields = formFields(definition);
  const configuredFields = new Map(
    fields
      .filter((field) => scope === null || field.scope === scope)
      .map((field) => [field.key, field]),
  );
  const allConfiguredFields = new Map(fields.map((field) => [field.key, field]));
  const responses: Record<string, unknown> = {};
  const issues: PublicRegistrationIssue[] = [];

  for (const [key, value] of Object.entries(inputResponses)) {
    const field = configuredFields.get(key);
    if (!field) {
      const configuredElsewhere = allConfiguredFields.get(key);
      issues.push(makeIssue({
        kind: "validation",
        code: "UNKNOWN_FIELD",
        fieldId: configuredElsewhere?.id ?? null,
        key,
        message: configuredElsewhere
          ? `${configuredElsewhere.label} belongs to ${configuredElsewhere.scope === "ATTENDEE" ? "an attendee" : "the registration"} and was submitted in the wrong place.`
          : `${key} is not a configured field on this form version.`,
      }, attendeeIndex));
      continue;
    }
    if (field.type === "CALCULATED") continue;
    responses[key] = normalizeResponseValue(value);
  }

  // Re-evaluate until stable so a hidden controlling field cannot make another
  // conditional answer survive after the controller itself is removed.
  let removedField = true;
  while (removedField) {
    removedField = false;
    for (const field of configuredFields.values()) {
      if (
        Object.hasOwn(responses, field.key)
        && !isFieldVisible(field, { ...sharedResponses, ...responses })
      ) {
        delete responses[field.key];
        removedField = true;
      }
    }
  }

  return { responses, issues };
}

export function normalizePublicResponses(
  definition: RegistrationFormDefinition,
  inputResponses: Record<string, unknown>,
) {
  return normalizeResponsesForScope(definition, inputResponses, null, {}, null);
}

function stringResponse(responses: Record<string, unknown>, key: string) {
  const value = responses[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function splitFullName(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function extractName(
  fields: RegistrationFormField[],
  responses: Record<string, unknown>,
) {
  const firstNameField = fields.find((field) => field.key === "first_name");
  const lastNameField = fields.find((field) => field.key === "last_name");
  const firstName = firstNameField ? stringResponse(responses, firstNameField.key) : null;
  const lastName = lastNameField ? stringResponse(responses, lastNameField.key) : null;
  if (firstName && lastName) return { firstName, lastName };
  for (const key of fullNameKeys) {
    const field = fields.find((candidate) => candidate.key === key);
    const value = field ? stringResponse(responses, field.key) : null;
    if (!value) continue;
    const name = splitFullName(value);
    if (name) return name;
  }
  return null;
}

export function extractPublicContactIdentity(
  definition: RegistrationFormDefinition,
  responses: Record<string, unknown>,
) {
  const fields = formFields(definition);
  const visibleFields = fields.filter((field) => isFieldVisible(field, responses));
  const configuredEmailFields = fields.filter((field) => field.type === "EMAIL");
  const visibleEmailFields = visibleFields.filter((field) => field.type === "EMAIL");
  const visiblePhoneFields = visibleFields.filter((field) => field.type === "PHONE");
  const visibleRegistrationFields = visibleFields.filter((field) => field.scope === "REGISTRATION");

  const emailField = visibleEmailFields.find((field) => field.scope === "REGISTRATION" && stringResponse(responses, field.key))
    ?? visibleEmailFields.find((field) => stringResponse(responses, field.key));
  const phoneField = visiblePhoneFields.find((field) => field.scope === "REGISTRATION" && stringResponse(responses, field.key))
    ?? visiblePhoneFields.find((field) => stringResponse(responses, field.key));
  const email = emailField ? stringResponse(responses, emailField.key)?.toLowerCase() ?? null : null;
  const phone = phoneField ? stringResponse(responses, phoneField.key) ?? "" : "";
  const name = extractName(visibleRegistrationFields, responses) ?? extractName(visibleFields, responses);

  const issues: PublicRegistrationIssue[] = [];
  if (!email) {
    const configured = configuredEmailFields.length > 0;
    issues.push(makeIssue({
      kind: configured ? "validation" : "configuration",
      code: "CONTACT_EMAIL_REQUIRED",
      fieldId: configured ? configuredEmailFields[0].id : null,
      key: configured ? configuredEmailFields[0].key : "email",
      message: configured
        ? "A contact email is required to create this registration."
        : "This published form does not configure an email field for the registration contact.",
    }));
  }

  const configuredFirstName = fields.some((field) => field.key === "first_name");
  const configuredLastName = fields.some((field) => field.key === "last_name");
  const configuredFullName = fields.find((field) => fullNameKeys.includes(field.key as typeof fullNameKeys[number]));
  if (!name) {
    const configured = (configuredFirstName && configuredLastName) || Boolean(configuredFullName);
    const nameField: RegistrationFormField | undefined = configuredFullName
      ?? fields.find((field) => field.key === "first_name")
      ?? fields.find((field) => field.key === "last_name");
    issues.push(makeIssue({
      kind: configured ? "validation" : "configuration",
      code: "CONTACT_NAME_REQUIRED",
      fieldId: nameField?.id ?? null,
      key: nameField?.key ?? "name",
      message: configured
        ? "A first and last name are required to create this registration."
        : "This published form does not configure first_name/last_name or a supported full-name field.",
    }));
  }

  return {
    identity: name && email ? { ...name, email, phone } satisfies PublicContactIdentity : null,
    issues,
  };
}

function extractPublicAttendeeIdentity(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  attendeeResponses: Record<string, unknown>,
  attendeeIndex: number,
) {
  const mergedResponses = { ...registrationResponses, ...attendeeResponses };
  const attendeeFields = formFields(definition)
    .filter((field) => field.scope === "ATTENDEE" && isFieldVisible(field, mergedResponses));
  const name = extractName(attendeeFields, mergedResponses);
  const emailField = attendeeFields.find((field) => field.type === "EMAIL" && stringResponse(mergedResponses, field.key));
  const phoneField = attendeeFields.find((field) => field.type === "PHONE" && stringResponse(mergedResponses, field.key));
  const email = emailField ? stringResponse(mergedResponses, emailField.key)?.toLowerCase() ?? null : null;
  const phone = phoneField ? stringResponse(mergedResponses, phoneField.key) ?? "" : "";
  if (name) {
    return {
      identity: { ...name, email, phone } satisfies PublicAttendeeIdentity,
      issues: [] as PublicRegistrationIssue[],
    };
  }
  const nameField = attendeeFields.find((field) => fullNameKeys.includes(field.key as typeof fullNameKeys[number]))
    ?? attendeeFields.find((field) => field.key === "first_name")
    ?? attendeeFields.find((field) => field.key === "last_name");
  return {
    identity: null,
    issues: [makeIssue({
      kind: nameField ? "validation" : "configuration",
      code: "ATTENDEE_NAME_REQUIRED",
      fieldId: nameField?.id ?? null,
      key: nameField?.key ?? "name",
      message: nameField
        ? `Enter a first and last name for attendee ${attendeeIndex + 1}.`
        : "This roster does not configure attendee name fields.",
    }, attendeeIndex)],
  };
}

function cloneUsage(definition: RegistrationFormDefinition, usage: ChoiceUsage) {
  const cloned = summarizeChoiceUsage(definition, []);
  for (const [fieldKey, choices] of Object.entries(cloned)) {
    for (const [choice, stats] of Object.entries(choices)) {
      const source = usage[fieldKey]?.[choice];
      if (source) Object.assign(stats, source);
    }
  }
  return cloned;
}

function addResponsesToUsage(
  definition: RegistrationFormDefinition,
  responses: Record<string, unknown>,
  usage: ChoiceUsage,
  scope: RegistrationFormField["scope"],
) {
  for (const field of formFields(definition)) {
    if (
      field.scope !== scope
      || !isChoiceFieldType(field.type)
      || getAvailabilityMode(field) === "NONE"
      || !isFieldVisible(field, responses)
    ) continue;
    const value = responses[field.key];
    const selections = Array.isArray(value)
      ? value.map(String)
      : typeof value === "string" && value
        ? [value]
        : [];
    selections.forEach((option, rank) => {
      const stats = usage[field.key]?.[option];
      if (!stats) return;
      stats.total += 1;
      if (rank === 0) stats.first += 1;
      if (rank === 1) stats.second += 1;
    });
  }
}

function mapValidationIssues(
  issues: Array<{ fieldId: string; key: string; message: string }>,
  attendeeIndex: number | null,
) {
  return issues.map((issue) => makeIssue({
    kind: "validation",
    code: "INVALID_RESPONSE",
    fieldId: issue.fieldId,
    key: issue.key,
    message: issue.message,
  }, attendeeIndex));
}

export function preparePublicRegistration(
  definition: RegistrationFormDefinition,
  input: PublicRegistrationInput,
  options: {
    timeZone: string;
    now?: Date;
    usage?: ChoiceUsage;
    ignoreAvailability?: boolean;
    ignoredFieldKeys?: readonly string[];
  },
) {
  const roster = getAttendeeRosterConfig(definition);
  const pricingDate = calendarDateInTimeZone(options.now ?? new Date(), options.timeZone);

  if (!roster.enabled) {
    const normalized = normalizePublicResponses(definition, input.responses);
    const validation = validateTestResponses(
      definition,
      normalized.responses,
      options.usage,
      undefined,
      {
        ignoreAvailability: options.ignoreAvailability,
        ignoredFieldKeys: options.ignoredFieldKeys,
      },
    );
    const identity = extractPublicContactIdentity(definition, normalized.responses);
    const attendeeNameFields = formFields(definition).filter((field) => (
      field.scope === "ATTENDEE"
      && (field.key === "first_name"
        || field.key === "last_name"
        || fullNameKeys.includes(field.key as typeof fullNameKeys[number]))
    ));
    const hasAttendeeNameAnswer = attendeeNameFields.some((field) => Boolean(stringResponse(normalized.responses, field.key)));
    const attendeeIdentity = hasAttendeeNameAnswer
      ? extractPublicAttendeeIdentity(definition, normalized.responses, normalized.responses, 0)
      : {
          identity: identity.identity ? {
            firstName: identity.identity.firstName,
            lastName: identity.identity.lastName,
            email: identity.identity.email,
            phone: identity.identity.phone,
          } : null,
          issues: [] as PublicRegistrationIssue[],
        };
    const unexpectedRosterIssues = input.attendees?.length
      ? [makeIssue({
          kind: "validation",
          code: "ATTENDEE_COUNT_INVALID",
          fieldId: null,
          key: "attendees",
          message: "This form accepts one attendee and does not accept a separate roster.",
        })]
      : [];
    const calculation = calculateFormTotal(definition, normalized.responses, pricingDate);
    const issues = [
      ...normalized.issues,
      ...mapValidationIssues(validation.issues, null),
      ...identity.issues,
      ...attendeeIdentity.issues,
      ...unexpectedRosterIssues,
    ];
    const attendeeResponses = Object.fromEntries(
      formFields(definition)
        .filter((field) => field.scope === "ATTENDEE" && Object.hasOwn(normalized.responses, field.key))
        .map((field) => [field.key, normalized.responses[field.key]]),
    );
    return {
      responses: normalized.responses,
      registrationResponses: normalized.responses,
      attendees: [{
        clientId: "legacy-primary-attendee",
        responses: attendeeResponses,
        identity: attendeeIdentity.identity,
      }] satisfies PreparedPublicAttendee[],
      issues,
      isValid: issues.length === 0,
      calculation,
      pricingDate,
      identity: identity.identity,
      rosterEnabled: false,
    };
  }

  const normalizedRegistration = normalizeResponsesForScope(
    definition,
    input.responses,
    "REGISTRATION",
    {},
    null,
  );
  const inputAttendees = input.attendees ?? [];
  const issues: PublicRegistrationIssue[] = [...normalizedRegistration.issues];
  if (inputAttendees.length < roster.minAttendees || inputAttendees.length > roster.maxAttendees) {
    issues.push({
      kind: "validation",
      code: "ATTENDEE_COUNT_INVALID",
      fieldId: null,
      key: "attendees",
      path: "attendees",
      attendeeIndex: null,
      message: `Add between ${roster.minAttendees} and ${roster.maxAttendees} ${roster.attendeeLabel.toLowerCase()}${roster.maxAttendees === 1 ? "" : "s"}.`,
    });
  }

  const usage = cloneUsage(definition, options.usage ?? {});
  const registrationValidation = validateTestResponses(
    definition,
    normalizedRegistration.responses,
    usage,
    "REGISTRATION",
    {
      ignoreAvailability: options.ignoreAvailability,
      ignoredFieldKeys: options.ignoredFieldKeys,
    },
  );
  issues.push(...mapValidationIssues(registrationValidation.issues, null));
  addResponsesToUsage(definition, normalizedRegistration.responses, usage, "REGISTRATION");

  const attendees: PreparedPublicAttendee[] = inputAttendees.map((attendee, attendeeIndex) => {
    const normalized = normalizeResponsesForScope(
      definition,
      attendee.responses,
      "ATTENDEE",
      normalizedRegistration.responses,
      attendeeIndex,
    );
    const mergedResponses = { ...normalizedRegistration.responses, ...normalized.responses };
    const validation = validateTestResponses(
      definition,
      mergedResponses,
      usage,
      "ATTENDEE",
      {
        ignoreAvailability: options.ignoreAvailability,
        ignoredFieldKeys: options.ignoredFieldKeys,
      },
    );
    const identity = extractPublicAttendeeIdentity(
      definition,
      normalizedRegistration.responses,
      normalized.responses,
      attendeeIndex,
    );
    issues.push(
      ...normalized.issues,
      ...mapValidationIssues(validation.issues, attendeeIndex),
      ...identity.issues,
    );
    addResponsesToUsage(definition, mergedResponses, usage, "ATTENDEE");
    return { clientId: attendee.clientId, responses: normalized.responses, identity: identity.identity };
  });

  const firstAttendeeResponses = attendees[0]?.responses ?? {};
  const contactIdentity = extractPublicContactIdentity(
    definition,
    { ...normalizedRegistration.responses, ...firstAttendeeResponses },
  );
  issues.push(...contactIdentity.issues);
  const calculation = calculateRosterTotal(
    definition,
    normalizedRegistration.responses,
    attendees.map((attendee) => attendee.responses),
    pricingDate,
  );

  return {
    responses: normalizedRegistration.responses,
    registrationResponses: normalizedRegistration.responses,
    attendees,
    issues,
    isValid: issues.length === 0,
    calculation,
    pricingDate,
    identity: contactIdentity.identity,
    rosterEnabled: true,
  };
}
