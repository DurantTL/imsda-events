import { ZodError } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { CalendarError } from "@/modules/calendar/repository";
import { logError } from "@/lib/logger";

export function calendarApiError(error: unknown, action: string) {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "INVALID_CALENDAR_REQUEST", message: error.issues[0]?.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof CalendarError) {
    return Response.json({ error: error.code, message: error.message }, { status: 404 });
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "CALENDAR_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500 },
  );
}
