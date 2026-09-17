import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { ConsentPolicyError } from "@/modules/consent/repository";

const notFoundCodes = new Set<ConsentPolicyError["code"]>([
  "POLICY_NOT_FOUND",
  "VERSION_NOT_FOUND",
  "APPLICABILITY_NOT_FOUND",
  "ATTENDEE_TYPE_NOT_FOUND",
]);

export function consentPolicyApiError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "INVALID_CONSENT_POLICY", message: error.issues[0]?.message, issues: error.issues }, { status: 400 });
  if (error instanceof SyntaxError) return Response.json({ error: "INVALID_CONSENT_POLICY", message: "The request body must be JSON." }, { status: 400 });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof ConsentPolicyError) return Response.json({ error: error.code, message: error.message }, { status: notFoundCodes.has(error.code) ? 404 : 409 });
  return Response.json({ error: "CONSENT_POLICY_REQUEST_FAILED", message: "The policy request could not be completed." }, { status: 500 });
}
