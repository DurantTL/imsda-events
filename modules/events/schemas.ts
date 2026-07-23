import { z } from "zod";

export const eventTimeZones = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

export const calendarDateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "Use a calendar date in YYYY-MM-DD format.",
).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date.");

const nullableText = (maximum: number) => z.string()
  .trim()
  .max(maximum)
  .nullable()
  .transform((value) => value || null);

const publicInfoUrlSchema = nullableText(500).refine((value) => {
  if (value === null) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}, "Enter a complete http:// or https:// web address.");

const lifecycleFields = {
  capacity: z.number().int().min(1).max(100_000).nullable(),
  isPublished: z.boolean(),
  registrationOpensOn: calendarDateSchema.nullable(),
  registrationClosesOn: calendarDateSchema.nullable(),
  waitlistEnabled: z.boolean(),
  autoPromoteWaitlist: z.boolean(),
};

function validateLifecycle(
  value: {
    registrationOpensOn: string | null;
    registrationClosesOn: string | null;
    waitlistEnabled: boolean;
    autoPromoteWaitlist: boolean;
  },
  context: z.RefinementCtx,
) {
  if (
    value.registrationOpensOn
    && value.registrationClosesOn
    && value.registrationOpensOn > value.registrationClosesOn
  ) {
    context.addIssue({
      code: "custom",
      path: ["registrationClosesOn"],
      message: "Registration cannot close before it opens.",
    });
  }
  if (value.autoPromoteWaitlist && !value.waitlistEnabled) {
    context.addIssue({
      code: "custom",
      path: ["autoPromoteWaitlist"],
      message: "Automatic promotion requires the waitlist to be enabled.",
    });
  }
}

export const eventLifecycleInputSchema = z.object({
  ...lifecycleFields,
}).superRefine((value, context) => {
  validateLifecycle(value, context);
});

export const eventSettingsInputSchema = z.object({
  name: z.string().trim().min(3, "Enter an event name.").max(120),
  slug: z.string()
    .trim()
    .toLowerCase()
    .min(3, "Enter a short web address.")
    .max(80)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Use lowercase letters, numbers, and single hyphens only.",
    ),
  startsOn: calendarDateSchema,
  endsOn: calendarDateSchema,
  timezone: z.enum(eventTimeZones),
  location: nullableText(200),
  publicInfoUrl: publicInfoUrlSchema,
  supportContact: nullableText(200),
  ...lifecycleFields,
}).superRefine((value, context) => {
  validateLifecycle(value, context);
  if (value.endsOn < value.startsOn) {
    context.addIssue({
      code: "custom",
      path: ["endsOn"],
      message: "The event cannot end before it starts.",
    });
  }
  if (value.registrationOpensOn && value.registrationOpensOn > value.endsOn) {
    context.addIssue({
      code: "custom",
      path: ["registrationOpensOn"],
      message: "Registration cannot open after the event ends.",
    });
  }
});

export type EventLifecycleInput = z.infer<typeof eventLifecycleInputSchema>;
export type EventSettingsInput = z.infer<typeof eventSettingsInputSchema>;
