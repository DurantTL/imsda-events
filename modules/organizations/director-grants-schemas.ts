import { z } from "zod";

const reason = z.string().trim().min(3, "Give a short reason (at least 3 characters).").max(500);

export const createDirectorGrantInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter the director's account email address.")),
  role: z.enum(["DIRECTOR", "DEPUTY", "REGISTRAR", "REPORTER"]).default("DIRECTOR"),
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
  effectiveTo: z.union([z.iso.datetime({ offset: true }), z.literal(""), z.null()])
    .optional()
    .transform((value) => value || null),
  reason,
}).strict();

export const revokeDirectorGrantInputSchema = z.object({
  reason,
}).strict();

/** A club's own director or deputy giving a helper role (#375). */
export const createClubTeamGrantInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter the person's account email address.")),
  role: z.enum(["REGISTRAR", "REPORTER"], "Choose Registrar or Reporter."),
}).strict();

export type CreateClubTeamGrantInput = z.infer<typeof createClubTeamGrantInputSchema>;
export type CreateDirectorGrantInput = z.infer<typeof createDirectorGrantInputSchema>;
export type RevokeDirectorGrantInput = z.infer<typeof revokeDirectorGrantInputSchema>;
