import { beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

const database = vi.hoisted(() => {
  const state = {
    providerEvents: new Map<string, Record<string, unknown>>(),
    outbox: {
      id: "message-1",
      providerMessageId: "email-provider-1",
      providerStatusAt: null as Date | null,
      providerDeliveryStatus: null as string | null,
      status: "SENT",
      deliveredAt: null as Date | null,
      lastError: null as string | null,
    },
  };
  const messageProviderEvent = {
    findUnique: vi.fn(async ({ where }: {
      where: { provider_providerEventId: { providerEventId: string } };
    }) => state.providerEvents.get(where.provider_providerEventId.providerEventId) ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      state.providerEvents.set(String(data.providerEventId), data);
      return data;
    }),
  };
  const messageOutbox = {
    findUnique: vi.fn(async ({ where }: { where: { providerMessageId: string } }) => (
      where.providerMessageId === state.outbox.providerMessageId
        ? { id: state.outbox.id }
        : null
    )),
    updateMany: vi.fn(async ({ where, data }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const transitionAt = data.providerStatusAt as Date;
      if (
        where.id !== state.outbox.id
        || (
          state.outbox.providerStatusAt
          && state.outbox.providerStatusAt > transitionAt
        )
      ) {
        return { count: 0 };
      }
      Object.assign(state.outbox, data);
      return { count: 1 };
    }),
  };
  const tx = { messageProviderEvent, messageOutbox };
  const prisma = {
    messageProviderEvent,
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  return { state, prisma };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => database.prisma,
}));

import {
  ResendWebhookVerificationError,
  verifyResendWebhook,
} from "@/integrations/email/resend-webhook";
import { mapResendDeliveryEvent } from "@/modules/communications/provider-events";
import { recordResendWebhookEvent } from "@/modules/communications/resend-webhook-repository";

const secret = `whsec_${Buffer.from("imsda-test-webhook-secret-32-bytes").toString("base64")}`;

function signedHeaders(rawBody: string, id = "webhook-1") {
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(id, timestamp, rawBody);
  return new Headers({
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": signature,
  });
}

function event(type = "email.delivered", createdAt = "2026-07-23T12:00:00.000Z") {
  return {
    type,
    created_at: createdAt,
    data: {
      email_id: "email-provider-1",
      to: ["attendee@example.test"],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  database.state.providerEvents.clear();
  Object.assign(database.state.outbox, {
    providerStatusAt: null,
    providerDeliveryStatus: null,
    status: "SENT",
    deliveredAt: null,
    lastError: null,
  });
});

describe("Resend webhook verification and persistence", () => {
  it("verifies the exact raw body and rejects a modified payload", () => {
    const rawBody = JSON.stringify(event());
    expect(verifyResendWebhook(rawBody, signedHeaders(rawBody), secret)).toEqual({
      providerEventId: "webhook-1",
      event: event(),
    });
    expect(() => verifyResendWebhook(
      `${rawBody} `,
      signedHeaders(rawBody),
      secret,
    )).toThrow(ResendWebhookVerificationError);
  });

  it("stores provider events idempotently and updates delivery truth once", async () => {
    const payload = event();
    const first = await recordResendWebhookEvent("webhook-delivered", payload);
    const duplicate = await recordResendWebhookEvent("webhook-delivered", payload);

    expect(first).toEqual({
      duplicate: false,
      matchedMessageId: "message-1",
      mappedStatus: "DELIVERED",
    });
    expect(duplicate).toEqual({
      duplicate: true,
      matchedMessageId: "message-1",
      mappedStatus: "DELIVERED",
    });
    expect(database.state.providerEvents.size).toBe(1);
    expect(database.state.outbox).toMatchObject({
      status: "SENT",
      providerDeliveryStatus: "DELIVERED",
      deliveredAt: new Date("2026-07-23T12:00:00.000Z"),
      lastError: null,
    });
  });

  it.each([
    ["email.sent", "SENT", "SENT"],
    ["email.delivered", "DELIVERED", "SENT"],
    ["email.bounced", "BOUNCED", "FAILED"],
    ["email.failed", "FAILED", "FAILED"],
    ["email.complained", "COMPLAINED", "SENT"],
    ["email.suppressed", "SUPPRESSED", "SUPPRESSED"],
  ])("maps %s to %s without conflating outbox status", (eventType, status, outboxStatus) => {
    expect(mapResendDeliveryEvent(
      eventType,
      new Date("2026-07-23T12:00:00.000Z"),
    )).toMatchObject({ status, outboxStatus });
  });
});
