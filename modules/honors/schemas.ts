import { z } from "zod";

const text = (max: number) => z.string().trim().max(max);
const wholeNumber = (label: string, min: number, max: number) =>
  z.int(`${label} must be a whole number.`).min(min, `${label} must be at least ${min}.`).max(max);

export const honorInputSchema = z.object({
  code: text(40).min(1, "Enter the honor code."),
  name: text(120).min(1, "Enter the honor name."),
  description: text(2000).default(""),
  isActive: z.boolean().default(true),
}).strict();

export const honorUpdateSchema = honorInputSchema.partial().strict();

export const honorSessionInputSchema = z.object({
  name: text(80).min(1, "Enter the session name."),
  sortOrder: wholeNumber("Order", 0, 99).default(0),
}).strict();

export const honorSessionUpdateSchema = honorSessionInputSchema.partial().strict();

const offeringDetails = {
  capacity: wholeNumber("Capacity", 0, 10_000),
  minimumAge: wholeNumber("Minimum age", 0, 99).nullable().default(null),
  perClubLimit: wholeNumber("Per-club limit", 1, 1_000).nullable().default(null),
  teacherName: text(120).default(""),
  location: text(120).default(""),
  isActive: z.boolean().default(true),
};

export const honorOfferingInputSchema = z.object({
  honorId: z.string().min(1, "Choose an honor."),
  span: z.enum(["SINGLE_SESSION", "ALL_SESSIONS"]),
  sessionId: z.string().min(1).nullable().default(null),
  ...offeringDetails,
}).strict().superRefine((input, context) => {
  if (input.span === "SINGLE_SESSION" && !input.sessionId) {
    context.addIssue({ code: "custom", path: ["sessionId"], message: "Choose the session for this honor." });
  }
  if (input.span === "ALL_SESSIONS" && input.sessionId) {
    context.addIssue({ code: "custom", path: ["sessionId"], message: "An all-sessions honor isn't tied to one session." });
  }
});

/** Honor, span, and session are fixed once created; deactivate and add a new one instead. */
export const honorOfferingUpdateSchema = z.object({
  capacity: offeringDetails.capacity,
  minimumAge: wholeNumber("Minimum age", 0, 99).nullable(),
  perClubLimit: wholeNumber("Per-club limit", 1, 1_000).nullable(),
  teacherName: text(120),
  location: text(120),
  isActive: z.boolean(),
}).partial().strict();

export const honorCopyInputSchema = z.object({
  sourceEventId: z.string().min(1, "Choose the site to copy from."),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export type HonorInput = z.infer<typeof honorInputSchema>;
export type HonorUpdate = z.infer<typeof honorUpdateSchema>;
export type HonorSessionInput = z.infer<typeof honorSessionInputSchema>;
export type HonorSessionUpdate = z.infer<typeof honorSessionUpdateSchema>;
export type HonorOfferingInput = z.infer<typeof honorOfferingInputSchema>;
export type HonorOfferingUpdate = z.infer<typeof honorOfferingUpdateSchema>;
