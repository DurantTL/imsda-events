import type {
  MessageOutboxStatus,
  MessageProviderDeliveryStatus,
  Prisma,
} from "@prisma/client";

export type ProviderDeliveryTransition = {
  status: MessageProviderDeliveryStatus;
  outboxStatus: MessageOutboxStatus;
  occurredAt: Date;
  lastError: string | null;
};

const resendStatusByEvent = {
  "email.sent": "SENT",
  "email.delivered": "DELIVERED",
  "email.bounced": "BOUNCED",
  "email.failed": "FAILED",
  "email.complained": "COMPLAINED",
  "email.suppressed": "SUPPRESSED",
} as const satisfies Record<string, MessageProviderDeliveryStatus>;

export function mapResendDeliveryEvent(
  eventType: string,
  occurredAt: Date,
): ProviderDeliveryTransition | null {
  const status = resendStatusByEvent[eventType as keyof typeof resendStatusByEvent];
  if (!status) return null;

  if (status === "BOUNCED") {
    return {
      status,
      outboxStatus: "FAILED",
      occurredAt,
      lastError: "Resend reported a permanent bounce for this recipient.",
    };
  }
  if (status === "FAILED") {
    return {
      status,
      outboxStatus: "FAILED",
      occurredAt,
      lastError: "Resend reported that this email could not be sent.",
    };
  }
  if (status === "COMPLAINED") {
    return {
      status,
      outboxStatus: "SENT",
      occurredAt,
      lastError: "The recipient reported this message as spam.",
    };
  }
  if (status === "SUPPRESSED") {
    return {
      status,
      outboxStatus: "SUPPRESSED",
      occurredAt,
      lastError: "Resend suppressed delivery to this recipient.",
    };
  }
  return {
    status,
    outboxStatus: "SENT",
    occurredAt,
    lastError: null,
  };
}

export function providerTransitionUpdate(
  transition: ProviderDeliveryTransition,
): Prisma.MessageOutboxUpdateManyMutationInput {
  const common: Prisma.MessageOutboxUpdateManyMutationInput = {
    providerDeliveryStatus: transition.status,
    providerStatusAt: transition.occurredAt,
    status: transition.outboxStatus,
    lastError: transition.lastError,
  };
  if (transition.status === "SENT") {
    return { ...common, sentAt: transition.occurredAt };
  }
  if (transition.status === "DELIVERED") {
    return { ...common, deliveredAt: transition.occurredAt };
  }
  if (
    transition.status === "BOUNCED"
    || transition.status === "FAILED"
    || transition.status === "SUPPRESSED"
  ) {
    return { ...common, failedAt: transition.occurredAt };
  }
  return common;
}
