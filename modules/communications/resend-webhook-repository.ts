import "server-only";

import { Prisma } from "@prisma/client";
import type { ResendWebhookEvent } from "@/integrations/email/resend-webhook";
import { getPrisma } from "@/lib/prisma";
import {
  mapResendDeliveryEvent,
  providerTransitionUpdate,
} from "@/modules/communications/provider-events";

export type ResendWebhookRecordResult = {
  duplicate: boolean;
  matchedMessageId: string | null;
  mappedStatus: string | null;
};

export async function recordResendWebhookEvent(
  providerEventId: string,
  event: ResendWebhookEvent,
): Promise<ResendWebhookRecordResult> {
  const prisma = getPrisma();
  const occurredAt = new Date(event.created_at);
  const providerMessageId = event.data.email_id;
  const transition = mapResendDeliveryEvent(event.type, occurredAt);

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.messageProviderEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider: "RESEND",
            providerEventId,
          },
        },
        select: {
          messageOutboxId: true,
          mappedDeliveryStatus: true,
        },
      });
      if (existing) {
        return {
          duplicate: true,
          matchedMessageId: existing.messageOutboxId,
          mappedStatus: existing.mappedDeliveryStatus,
        };
      }

      const message = await tx.messageOutbox.findUnique({
        where: { providerMessageId },
        select: { id: true },
      });
      await tx.messageProviderEvent.create({
        data: {
          messageOutboxId: message?.id ?? null,
          provider: "RESEND",
          providerEventId,
          providerMessageId,
          eventType: event.type,
          mappedDeliveryStatus: transition?.status ?? null,
          occurredAt,
          payload: event as Prisma.InputJsonValue,
        },
      });
      if (message && transition) {
        await tx.messageOutbox.updateMany({
          where: {
            id: message.id,
            OR: [
              { providerStatusAt: null },
              { providerDeliveryStatus: "ACCEPTED" },
              { providerStatusAt: { lte: transition.occurredAt } },
            ],
          },
          data: providerTransitionUpdate(transition),
        });
      }
      return {
        duplicate: false,
        matchedMessageId: message?.id ?? null,
        mappedStatus: transition?.status ?? null,
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2002"
    ) {
      const existing = await prisma.messageProviderEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider: "RESEND",
            providerEventId,
          },
        },
        select: {
          messageOutboxId: true,
          mappedDeliveryStatus: true,
        },
      });
      if (existing) {
        return {
          duplicate: true,
          matchedMessageId: existing.messageOutboxId,
          mappedStatus: existing.mappedDeliveryStatus,
        };
      }
    }
    throw error;
  }
}
