import { z } from "zod";
import { yearEndFieldKeys } from "@/modules/club-reports/year-end-domain";

const count = z.number().int().min(0, "Counts can't be negative.").max(9999).nullable();

const valuesShape = Object.fromEntries(yearEndFieldKeys.map((key) => [key, count.optional()])) as Record<string, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;

/**
 * A Year-End Report as the club submits it (#607). `values` carries the
 * number the director sees in each field (pre-filled or typed); the server
 * works out overrides and every total. Totals sent by a browser are rejected
 * (`strict`), never trusted.
 */
export const yearEndReportInputSchema = z.object({
  contactName: z.string().trim().max(120).default(""),
  contactWorkPhone: z.string().trim().max(40).default(""),
  contactHomePhone: z.string().trim().max(40).default(""),
  contactCellPhone: z.string().trim().max(40).default(""),
  contactEmail: z.string().trim().max(200).default(""),
  values: z.object(valuesShape).strict(),
  status: z.enum(["DRAFT", "SUBMITTED"]),
}).strict().superRefine((report, context) => {
  if (report.contactEmail && !z.string().email().safeParse(report.contactEmail).success) {
    context.addIssue({ code: "custom", path: ["contactEmail"], message: "Enter a valid email address." });
  }
  if (report.status !== "SUBMITTED") return;
  if (report.contactName.length < 2) {
    context.addIssue({ code: "custom", path: ["contactName"], message: "Enter the name of the person submitting the report." });
  }
  if (!report.contactEmail) {
    context.addIssue({ code: "custom", path: ["contactEmail"], message: "Enter an email address." });
  }
});

export type YearEndReportInput = z.infer<typeof yearEndReportInputSchema>;
