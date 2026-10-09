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
  /**
   * Set on event announcements (#838): sent as `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058 one-click)
   * so Gmail and Yahoo offer their own Unsubscribe button. The URL is a signed link for this recipient.
   */
  listUnsubscribe?: { url: string } | null;
  idempotencyKey: string;
  messageId: string;
};

export type EmailDeliveryResult = {
  provider: EmailProviderName;
  providerMessageId: string;
};

export class EmailProviderConfigurationError extends Error {
  /**
   * `batchWide` (the default): the provider setup is wrong (credentials, region), so every message would fail the
   * same way and a delivery run stops rather than spending an attempt on each. `false`: only this message is at fault.
   */
  constructor(message: string, public readonly batchWide = true) {
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

/**
 * RFC 2369 and RFC 8058 unsubscribe headers (#838), the same for both providers. `List-Unsubscribe-Post` is what
 * makes the mail client's own Unsubscribe button a one-click POST to the URL, with no page and no login. The URL
 * must be a plain http(s) address: anything with whitespace, angle brackets or a line break could not sit safely
 * inside the header, so it is refused rather than cleaned.
 */
export function listUnsubscribeHeaders(listUnsubscribe: { url: string } | null | undefined): Record<string, string> {
  if (!listUnsubscribe) return {};
  const url = listUnsubscribe.url.trim();
  if (!/^https?:\/\/[^\s<>"]+$/i.test(url)) {
    throw new EmailProviderConfigurationError("The unsubscribe link for this message is not a valid web address.", false);
  }
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
