import { Prisma } from "@prisma/client";
import { z } from "zod";
import { logError } from "@/lib/logger";
import { isLockTimeoutError } from "@/lib/prisma-errors";
import { AccessDeniedError } from "@/modules/access/authorization";
import { EventLocationError, eventLocationErrorStatus, locationBusyMessage } from "@/modules/event-locations/errors";

const noStore = { "Cache-Control": "no-store" };

/** A lock wait that gave up (55P03) or a transaction that timed out (P2028): nothing was saved, try again. */
export function isBusyDatabaseError(error: unknown) {
  return isLockTimeoutError(error)
    || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028");
}

export function eventLocationApiError(error: unknown, action: string) {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status, headers: noStore });
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: "INVALID_LOCATION", message: error.issues[0]?.message ?? "Review the location details.", issues: error.issues },
      { status: 400, headers: noStore },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "INVALID_JSON", message: "The request is not valid JSON." }, { status: 400, headers: noStore });
  }
  if (error instanceof EventLocationError) {
    return Response.json({ error: error.code, message: error.message }, { status: eventLocationErrorStatus(error.code), headers: noStore });
  }
  if (isBusyDatabaseError(error)) {
    return Response.json({ error: "LOCATION_BUSY", message: locationBusyMessage }, { status: 503, headers: noStore });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
    return Response.json(
      { error: "LOCATION_CONFLICT", message: "Another change landed at the same time. Refresh and try again." },
      { status: 409, headers: noStore },
    );
  }
  logError(`${action} failed`, error);
  return Response.json(
    { error: "LOCATION_REQUEST_FAILED", message: `${action} could not be completed.` },
    { status: 500, headers: noStore },
  );
}
