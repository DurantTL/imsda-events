import { z } from "zod";
import { isCalendarDate } from "@/modules/calendar/domain";
import { maxRepeatCount, maxRepeatInterval, repeatFrequencies, repeatStartProblem } from "@/modules/calendar/recurrence";

const text = (max: number) => z.string().trim().max(max);
const calendarDate = (label: string) =>
  z.string().refine(isCalendarDate, `Enter the ${label} as a date.`);

/** A repeat as the editor sends it; stored as an RRULE (see `serializeRepeatRule`). */
export const repeatSchema = z.object({
  frequency: z.enum(repeatFrequencies),
  interval: z.number().int().min(1).max(maxRepeatInterval).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  until: calendarDate("last repeat date").nullable().default(null),
  count: z.number().int().min(1).max(maxRepeatCount).nullable().default(null),
  /** 0 = weeks start on Sunday (the editor's choice), 1 = Monday (an RRULE with no WKST). */
  weekStart: z.union([z.literal(0), z.literal(1)]).default(0),
}).strict().superRefine((repeat, context) => {
  if (repeat.until && repeat.count) {
    context.addIssue({ code: "custom", path: ["count"], message: "End a repeat on a date or after a number of times, not both." });
  }
  if (repeat.weekdays.length > 0 && repeat.frequency !== "WEEKLY") {
    context.addIssue({ code: "custom", path: ["weekdays"], message: "Weekdays only apply to weekly repeats." });
  }
});

const repeatExceptionsSchema = z.array(calendarDate("skipped date")).max(200);

/** Bare fields, no defaults: the update schema is built from these so a partial PATCH carries only what was sent. */
const entryFields = {
  title: text(140).min(1, "Enter a title."),
  description: text(2000),
  startsOn: calendarDate("start date"),
  endsOn: calendarDate("end date"),
  timeLabel: text(80),
  location: text(160),
  category: text(40),
  linkUrl: z.union([
    z.literal("").transform(() => null),
    z.url({ protocol: /^https$/, message: "Links must start with https://." }).max(500),
  ]).nullable(),
  status: z.enum(["SCHEDULED", "POSTPONED", "CANCELLED"]),
  isPublished: z.boolean(),
  entryType: z.enum(["STANDARD", "CLOSURE"]),
  repeat: repeatSchema.nullable(),
  repeatExceptions: repeatExceptionsSchema,
};

const entryInputFields = {
  ...entryFields,
  description: entryFields.description.default(""),
  timeLabel: entryFields.timeLabel.default(""),
  location: entryFields.location.default(""),
  category: entryFields.category.default(""),
  linkUrl: entryFields.linkUrl.default(null),
  status: entryFields.status.default("SCHEDULED"),
  isPublished: entryFields.isPublished.default(false),
  entryType: entryFields.entryType.default("STANDARD"),
  repeat: entryFields.repeat.default(null),
  repeatExceptions: entryFields.repeatExceptions.default([]),
};

function endsAfterStart(
  input: { startsOn?: string; endsOn?: string; repeat?: { frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; weekdays: number[]; until: string | null } | null },
  context: z.RefinementCtx,
) {
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "The end date can't be before the start date." });
  }
  const problem = input.startsOn && input.repeat ? repeatStartProblem(input.repeat, input.startsOn) : null;
  if (problem) context.addIssue({ code: "custom", path: ["repeat"], message: problem });
}

export const calendarEntryInputSchema = z.object(entryInputFields).strict().superRefine(endsAfterStart);

/** Both dates are sent together so the order check always sees the pair. */
export const calendarEntryUpdateSchema = z.object(entryFields).partial().strict()
  .refine((input) => (input.startsOn === undefined) === (input.endsOn === undefined), {
    message: "Send the start and end dates together.",
    path: ["endsOn"],
  })
  .superRefine(endsAfterStart);

export const calendarEventSettingsSchema = z.object({
  showOnCalendar: z.boolean().optional(),
  calendarCategory: text(40).nullable().optional().transform((value) => (value === "" ? null : value)),
}).strict();

export type CalendarRepeatInput = z.infer<typeof repeatSchema>;
export type CalendarEntryInput = z.infer<typeof calendarEntryInputSchema>;
export type CalendarEntryUpdate = z.infer<typeof calendarEntryUpdateSchema>;
export type CalendarEventSettings = z.infer<typeof calendarEventSettingsSchema>;
