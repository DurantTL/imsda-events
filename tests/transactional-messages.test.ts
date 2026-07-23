import { beforeEach, describe, expect, it, vi } from "vitest";
import { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";

vi.mock("server-only", () => ({}));

import {
  enqueueAttendeeSubstitutedMessage,
  enqueuePaymentReceiptMessage,
  enqueueRegistrationCancelledMessage,
  enqueueRegistrationContactUpdatedMessage,
  enqueueRegistrationTransferredNewContactMessage,
  enqueueRegistrationTransferredPriorContactMessage,
  enqueueWaitlistJoinedMessage,
  enqueueWaitlistPromotedMessage,
} from "@/modules/communications/transactional-messages";

type CapturedOutboxUpsert = {
  where: { idempotencyKey: string };
  update: Record<string, never>;
  create: {
    eventId: string;
    registrationId: string;
    templateVersionId: string | null;
    templateKey: string;
    recipientKind: string;
    recipientEmail: string;
    recipientName: string;
    subjectSnapshot: string;
    bodyTextSnapshot: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
    correlationId: string;
    status: string;
  };
};

function transactionFixture() {
  const upsert = vi.fn(async (args: CapturedOutboxUpsert) => ({
    id: `message-${args.create.templateKey.toLowerCase()}`,
    status: args.create.status,
  }));
  const tx = {
    eventMessageSettings: {
      findUnique: vi.fn().mockResolvedValue({
        deliveryMode: "LOCAL_CAPTURE",
        senderName: "IMSDA Events",
        senderEmail: "events@example.test",
        replyToEmail: "help@example.test",
      }),
    },
    eventMessageTemplate: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    registration: {
      findFirst: vi.fn().mockResolvedValue({
        id: "registration-1",
        confirmationCode: "REG-1234",
        totalAmount: { toString: () => "250.00" },
        contactSnapshot: {
          firstName: "Original",
          lastName: "Contact",
          email: "old-contact@example.test",
        },
        accountHolderPerson: {
          firstName: "Original",
          lastName: "Contact",
          normalizedEmail: "old-contact@example.test",
        },
        event: {
          name: "Women’s Retreat",
          startsAt: new Date("2026-10-09T21:00:00.000Z"),
          endsAt: new Date("2026-10-11T17:00:00.000Z"),
          timezone: "America/Chicago",
          location: "Camp Heritage",
          supportContact: "registration@example.test",
        },
        attendees: [{
          profileSnapshot: {
            firstName: "Retreat",
            lastName: "Guest",
          },
          person: {
            firstName: "Canonical",
            lastName: "Person",
          },
        }],
        payments: [{
          amount: { toString: () => "100.00" },
          refunds: [{
            amount: { toString: () => "25.00" },
          }],
        }],
        waitlistEntry: {
          position: 4,
        },
      }),
    },
    messageOutbox: { upsert },
  };
  return { tx, upsert };
}

function queuedMessage(upsert: ReturnType<typeof vi.fn>) {
  return upsert.mock.calls.at(-1)?.[0] as CapturedOutboxUpsert;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transactional lifecycle messages", () => {
  it("queues a waitlist confirmation with a position, no-payment warning, and private-link sentinel", async () => {
    const { tx, upsert } = transactionFixture();

    const result = await enqueueWaitlistJoinedMessage(tx as never, {
      eventId: "event-1",
      registrationId: "registration-1",
      correlationId: "correlation-waitlist",
      transitionKey: "waitlist-entry:1",
      waitlistPosition: 7,
    });

    const message = queuedMessage(upsert);
    expect(result.pendingMessageIds).toEqual(["message-waitlist_joined"]);
    expect(message.create).toMatchObject({
      templateKey: "WAITLIST_JOINED",
      recipientEmail: "old-contact@example.test",
      correlationId: "correlation-waitlist",
      status: "PENDING",
    });
    expect(message.create.bodyTextSnapshot).toContain("Waitlist position: 7");
    expect(message.create.bodyTextSnapshot).toContain("No payment is due");
    expect(message.create.bodyTextSnapshot).toContain(
      REGISTRATION_MANAGE_LINK_SENTINEL,
    );
  });

  it("queues promotion instructions with the current balance and a private manage link", async () => {
    const { tx, upsert } = transactionFixture();

    await enqueueWaitlistPromotedMessage(tx as never, {
      eventId: "event-1",
      registrationId: "registration-1",
      correlationId: "correlation-promoted",
      transitionKey: "waitlist-promotion:1",
    });

    const body = queuedMessage(upsert).create.bodyTextSnapshot;
    expect(body).toContain("Balance due: $175.00");
    expect(body).toContain("$175.00 remains due");
    expect(body).toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
  });

  it("preserves payment and refund facts in a cancellation without claiming an automatic refund", async () => {
    const { tx, upsert } = transactionFixture();

    await enqueueRegistrationCancelledMessage(tx as never, {
      eventId: "event-1",
      registrationId: "registration-1",
      correlationId: "correlation-cancelled",
      transitionKey: "registration-cancelled:1",
    });

    const body = queuedMessage(upsert).create.bodyTextSnapshot;
    expect(body).toContain("$100.00 in successful payments");
    expect(body).toContain("$25.00 in successful refunds");
    expect(body).toContain("did not automatically refund the remaining $75.00");
    expect(body).toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
  });

  it("sends a contact-change confirmation only to the new destination without leaking the old address", async () => {
    const { tx, upsert } = transactionFixture();

    await enqueueRegistrationContactUpdatedMessage(tx as never, {
      eventId: "event-1",
      registrationId: "registration-1",
      correlationId: "correlation-contact",
      transitionKey: "contact-updated:1",
      recipientEmail: "NEW-CONTACT@example.test",
      recipientName: "New Contact",
      metadata: {
        source: "PRIVATE_MANAGE_LINK",
        destinationUpdated: true,
      },
    });

    const message = queuedMessage(upsert);
    expect(message.create.recipientEmail).toBe("new-contact@example.test");
    expect(message.create.recipientName).toBe("New Contact");
    expect(message.create.bodyTextSnapshot).toContain(
      "Future registration messages will be sent to new-contact@example.test.",
    );
    expect(JSON.stringify(message.create)).not.toContain(
      "old-contact@example.test",
    );
  });

  it("creates one immutable, idempotent payment-receipt snapshot for a Square success transition", async () => {
    const { tx, upsert } = transactionFixture();
    const input = {
      eventId: "event-1",
      registrationId: "registration-1",
      paymentId: "payment-1",
      paymentAttemptId: "attempt-1",
      amountCents: 5_025,
      providerPaymentId: "square-payment-1",
      correlationId: "correlation-payment",
    };

    await enqueuePaymentReceiptMessage(tx as never, input);
    await enqueuePaymentReceiptMessage(tx as never, input);

    const first = upsert.mock.calls[0]![0] as CapturedOutboxUpsert;
    const retry = upsert.mock.calls[1]![0] as CapturedOutboxUpsert;
    expect(first.where.idempotencyKey).toBe(retry.where.idempotencyKey);
    expect(first.update).toEqual({});
    expect(first.create.idempotencyKey).toBe(first.where.idempotencyKey);
    expect(first.create.bodyTextSnapshot).toContain(
      "Payment received: $50.25",
    );
    expect(first.create.bodyTextSnapshot).toContain(
      "Payment reference: square-payment-1",
    );
    expect(first.create.bodyTextSnapshot).toContain(
      REGISTRATION_MANAGE_LINK_SENTINEL,
    );
    expect(first.create.metadata).toMatchObject({
      paymentId: "payment-1",
      paymentAttemptId: "attempt-1",
      provider: "SQUARE",
    });
  });

  it("queues distinct transfer snapshots and exposes private access only to the new contact", async () => {
    const { tx, upsert } = transactionFixture();
    const shared = {
      eventId: "event-1",
      registrationId: "registration-1",
      correlationId: "transfer-request-1",
      priorPersonName: "Original Contact",
      newPersonName: "New Contact",
    };

    await enqueueRegistrationTransferredNewContactMessage(tx as never, {
      ...shared,
      transitionKey: "transfer:new",
      recipientEmail: "new@example.test",
      recipientName: "New Contact",
    });
    await enqueueRegistrationTransferredPriorContactMessage(tx as never, {
      ...shared,
      transitionKey: "transfer:prior",
      recipientEmail: "old-contact@example.test",
      recipientName: "Original Contact",
    });

    const next = upsert.mock.calls[0]![0] as CapturedOutboxUpsert;
    const prior = upsert.mock.calls[1]![0] as CapturedOutboxUpsert;
    expect(next.create.templateKey).toBe("REGISTRATION_TRANSFERRED_NEW_CONTACT");
    expect(next.create.bodyTextSnapshot).toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
    expect(next.create.bodyTextSnapshot).toContain("did not change");
    expect(prior.create.templateKey).toBe("REGISTRATION_TRANSFERRED_PRIOR_CONTACT");
    expect(prior.create.bodyTextSnapshot).not.toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
    expect(prior.create.bodyTextSnapshot).toContain("New Contact");
  });

  it("renders one substitution template for each deduplicated role destination", async () => {
    const { tx, upsert } = transactionFixture();

    await enqueueAttendeeSubstitutedMessage(tx as never, {
      eventId: "event-1",
      registrationId: "registration-1",
      correlationId: "substitution-request-1",
      transitionKey: "substitution:replacement",
      recipientEmail: "replacement@example.test",
      recipientName: "Replacement Guest",
      priorPersonName: "Retreat Guest",
      newPersonName: "Replacement Guest",
      metadata: { recipientRoles: "REPLACEMENT_ATTENDEE" },
    });

    const message = queuedMessage(upsert);
    expect(message.create.templateKey).toBe("ATTENDEE_SUBSTITUTED");
    expect(message.create.recipientEmail).toBe("replacement@example.test");
    expect(message.create.bodyTextSnapshot).toContain(
      "Retreat Guest was replaced by Replacement Guest",
    );
    expect(message.create.bodyTextSnapshot).not.toContain(
      REGISTRATION_MANAGE_LINK_SENTINEL,
    );
  });
});
