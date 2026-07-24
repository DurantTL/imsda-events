import {
  ResendWebhookConfigurationError,
  ResendWebhookVerificationError,
  verifyResendWebhook,
} from "@/integrations/email/resend-webhook";
import { recordResendWebhookEvent } from "@/modules/communications/resend-webhook-repository";
import { logError } from "@/lib/logger";
import { dispatchAlerts } from "@/modules/operations/alerting";
import { withRequestContext } from "@/lib/request-context";

export const runtime = "nodejs";

async function postHandler(request: Request) {
  const rawBody = await request.text();
  try {
    const verified = verifyResendWebhook(rawBody, request.headers);
    const result = await recordResendWebhookEvent(
      verified.providerEventId,
      verified.event
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
        { status: 503 }
      );
    }
    if (error instanceof ResendWebhookVerificationError) {
      // A mismatched signing secret means every bounce and complaint is being
      // discarded, which is invisible from the application's own state.
      await dispatchAlerts([{
        key: "system.email.webhook-rejected",
        severity: "WATCH",
        summary: "A Resend webhook failed verification",
        detail: "Check RESEND_WEBHOOK_SECRET. Until it matches, delivery, bounce, and complaint results are being discarded.",
      }]).catch(() => undefined);
      return Response.json(
        {
          error: "INVALID_RESEND_WEBHOOK",
          message: "The email delivery webhook could not be verified.",
        },
        { status: 400 }
      );
    }
    logError("Recording the Resend webhook failed", error);
    return Response.json(
      {
        error: "RESEND_WEBHOOK_FAILED",
        message: "The email delivery webhook could not be recorded.",
      },
      { status: 500 }
    );
  }
}

export const POST = withRequestContext(postHandler);
