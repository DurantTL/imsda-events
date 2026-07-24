import { z } from "zod";
import { getSquareConfiguration } from "@/modules/payments/square-config";
import { logError } from "@/lib/logger";
import {
  parseSquareWebhookEvent,
  squareWebhookPayloadHash,
  verifySquareWebhookSignature,
} from "@/modules/payments/square-domain";
import {
  processSquareWebhook,
  SquarePaymentOperationError,
} from "@/modules/payments/square-repository";
import { dispatchAlerts } from "@/modules/operations/alerting";
import { withRequestContext } from "@/lib/request-context";

export const runtime = "nodejs";

const maximumWebhookBytes = 1_024 * 1_024;
const noStoreHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: noStoreHeaders });
}

async function postHandler(request: Request) {
  const configuration = getSquareConfiguration();
  if (!configuration.webhookConfigured) {
    return json({
      error: "SQUARE_WEBHOOK_NOT_CONFIGURED",
      message: "Square webhook verification is not configured.",
    }, 503);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maximumWebhookBytes) {
    return json({ error: "WEBHOOK_TOO_LARGE" }, 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "WEBHOOK_BODY_UNREADABLE" }, 400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > maximumWebhookBytes) {
    return json({ error: "WEBHOOK_TOO_LARGE" }, 413);
  }

  const signature = request.headers.get(
    "x-square-hmacsha256-signature",
  ) ?? "";
  if (!verifySquareWebhookSignature({
    rawBody,
    notificationUrl: configuration.webhookNotificationUrl,
    signatureKey: configuration.webhookSignatureKey,
    signatureHeader: signature,
  })) {
    // Either somebody is posting forged payment events, or the signature key or
    // notification URL does not match what Square is using — in which case
    // every real payment result is being rejected right now. Both page.
    await dispatchAlerts([{
      key: "system.payments.webhook-rejected",
      severity: "URGENT",
      summary: "A Square webhook failed signature verification",
      detail: "Confirm SQUARE_WEBHOOK_SIGNATURE_KEY and SQUARE_WEBHOOK_NOTIFICATION_URL match Square exactly. Until they do, no payment result is being recorded.",
    }]).catch(() => undefined);
    return json({ error: "INVALID_SQUARE_SIGNATURE" }, 403);
  }

  try {
    const event = parseSquareWebhookEvent(JSON.parse(rawBody));
    const result = await processSquareWebhook(
      event,
      squareWebhookPayloadHash(rawBody),
      { configuration }
    );
    return json({ received: true, ...result }, 200);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return json({
        error: "INVALID_SQUARE_WEBHOOK",
        message: "The signed Square webhook payload is invalid.",
      }, 400);
    }
    if (error instanceof SquarePaymentOperationError) {
      return json({
        error: error.code,
        message: error.message,
      }, error.retryable ? 503 : 500);
    }
    logError("Square webhook processing failed.", error);
    return json({ error: "SQUARE_WEBHOOK_FAILED" }, 500);
  }
}

export const POST = withRequestContext(postHandler);
