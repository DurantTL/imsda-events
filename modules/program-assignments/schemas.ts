import { z } from "zod";

export const programAssignmentSelectionSchema = z.object({
  formVersionId: z.string().trim().min(1).max(100),
  fieldId: z.string().trim().min(1).max(100),
}).strict();

export const applyProgramAssignmentsSchema = programAssignmentSelectionSchema.extend({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/, "Preview fingerprint is invalid."),
  clientRequestId: z.uuid(),
}).strict();

export type ProgramAssignmentSelection = z.infer<typeof programAssignmentSelectionSchema>;
export type ApplyProgramAssignmentsInput = z.infer<typeof applyProgramAssignmentsSchema>;
