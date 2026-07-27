import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { OrganizationOperationError } from "@/modules/organizations/repository";
import { logError } from "@/lib/logger";

export function organizationApiError(error: unknown, action: string) {
  if (error instanceof z.ZodError) {
    return Response.json({
      error: "INVALID_ORGANIZATION",
      message: error.issues[0]?.message
        ?? "Review the church or club details and try again.",
      issues: error.issues,
    }, { status: 400 });
  }
  if (error instanceof AccessDeniedError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  if (error instanceof OrganizationOperationError) {
    const status = error.code === "ORGANIZATION_NOT_FOUND"
      || error.code === "EXTERNAL_IDENTITY_NOT_FOUND"
      ? 404
      : 409;
    return Response.json(
      { error: error.code, message: error.message },
      { status },
    );
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2003"
  ) {
    return Response.json({
      error: "ORGANIZATION_RELATION_INVALID",
      message: "The selected sponsoring church is no longer available.",
    }, { status: 409 });
  }
  logError(`${action} failed`, error);
  return Response.json({
    error: "ORGANIZATION_REQUEST_FAILED",
    message: "The organization directory could not be updated.",
  }, { status: 500 });
}
