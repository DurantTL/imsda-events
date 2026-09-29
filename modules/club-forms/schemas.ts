import { z } from "zod";
import { CLUB_FORM_LINK_MAX_DAYS, CLUB_FORM_LINK_MIN_DAYS } from "@/modules/club-forms/domain";

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
