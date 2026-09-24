import { z } from "zod";

const emailField = z
  .string()
  .trim()
  .max(160)
  .transform((value) => value.toLowerCase())
  .refine((value) => value === "" || z.email().safeParse(value).success, "Enter a valid email address.");

const registrationFields = {
  firstName: z.string().trim().min(1, "First name is required.").max(80),
  lastName: z.string().trim().min(1, "Last name is required.").max(80),
  email: emailField,
  phone: z.string().trim().max(40),
  attendeeType: z.enum(["ATTENDEE", "WORKER", "CHILD"]),
  status: z.enum(["DRAFT", "SUBMITTED", "CONFIRMED", "WAITLISTED", "CANCELLED"]),
  totalAmountCents: z.number().int().min(0).max(10_000_000),
};

export const registrationInputSchema = z.object({
  ...registrationFields,
  email: registrationFields.email.default(""),
  phone: registrationFields.phone.default(""),
  attendeeType: registrationFields.attendeeType.default("ATTENDEE"),
  status: registrationFields.status.default("SUBMITTED"),
});

const registrationEditableFields = {
  firstName: registrationFields.firstName,
  lastName: registrationFields.lastName,
  email: registrationFields.email,
  phone: registrationFields.phone,
  attendeeType: registrationFields.attendeeType,
  totalAmountCents: registrationFields.totalAmountCents,
};

export const registrationUpdateSchema = z.strictObject(registrationEditableFields).partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be provided.",
);

export type RegistrationInput = z.infer<typeof registrationInputSchema>;
export type RegistrationUpdateInput = z.infer<typeof registrationUpdateSchema>;

export const registrationLifecycleReasonSchema = z.strictObject({
  reason: z.string().trim().max(500).default(""),
});

export type RegistrationLifecycleReasonInput = z.infer<typeof registrationLifecycleReasonSchema>;

export const attendeeInputSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required.").max(80),
  lastName: z.string().trim().min(1, "Last name is required.").max(80),
  email: emailField.default(""),
  phone: z.string().trim().max(40).default(""),
  attendeeType: z.enum(["ATTENDEE", "WORKER", "CHILD"]).default("ATTENDEE"),
});

export type AttendeeInput = z.infer<typeof attendeeInputSchema>;

export const attendeeEmailUpdateSchema = z.strictObject({
  email: emailField,
});

export type AttendeeEmailUpdateInput = z.infer<typeof attendeeEmailUpdateSchema>;

const operationIdentityFields = {
  firstName: z.string().trim().min(1, "First name is required.").max(80),
  lastName: z.string().trim().min(1, "Last name is required.").max(80),
  email: emailField,
  phone: z.string().trim().max(40),
  reason: z.string().trim().max(500),
  clientRequestId: z.uuid(),
};

export const registrationTransferInputSchema = z.strictObject({
  ...operationIdentityFields,
  email: z.email("Enter the new contact's email address.")
    .max(160)
    .transform((value) => value.trim().toLowerCase()),
  phone: operationIdentityFields.phone.default(""),
  reason: operationIdentityFields.reason.default(""),
});

export const attendeeSubstitutionInputSchema = z.strictObject({
  ...operationIdentityFields,
  email: operationIdentityFields.email.default(""),
  phone: operationIdentityFields.phone.default(""),
  reason: operationIdentityFields.reason.default(""),
});

export type RegistrationTransferInput = z.infer<
  typeof registrationTransferInputSchema
>;
export type AttendeeSubstitutionInput = z.infer<
  typeof attendeeSubstitutionInputSchema
>;

const registrationAmendmentAttendeeSchema = z.strictObject({
  attendeeId: z.string().trim().min(1).max(100).nullable(),
  clientId: z.string().trim().min(1).max(100),
  responses: z.record(z.string(), z.unknown()),
});

export const registrationAmendmentInputSchema = z.strictObject({
  clientRequestId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
  reason: z.string().trim().max(500).default(""),
  responses: z.record(z.string(), z.unknown()),
  attendees: z.array(registrationAmendmentAttendeeSchema).min(1).max(50),
  previewOnly: z.boolean().default(true),
  quoteFingerprint: z.string().length(64).optional(),
}).superRefine((input, context) => {
  const clientIds = new Set<string>();
  const attendeeIds = new Set<string>();
  input.attendees.forEach((attendee, index) => {
    if (clientIds.has(attendee.clientId)) {
      context.addIssue({
        code: "custom",
        path: ["attendees", index, "clientId"],
        message: "Each attendee row must have a unique client identifier.",
      });
    }
    clientIds.add(attendee.clientId);
    if (attendee.attendeeId) {
      if (attendeeIds.has(attendee.attendeeId)) {
        context.addIssue({
          code: "custom",
          path: ["attendees", index, "attendeeId"],
          message: "An existing attendee can appear only once.",
        });
      }
      attendeeIds.add(attendee.attendeeId);
    }
  });
  if (!input.previewOnly && !input.quoteFingerprint) {
    context.addIssue({
      code: "custom",
      path: ["quoteFingerprint"],
      message: "Review the amendment quote before confirming it.",
    });
  }
});

export type RegistrationAmendmentInput = z.infer<
  typeof registrationAmendmentInputSchema
>;
