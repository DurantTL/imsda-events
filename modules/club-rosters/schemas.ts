import { z } from "zod";

const classLevel = z.enum(["FRIEND", "COMPANION", "EXPLORER", "RANGER", "VOYAGER", "GUIDE", "TLT", "MASTER_GUIDE"]).nullable();

const name = (label: string) => z.string().trim().min(1, `Enter the ${label}.`).max(80);

export const rosterMemberInputSchema = z.object({
  firstName: name("first name"),
  lastName: name("last name"),
  birthDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the birth date."),
  attendeeType: z.enum(["YOUTH", "STAFF", "ADULT", "UNDERAGE"]),
  role: z.string().trim().max(60).default(""),
  classLevel: classLevel.default(null),
  gender: z.enum(["FEMALE", "MALE"]).nullable().default(null),
}).strict();

export const rosterMemberUpdateSchema = z.object({
  firstName: name("first name"),
  lastName: name("last name"),
  birthDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the birth date."),
  attendeeType: z.enum(["YOUTH", "STAFF", "ADULT", "UNDERAGE"]),
  role: z.string().trim().max(60),
  classLevel,
  gender: z.enum(["FEMALE", "MALE"]).nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
}).partial().strict();

export const rosterRemoveSchema = z.object({
  confirm: z.literal(true, "Confirm that this person should be removed."),
}).strict();

export const rosterUnlockSchema = z.object({
  code: z.string().trim().min(6, "Enter the code from your authenticator app.").max(20),
}).strict();

export type RosterMemberInput = z.infer<typeof rosterMemberInputSchema>;
export type RosterMemberUpdate = z.infer<typeof rosterMemberUpdateSchema>;
