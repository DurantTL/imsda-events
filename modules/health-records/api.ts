import { ZodError } from "zod";
import { logError } from "@/lib/logger";
import { SecretBoxError } from "@/lib/secret-box";
import { AccessDeniedError } from "@/modules/access/authorization";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { HEALTH_NOT_FOUND_MESSAGE, HealthRecordError } from "@/modules/health-records/errors";
import { requireHealthRecordsEnabled } from "@/modules/health-records/flag";

/**
 * Shared plumbing for the health routes (#611): the switched-off gate, a JSON
 * reader that never logs or echoes the body, and one error mapper. No response
 * is cacheable, and no error message carries a health value.
 */

export const healthPrivateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

export const MAX_HEALTH_BODY_BYTES = 100_000;

export function healthJson(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, { ...init, headers: { ...healthPrivateHeaders, ...init.headers } });
}

/**
 * First line of every handler: with the flag off, the route answers exactly as
 * an unknown route does, before it reads a body, a cookie or a token.
 */
export function healthDisabledResponse(): Response | null {
  try {
    requireHealthRecordsEnabled();
    return null;
  } catch {
    return healthJson({ error: "NOT_FOUND", message: HEALTH_NOT_FOUND_MESSAGE }, { status: 404 });
  }
}

export class HealthBodyError extends Error {}

export async function readHealthJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_HEALTH_BODY_BYTES) {
    throw new HealthBodyError("The request is too large.");
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_HEALTH_BODY_BYTES) throw new HealthBodyError("The request is too large.");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HealthBodyError("Send a JSON request body.");
  }
}

const statusByCode: Record<HealthRecordError["code"], number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  MEMBER_NOT_FOUND: 404,
  LINK_UNAVAILABLE: 404,
  LINK_NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  EMAIL_NOT_CONFIGURED: 503,
  ENCRYPTION_NOT_CONFIGURED: 503,
  UNREADABLE: 500,
};

export function healthApiError(error: unknown, action: string) {
  if (error instanceof HealthBodyError) {
    return healthJson({ error: "INVALID_REQUEST_BODY", message: error.message }, { status: 400 });
  }
  if (error instanceof ZodError) {
    // The issue text only: Zod can echo the submitted value elsewhere, so nothing else is sent.
    return healthJson({ error: "INVALID_REQUEST", message: "Check the form and try again." }, { status: 400 });
  }
  if (error instanceof RosterAccessError || error instanceof AccessDeniedError) {
    return healthJson({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof HealthRecordError) {
    if (statusByCode[error.code] >= 500) logError(action, error);
    return healthJson(
      { error: error.code, message: error.message, ...(error.issues.length > 0 ? { issues: error.issues } : {}) },
      { status: statusByCode[error.code] },
    );
  }
  if (error instanceof SecretBoxError) {
    logError(action, error);
    return healthJson({ error: "ENCRYPTION_NOT_CONFIGURED", message: "Encryption isn't set up on this server." }, { status: 503 });
  }
  logError(`${action} failed`, error);
  return healthJson({ error: "HEALTH_REQUEST_FAILED", message: `${action} could not be completed.` }, { status: 500 });
}
