import { z } from "zod";
import { pointItems, type PointItemKey } from "@/modules/club-reports/domain";

const count = z.number().int().min(0, "Counts can't be negative.").max(999).nullable();
const classLevel = z.enum(["FRIEND", "COMPANION", "EXPLORER", "RANGER", "VOYAGER", "GUIDE", "TLT", "MASTER_GUIDE"]);

const pointsShape = Object.fromEntries(
  pointItems.map((item) => [item.key, z.number().int().min(0).max(1000).optional()]),
) as Record<PointItemKey, z.ZodOptional<z.ZodNumber>>;

/** A monthly report as the club (or staff) submits it (#377). Totals are worked out on the server. */
export const clubReportInputSchema = z.object({
  meetingPlace: z.string().trim().max(200).default(""),
  meetingSchedule: z.string().trim().max(120).default(""),
  averageAttendance: count.default(null),
  pathfinderCount: count.default(null),
  tltCount: count.default(null),
  staffCount: count.default(null),
  investitureDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the investiture date."), z.literal(""), z.null()])
    .default(null)
    .transform((value) => value || null),
  classLevels: z.array(classLevel).max(8).default([]).transform((levels) => [...new Set(levels)]),
  points: z.object(pointsShape).strict(),
  honors: z.array(z.object({
    name: z.string().trim().max(80),
    participants: count,
  }).strict()).max(3, "List at most 3 honors.").default([]),
  signatureName: z.string().trim().min(2, "Type your full name to sign the report.").max(120),
  signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date you signed."),
  /** DRAFT keeps a partial report; SUBMITTED marks it filed for the conference (#426). */
  status: z.enum(["DRAFT", "SUBMITTED"]),
}).strict();

export type ClubReportInput = z.infer<typeof clubReportInputSchema>;

export const registrationStandingSchema = z.object({
  organizationId: z.string().trim().min(1).max(40),
  clubYear: z.string().regex(/^\d{4}-\d{2}$/),
  registrationOnTime: z.boolean(),
}).strict();
