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
  /** The site (#589). Null is allowed here; the repository requires one when the event has active locations. */
  locationId: z.string().min(1).max(64).nullable().default(null),
}).strict();

/**
 * A partial update names only the fields it changes. It is built from bare
 * field schemas, not `honorSessionInputSchema.partial()`: Zod 4 still applies a
 * `.default()` to a missing key inside `.partial()`, so a rename sent as
 * `{ name }` parsed to `{ name, sortOrder: 0, locationId: null }` and the
 * repository then tried to clear the session's site ("Choose the site", #615)
 * and reset its order.
 */
export const honorSessionUpdateSchema = z.object({
  name: text(80).min(1, "Enter the session name."),
  sortOrder: wholeNumber("Order", 0, 99),
  locationId: z.string().min(1).max(64).nullable(),
}).partial().strict();

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
  /** The site of an all-sessions class (#589). A single-session class takes its session's site. */
  locationId: z.string().min(1).max(64).nullable().default(null),
  ...offeringDetails,
}).strict().superRefine((input, context) => {
  if (input.span === "SINGLE_SESSION" && input.locationId) {
    context.addIssue({ code: "custom", path: ["locationId"], message: "A single-session class is at its session's site." });
  }
  if (input.span === "SINGLE_SESSION" && !input.sessionId) {
    context.addIssue({ code: "custom", path: ["sessionId"], message: "Choose the session for this honor." });
  }
  if (input.span === "ALL_SESSIONS" && input.sessionId) {
    context.addIssue({ code: "custom", path: ["sessionId"], message: "An all-sessions honor isn't tied to one session." });
  }
});

/**
 * Every field set at creation can be edited (#615). The repository refuses a
 * change to the honor, span, session or site once clubs have picked the class.
 */
export const honorOfferingUpdateSchema = z.object({
  honorId: z.string().min(1, "Choose an honor."),
  span: z.enum(["SINGLE_SESSION", "ALL_SESSIONS"]),
  sessionId: z.string().min(1).nullable(),
  capacity: offeringDetails.capacity,
  minimumAge: wholeNumber("Minimum age", 0, 99).nullable(),
  perClubLimit: wholeNumber("Per-club limit", 1, 1_000).nullable(),
  teacherName: text(120),
  location: text(120),
  isActive: z.boolean(),
  /** Only for an all-sessions class (#589). */
  locationId: z.string().min(1).max(64).nullable(),
}).partial().strict();

/** `?confirmPicks=N` on a delete: the number of class picks the person was told would be removed. Absent means none were confirmed. */
export const honorDeleteConfirmSchema = z.object({
  confirmPicks: z.coerce.number().int("Confirm a whole number of picks.").min(0).optional(),
});

export function parseDeleteConfirmation(request: Request) {
  const raw = new URL(request.url).searchParams.get("confirmPicks");
  return honorDeleteConfirmSchema.parse(raw === null ? {} : { confirmPicks: raw }).confirmPicks;
}

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
