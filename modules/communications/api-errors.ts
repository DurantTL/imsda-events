import { z } from "zod";
import { AccessDeniedError } from "@/modules/access/authorization";
import { MessagingError } from "@/modules/communications/messaging-repository";

export function messagingApiError(error: unknown, operation: string) {
  if (error instanceof z.ZodError) {
    return Response.json(
      {
        error: "INVALID_MESSAGE_REQUEST",
        message: error.issues[0]?.message ?? "Review the message fields and try again.",
        issues: error.issues,
      },
      { status: 400 },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json(
      { error: "INVALID_JSON", message: "The message request is not valid JSON." },
      { status: 400 },
    );
  }
  if (error instanceof AccessDeniedError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  if (error instanceof MessagingError) {
    const status = error.code === "MESSAGE_NOT_FOUND" || error.code === "TEMPLATE_NOT_FOUND"
      ? 404
      : 409;
    return Response.json(
      { error: error.code, message: error.message, ...error.details },
      { status },
    );
  }
  console.error(`${operation} failed`, error);
  return Response.json(
    { error: "MESSAGE_REQUEST_FAILED", message: `${operation} could not be completed.` },
    { status: 500 },
  );
}
