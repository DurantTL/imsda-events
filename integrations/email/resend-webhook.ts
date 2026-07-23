import "server-only";

import { Webhook, WebhookVerificationError } from "svix";
import { z } from "zod";

const resendWebhookEventSchema = z.object({
  type: z.string().trim().min(1),
  created_at: z.iso.datetime({ offset: true }),
  data: z.object({
    email_id: z.string().trim().min(1),
  }).loose(),
}).loose();

export type ResendWebhookEvent = z.infer<typeof resendWebhookEventSchema>;

export class ResendWebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResendWebhookConfigurationError";
  }
}

export class ResendWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResendWebhookVerificationError";
  }
}

export function verifyResendWebhook(
  rawBody: string,
  headers: Headers,
  secret = process.env.RESEND_WEBHOOK_SECRET?.trim(),
): { providerEventId: string; event: ResendWebhookEvent } {
  if (!secret) {
    throw new ResendWebhookConfigurationError(
      "The Resend webhook signing secret is not configured.",
    );
  }
  const providerEventId = headers.get("svix-id")?.trim();
  const timestamp = headers.get("svix-timestamp")?.trim();
  const signature = headers.get("svix-signature")?.trim();
  if (!providerEventId || !timestamp || !signature) {
    throw new ResendWebhookVerificationError(
      "Required Resend webhook signature headers are missing.",
    );
  }

  try {
    const verified = new Webhook(secret).verify(rawBody, {
      "svix-id": providerEventId,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    });
    return {
      providerEventId,
      event: resendWebhookEventSchema.parse(verified),
    };
  } catch (error) {
    if (error instanceof ResendWebhookVerificationError) throw error;
    if (error instanceof WebhookVerificationError || error instanceof z.ZodError) {
      throw new ResendWebhookVerificationError(
        "The Resend webhook signature or payload is invalid.",
      );
    }
    throw error;
  }
}
