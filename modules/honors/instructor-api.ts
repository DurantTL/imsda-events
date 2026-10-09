import "server-only";

import { ZodError, z } from "zod";
import { logError } from "@/lib/logger";
import { AccessDeniedError } from "@/modules/access/authorization";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { HonorInstructorError } from "@/modules/honors/instructor-repository";
import { BULK_MARK_ACTIONS } from "@/modules/honors/instructor-domain";

/**
 * The signed-in instructor, and only the person themselves: a staff member
 * switched into an attendee view (`via: "staff"`) never reads or marks a roster
 * as an instructor. Every instructor route starts here, and every query after
 * it starts from this account id: there is no account or class id in a request
 * body that could widen it.
 */
export async function requireInstructorAccount() {
  const { account, via } = await getCurrentAttendee();
  if (!account || via !== "attendee") {
    throw new AccessDeniedError("Sign in with your own account to see your classes.", 401, "AUTHENTICATION_REQUIRED");
  }
  return account;
}

export const instructorMarkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(BULK_MARK_ACTIONS) }).strict(),
  z.object({
    action: z.literal("SET"),
    enrollmentId: z.string().min(1).max(100),
    attended: z.boolean().optional(),
    completed: z.boolean().optional(),
  }).strict().refine((value) => value.attended !== undefined || value.completed !== undefined, { message: "Choose attended or completed." }),
]);

export const instructorInviteSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  offeringIds: z.array(z.string().min(1).max(100)).min(1).max(50),
}).strict();

export const instructorClassesSchema = z.object({ offeringIds: z.array(z.string().min(1).max(100)).min(1).max(50) }).strict();

export function instructorApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json({ error: "INVALID_INSTRUCTOR_REQUEST", message: error.issues[0]?.message ?? "Check the details and try again." }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof HonorInstructorError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  // Never log a body or a roster: they hold names of young people.
  logError(`${action} failed`, error);
  return Response.json({ error: "HONOR_INSTRUCTOR_FAILED", message: `${action} could not be completed.` }, { status: 500 });
}
