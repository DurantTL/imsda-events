import { z } from "zod";

export const shirtSizeOptions = [
  "Youth S",
  "Youth M",
  "Youth L",
  "Youth XL",
  "Adult XS",
  "Adult S",
  "Adult M",
  "Adult L",
  "Adult XL",
  "Adult 2XL",
  "Adult 3XL",
  "Adult 4XL",
  "Adult 5XL",
] as const;

export const shirtSizeSchema = z.enum(shirtSizeOptions);
export type ShirtSize = z.infer<typeof shirtSizeSchema>;

const attendeeShirtSizeSchema = z.strictObject({
  attendeeId: z.string().trim().min(1).max(80),
  shirtSize: shirtSizeSchema,
});

export const publicShirtSizeConfirmationSchema = z.strictObject({
  attendees: z.array(attendeeShirtSizeSchema).min(1).max(50),
}).superRefine((input, context) => {
  const attendeeIds = new Set<string>();
  input.attendees.forEach((attendee, index) => {
    if (attendeeIds.has(attendee.attendeeId)) {
      context.addIssue({
        code: "custom",
        path: ["attendees", index, "attendeeId"],
        message: "Each attendee can be confirmed only once.",
      });
    }
    attendeeIds.add(attendee.attendeeId);
  });
});

export type PublicShirtSizeConfirmationInput = z.infer<
  typeof publicShirtSizeConfirmationSchema
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function shirtSizeFromResponses(value: unknown) {
  const result = shirtSizeSchema.safeParse(record(value).shirt_size);
  return result.success ? result.data : null;
}

/**
 * Whether an event collects convention shirts at all.
 *
 * Still a name match rather than a stored event capability, which is a known
 * shortcoming: renaming the event silently turns shirt collection off. It lives
 * here rather than beside one caller because three paths must agree — the
 * registrant's picker, the handler that accepts their answer, and the staff
 * batch that asks for it. Two of the three agreeing is worse than none: it
 * mails people a link to a page that will refuse them.
 */
export function eventUsesConventionShirts(event: { name: string; slug: string }) {
  return event.slug.includes("womens-retreat")
    || /\bwomen(?:'|’)?s?\s+retreat\b/i.test(event.name);
}

export function shirtSizeConfirmedAtFromResponses(value: unknown) {
  const confirmedAt = record(value).shirt_size_confirmed_at;
  if (typeof confirmedAt !== "string") return null;
  const date = new Date(confirmedAt);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
