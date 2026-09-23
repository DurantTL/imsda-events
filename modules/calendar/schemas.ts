import { z } from "zod";
import { isCalendarDate } from "@/modules/calendar/domain";

const text = (max: number) => z.string().trim().max(max);
const calendarDate = (label: string) =>
  z.string().refine(isCalendarDate, `Enter the ${label} as a date.`);

const entryFields = {
  title: text(140).min(1, "Enter a title."),
  description: text(2000).default(""),
  startsOn: calendarDate("start date"),
  endsOn: calendarDate("end date"),
  timeLabel: text(80).default(""),
  location: text(160).default(""),
  category: text(40).default(""),
  linkUrl: z.union([
    z.literal("").transform(() => null),
    z.url({ protocol: /^https$/, message: "Links must start with https://." }).max(500),
  ]).nullable().default(null),
  status: z.enum(["SCHEDULED", "POSTPONED", "CANCELLED"]).default("SCHEDULED"),
  isPublished: z.boolean().default(false),
};

function endsAfterStart(input: { startsOn?: string; endsOn?: string }, context: z.RefinementCtx) {
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "The end date can't be before the start date." });
  }
}

export const calendarEntryInputSchema = z.object(entryFields).strict().superRefine(endsAfterStart);

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
