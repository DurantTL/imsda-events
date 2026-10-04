import { z } from "zod";

export const CORRECTION_REASON_MAX = 500;

const id = z.string().trim().min(1).max(64);

/** A correction always carries a reason. */
const reason = z.string().trim().min(1, "Say why you are correcting this person's attendance.").max(CORRECTION_REASON_MAX, `Keep the reason to ${CORRECTION_REASON_MAX} characters or fewer.`);

/** One endpoint, one tagged body: every action is a MANAGE_FINANCE action on the event in the URL. */
export const attendanceReconciliationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare") }),
  z.object({ action: z.literal("approve"), versionId: id }),
  z.object({ action: z.literal("acknowledge"), registrationId: id, choice: z.enum(["PER_PERSON", "PRORATED"]), reason: z.string().trim().min(1, "Say why you accept the prorated figure for this registration.").max(CORRECTION_REASON_MAX, `Keep the reason to ${CORRECTION_REASON_MAX} characters or fewer.`) }),
  z.object({
    action: z.literal("correct"),
    attendeeId: id,
    kind: z.enum(["MARK_ATTENDED", "MARK_NOT_ATTENDED", "CLEAR"]),
    reason,
  }),
]);

export type AttendanceReconciliationAction = z.infer<typeof attendanceReconciliationActionSchema>;
