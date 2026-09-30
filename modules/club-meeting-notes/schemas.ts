import { z } from "zod";
import { isMeetingDate } from "@/modules/club-meeting-notes/domain";

/** A meeting note as the club submits it (#426). Counts are typed in; no birth dates or names. */
const count = z.number().int().min(0, "Counts can't be negative.").max(999).nullable();

export const meetingNoteInputSchema = z.object({
  meetingDate: z.string().refine(isMeetingDate, "Enter a real meeting date."),
  pathfinderCount: count.default(null),
  tltCount: count.default(null),
  staffCount: count.default(null),
  honors: z.array(z.object({
    name: z.string().trim().max(80),
    participants: count,
  }).strict()).max(20, "List at most 20 honors.").default([]),
  notes: z.string().trim().max(4000).default(""),
  /**
   * Optional check-off (#653). Omitted leaves the meeting's attendance as it
   * is; a list replaces it (an empty list clears it). Head counts left blank
   * are filled from it.
   */
  attendance: z.array(z.object({
    rosterMemberId: z.string().min(1).max(64),
    present: z.boolean(),
  }).strict()).max(500, "Attendance lists at most 500 people.").optional(),
}).strict();

export type MeetingNoteInput = z.infer<typeof meetingNoteInputSchema>;
