export class MessagingError extends Error {
  constructor(
    public readonly code:
      | "MESSAGE_NOT_FOUND"
      | "TEMPLATE_NOT_FOUND"
      | "DELIVERY_DISABLED"
      | "EXTERNAL_EMAIL_NOT_CONFIGURED"
      | "MESSAGE_NOT_RETRYABLE"
      | "MESSAGE_NOT_RESENDABLE"
      | "PREVIEW_CHANGED"
      | "EMPTY_AUDIENCE"
      | "IDEMPOTENCY_KEY_REUSED"
      | "EVENT_NOT_ELIGIBLE"
      | "INVALID_TEMPLATE"
      | "TEMPLATE_NOT_PUBLISHED"
      | "ATTACHMENTS_INVALID",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}
