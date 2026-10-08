/** The provider recorded on a delivery attempt. Plain strings in the database, so a new provider needs no migration. */
export type EmailProviderName = "RESEND" | "SES";

export type EmailDeliveryInput = {
  fromName: string;
  fromEmail: string;
  toEmail: string;
  replyToEmail?: string | null;
  subject: string;
  bodyText: string;
  /**
   * The formatted body. Sent alongside `bodyText`, never instead of it: the
   * plain-text part stays the fallback for a client that will not render HTML.
   */
  bodyHtml?: string | null;
  /**
   * Files sent with the message (#168: an invoice PDF). Small by design: the caller stores each file once and
   * passes the same bytes on every send.
   */
  attachments?: Array<{
    filename: string;
    contentType: string;
    content: Uint8Array;
    /**
     * Makes the part an inline image: the HTML refers to it as `cid:<contentId>`, so the client shows it without
     * "download pictures". Resend receives it as `content_id`, SES (SMTP) as the part's Content-ID.
     */
    contentId?: string;
  }>;
  idempotencyKey: string;
  messageId: string;
};

export type EmailDeliveryResult = {
  provider: EmailProviderName;
  providerMessageId: string;
};

export class EmailProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailProviderConfigurationError";
  }
}

export class EmailProviderRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number,
  ) {
    super(message);
    this.name = "EmailProviderRequestError";
  }
}

/** A header value may never carry a line break: that is how a header gets injected. */
export function cleanHeaderText(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}
