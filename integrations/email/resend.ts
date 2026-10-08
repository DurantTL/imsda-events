import "server-only";

import {
  EmailProviderConfigurationError,
  EmailProviderRequestError,
  cleanHeaderText,
  type EmailDeliveryInput,
  type EmailDeliveryResult,
} from "./types";

// Re-exported so existing importers (and their tests) keep working unchanged.
export {
  EmailProviderConfigurationError,
  EmailProviderRequestError,
  type EmailDeliveryInput,
  type EmailDeliveryResult,
} from "./types";

export type ResendEmailConfiguration = {
  apiKey: string;
  apiUrl: string;
};


export function getResendEmailAvailability() {
  return {
    deliveryConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
    webhookConfigured: Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim()),
  };
}


export function getResendEmailConfiguration(): ResendEmailConfiguration {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new EmailProviderConfigurationError(
      "External email is not configured. Add a Resend API key before enabling live delivery.",
    );
  }
  return {
    apiKey,
    apiUrl: process.env.RESEND_API_URL?.trim() || "https://api.resend.com",
  };
}

export async function sendEmailWithResend(
  input: EmailDeliveryInput,
  configuration = getResendEmailConfiguration(),
  request: typeof fetch = fetch,
): Promise<EmailDeliveryResult> {
  if (!input.fromEmail.trim()) {
    throw new EmailProviderConfigurationError(
      "A verified sender email is required before external delivery can be enabled.",
      false,
    );
  }
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 256) {
    throw new Error("Email idempotency keys must contain 1 to 256 characters.");
  }

  let response: Response;
  try {
    response = await request(`${configuration.apiUrl.replace(/\/$/, "")}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: `${cleanHeaderText(input.fromName)} <${input.fromEmail.trim().toLowerCase()}>`,
        to: [input.toEmail.trim().toLowerCase()],
        subject: cleanHeaderText(input.subject),
        text: input.bodyText,
        ...(input.bodyHtml?.trim() ? { html: input.bodyHtml } : {}),
        ...(input.replyToEmail?.trim()
          ? { reply_to: input.replyToEmail.trim().toLowerCase() }
          : {}),
        ...(input.attachments && input.attachments.length > 0
          ? {
              attachments: input.attachments.map((attachment) => ({
                filename: cleanHeaderText(attachment.filename),
                content: Buffer.from(attachment.content).toString("base64"),
                content_type: attachment.contentType,
                ...(attachment.contentId ? { content_id: cleanHeaderText(attachment.contentId) } : {}),
              })),
            }
          : {}),
        tags: [{ name: "message_id", value: input.messageId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256) }],
      }),
      cache: "no-store",
    });
  } catch {
    throw new EmailProviderRequestError(
      "The email provider could not be reached.",
      "NETWORK_ERROR",
      true,
      0,
    );
  }

  const result = await response.json().catch(() => ({})) as {
    id?: string;
    name?: string;
    message?: string;
  };
  if (!response.ok || !result.id) {
    const code = result.name || `HTTP_${response.status}`;
    throw new EmailProviderRequestError(
      result.message || "The email provider did not accept this message.",
      code,
      response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      response.status,
    );
  }

  return {
    provider: "RESEND",
    providerMessageId: result.id,
  };
}
