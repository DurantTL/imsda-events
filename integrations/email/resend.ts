import "server-only";

export type ResendEmailConfiguration = {
  apiKey: string;
  apiUrl: string;
};

export type EmailDeliveryInput = {
  fromName: string;
  fromEmail: string;
  toEmail: string;
  replyToEmail?: string | null;
  subject: string;
  bodyText: string;
  idempotencyKey: string;
  messageId: string;
};

export type EmailDeliveryResult = {
  provider: "RESEND";
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

export function getResendEmailAvailability() {
  return {
    deliveryConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
    webhookConfigured: Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim()),
  };
}

function cleanHeaderText(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
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
        ...(input.replyToEmail?.trim()
          ? { reply_to: input.replyToEmail.trim().toLowerCase() }
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
