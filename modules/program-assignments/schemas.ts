import { z } from "zod";

export const programAssignmentSelectionSchema = z.object({
  formVersionId: z.string().trim().min(1).max(100),
  fieldId: z.string().trim().min(1).max(100),
  /**
   * Attendee types (the form's "attendee_type" answer) kept out of this
   * assignment, e.g. Teens in their own program (WR26). Their rankings are
   * ignored rather than erased.
   */
  leaveOutAttendeeTypes: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
}).strict();

export const applyProgramAssignmentsSchema = programAssignmentSelectionSchema.extend({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/, "Preview fingerprint is invalid."),
  clientRequestId: z.uuid(),
}).strict();

export type ProgramAssignmentSelection = z.input<typeof programAssignmentSelectionSchema>;
export type ApplyProgramAssignmentsInput = z.input<typeof applyProgramAssignmentsSchema>;
