import {
  ResendWebhookConfigurationError,
  ResendWebhookVerificationError,
  verifyResendWebhook,
} from "@/integrations/email/resend-webhook";
import { recordResendWebhookEvent } from "@/modules/communications/resend-webhook-repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    const verified = verifyResendWebhook(rawBody, request.headers);
    const result = await recordResendWebhookEvent(
      verified.providerEventId,
      verified.event,
    );
    return Response.json({
      received: true,
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error instanceof ResendWebhookConfigurationError) {
      return Response.json(
        {
          error: "RESEND_WEBHOOK_NOT_CONFIGURED",
          message: "The email delivery webhook is not configured.",
        },
        { status: 503 },
      );
    }
    if (error instanceof ResendWebhookVerificationError) {
      return Response.json(
        {
          error: "INVALID_RESEND_WEBHOOK",
          message: "The email delivery webhook could not be verified.",
        },
        { status: 400 },
      );
    }
    console.error("Recording the Resend webhook failed", error);
    return Response.json(
      {
        error: "RESEND_WEBHOOK_FAILED",
        message: "The email delivery webhook could not be recorded.",
      },
      { status: 500 },
    );
  }
}
