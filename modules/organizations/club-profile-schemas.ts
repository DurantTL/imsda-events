import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).default("");

/** A club's profile (#375), as its director, deputy, or conference staff edits it. */
export const clubProfileInputSchema = z.object({
  name: z.string().trim().min(2, "Enter the club name.").max(120),
  sponsoringChurchId: z.string().trim().max(40).nullable().default(null),
  meetingPlace: text(200),
  meetingSchedule: text(120),
  contactEmail: z.union([z.literal(""), z.string().trim().toLowerCase().pipe(z.email("Enter a valid contact email, or leave it blank."))]).default(""),
  contactPhone: text(40),
  publicDescription: text(1000),
  listPublicly: z.boolean().default(false),
}).strict();

export type ClubProfileInput = z.infer<typeof clubProfileInputSchema>;
