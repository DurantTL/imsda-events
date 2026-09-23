import { z } from "zod";

const name = z.string().trim().max(80);

/** One club as the administrator confirmed it in the preview (#376). */
export const clubImportItemSchema = z.object({
  sourceKey: z.string().trim().regex(/^form-\d+:[A-Za-z0-9_-]{1,40}$/),
  entryId: z.string().trim().min(1).max(40),
  clubYear: z.string().regex(/^\d{4}-\d{2}$/),
  clubName: z.string().trim().min(2, "Every imported club needs a name.").max(120),
  /** An existing church, or null with `newChurchName` to create one, or neither for none. */
  churchId: z.string().trim().max(40).nullable(),
  newChurchName: z.string().trim().max(160).default(""),
  invites: z.array(z.object({
    role: z.enum(["DIRECTOR", "DEPUTY"]),
    name: z.string().trim().max(160).default(""),
    email: z.string().trim().toLowerCase().pipe(z.email("Check the invite email addresses.")),
  }).strict()).max(4),
  people: z.array(z.object({
    firstName: name.min(1, "Every person needs a first name."),
    lastName: name.min(1, "Every person needs a last name. Fix it in the preview or skip them."),
    attendeeType: z.enum(["STAFF", "YOUTH", "ADULT"]),
    role: z.string().trim().max(60).default(""),
    classLevel: z.enum(["FRIEND", "COMPANION", "EXPLORER", "RANGER", "VOYAGER", "GUIDE", "TLT", "MASTER_GUIDE"]).nullable(),
    reportedAge: z.number().int().min(0).max(99).nullable(),
  }).strict()).max(300),
}).strict();

export const clubImportConfirmSchema = z.object({
  clubs: z.array(clubImportItemSchema).min(1, "Choose at least one club to import.").max(400),
}).strict();

export type ClubImportItem = z.infer<typeof clubImportItemSchema>;
