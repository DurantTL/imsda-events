import { z } from "zod";
import { rosterRoleOrDefault } from "@/modules/club-rosters/domain";

const classLevel = z.enum(["FRIEND", "COMPANION", "EXPLORER", "RANGER", "VOYAGER", "GUIDE", "TLT", "MASTER_GUIDE"]).nullable();

const name = (label: string) => z.string().trim().min(1, `Enter the ${label}.`).max(80);

/**
 * Left blank, a youth's role saves as "Pathfinder" and anyone else's stays
 * empty (#424). The default depends on the type, so it's applied on the whole
 * object for a new member, and by `updateRosterMember` for an edit (which
 * knows the stored type when the edit doesn't send one).
 */
const role = z.string().trim().max(60);

/**
 * Stays nullable in the stored shape — imports and other callers may
 * legitimately have no gender on file — but the roster form and edit dialog
 * always send one, so `.refine` below requires a choice whenever the field
 * is actually present in the request (#424). An edit that leaves the field
 * out is checked against the stored gender by `updateRosterMember`
 * (`requireGender`), so an existing member with no gender must choose one
 * the next time their details are edited.
 */
const gender = z.enum(["FEMALE", "MALE"]).nullable();

export const rosterMemberInputSchema = z.object({
  firstName: name("first name"),
  lastName: name("last name"),
  birthDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the birth date."),
  attendeeType: z.enum(["YOUTH", "STAFF", "ADULT", "UNDERAGE"]),
  role: role.default(""),
  classLevel: classLevel.default(null),
  gender: gender.default(null),
}).strict()
  .refine((data) => data.gender !== null, { message: "Choose Male or Female.", path: ["gender"] })
  .transform((data) => ({ ...data, role: rosterRoleOrDefault(data.role, data.attendeeType) }));

export const rosterMemberUpdateSchema = z.object({
  firstName: name("first name"),
  lastName: name("last name"),
  birthDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the birth date."),
  attendeeType: z.enum(["YOUTH", "STAFF", "ADULT", "UNDERAGE"]),
  role,
  classLevel,
  gender,
  status: z.enum(["ACTIVE", "INACTIVE"]),
}).partial().strict().refine((data) => !("gender" in data) || data.gender !== null, {
  message: "Choose Male or Female.",
  path: ["gender"],
});

export const rosterRemoveSchema = z.object({
  confirm: z.literal(true, "Confirm that this person should be removed."),
}).strict();

export const rosterUnlockSchema = z.object({
  code: z.string().trim().min(6, "Enter the code from your authenticator app.").max(20),
}).strict();

export type RosterMemberInput = z.infer<typeof rosterMemberInputSchema>;
export type RosterMemberUpdate = z.infer<typeof rosterMemberUpdateSchema>;
