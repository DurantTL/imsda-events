import { z } from "zod";
import { isCalendarDate } from "@/modules/calendar/domain";

const text = (max: number) => z.string().trim().max(max);
const calendarDate = (label: string) =>
  z.string().refine(isCalendarDate, `Enter the ${label} as a date.`);

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
};

function endsAfterStart(input: { startsOn?: string; endsOn?: string }, context: z.RefinementCtx) {
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "The end date can't be before the start date." });
  }
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

export type CalendarEntryInput = z.infer<typeof calendarEntryInputSchema>;
export type CalendarEntryUpdate = z.infer<typeof calendarEntryUpdateSchema>;
export type CalendarEventSettings = z.infer<typeof calendarEventSettingsSchema>;
