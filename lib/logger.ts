import { randomUUID } from "node:crypto";

/**
 * Structured logging with an explicit redaction rule.
 *
 * Logs were plain strings on stdout with no correlation ID, and several route
 * handlers passed a whole error object to `console.error`. A Prisma error's
 * `message` embeds the failing query and its parameters, so that pattern could
 * put attendee data — including medical answers — into the container log.
 *
 * The rule here is deny-by-default: an error contributes its class name and,
 * where present, a short code. Its `message` is included only for the
 * application's own error classes, whose text is authored for an operator and
 * carries no record data.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, string | number | boolean | null | undefined>;

/**
 * Error classes whose `message` is operator-facing text written in this
 * codebase. Anything not listed here contributes only its name and code —
 * notably Prisma errors, which embed queries, and ZodError, whose issues can
 * echo the submitted value.
 */
const MESSAGE_SAFE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AccessDeniedError",
  "AttendeePassResolutionError",
  "AttendeePassTokenError",
  "CheckInOperationError",
  "CsvImportError",
  "EmailProviderConfigurationError",
  "EmailProviderRequestError",
  "EventOperationError",
  "ExternalEmailDeliveryError",
  "FormOperationError",
  "ImportOperationError",
  "MembershipOperationError",
  "MessagingError",
  "PaymentChoiceOperationError",
  "PaymentOperationError",
  "ProgramAssignmentError",
  "PromoCodeOperationError",
  "PublicPromoCodeError",
  "PublicRegistrationError",
  "RateLimitConfigurationError",
  "RegistrationAccessIssueError",
  "RegistrationAttendeeOperationError",
  "RegistrationLifecycleError",
  "RegistrationOperationError",
  "ResendWebhookConfigurationError",
  "ResendWebhookVerificationError",
  "ServerEnvironmentError",
  "SquareAdapterError",
  "SquareConfigurationError",
  "SquarePaymentOperationError",
]);

export type DescribedError = {
  name: string;
  code?: string;
  message?: string;
  redacted?: true;
};

/** Reduces any thrown value to the fields that are safe to persist in a log. */
export function describeError(error: unknown): DescribedError {
  if (!(error instanceof Error)) {
    return { name: typeof error, redacted: true };
  }

  const described: DescribedError = { name: error.name || "Error" };

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.length <= 64) described.code = code;

  if (MESSAGE_SAFE_ERROR_NAMES.has(described.name)) {
    described.message = error.message;
  } else {
    described.redacted = true;
  }

  return described;
}

function emit(level: LogLevel, message: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg: message,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(message: string, context: LogContext = {}) {
  emit("info", message, context);
}

export function logWarn(message: string, context: LogContext = {}) {
  emit("warn", message, context);
}

export function logError(message: string, error: unknown, context: LogContext = {}) {
  emit("error", message, { ...context, error: describeError(error) });
}

const CORRELATION_HEADER = "x-correlation-id";

/**
 * Reuses an inbound correlation ID when the proxy supplies one, so a single
 * registration can be followed end to end, and mints one otherwise. The
 * inbound value is bounded and constrained because it is attacker-controlled
 * and ends up in a log line.
 */
export function requestCorrelationId(request: Request): string {
  const supplied = request.headers.get(CORRELATION_HEADER)?.trim();
  if (supplied && supplied.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(supplied)) {
    return supplied;
  }
  return randomUUID();
}
