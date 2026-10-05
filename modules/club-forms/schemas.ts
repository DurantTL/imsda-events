import { z } from "zod";
import { CLUB_FORM_LINK_MAX_DAYS, CLUB_FORM_LINK_MIN_DAYS } from "@/modules/club-forms/domain";
import { rosterMemberInputSchema } from "@/modules/club-rosters/schemas";

/** Answers are validated against the template's own definition; here they only need to be an object. */
const answers = z.record(z.string().max(80), z.unknown());

export const saveSubmissionSchema = z.object({
  templateKey: z.string().trim().min(1).max(80),
  submissionId: z.string().trim().min(1).max(80).optional(),
  rosterMemberId: z.string().trim().min(1).max(80).nullable().optional(),
  subjectName: z.string().trim().max(120).optional(),
  answers,
  submit: z.boolean(),
}).strict();

export const createLinkSchema = z.object({
  templateKey: z.string().trim().min(1).max(80),
  recipientEmail: z.email("Enter a valid email address.").max(160),
  subjectName: z.string().trim().max(120).optional(),
  rosterMemberId: z.string().trim().min(1).max(80).nullable().optional(),
  expiresInDays: z.number().int().min(CLUB_FORM_LINK_MIN_DAYS).max(CLUB_FORM_LINK_MAX_DAYS).optional(),
}).strict();

export const publicSubmitSchema = z.object({ answers }).strict();

export const templateEnabledSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * Confirming "Add to roster" (#721). ADD carries the details the director
 * checked, validated by the roster's own schema (so its rules apply unchanged);
 * LINK names an existing member of the club. There is no club year: only the current one can be added to. Nothing else can ride along: the
 * schemas are strict, so no answer or health value has a field to travel in.
 */
export const rosterAddSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ADD"),
    member: rosterMemberInputSchema,
  }).strict(),
  z.object({
    action: z.literal("LINK"),
    memberId: z.string().trim().min(1).max(80),
  }).strict(),
]);
