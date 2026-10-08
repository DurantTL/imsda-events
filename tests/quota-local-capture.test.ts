import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { captureMessageIdsLocally } from "@/modules/communications/messaging-repository";

describe("local capture after a quota deferral (#860)", () => {
  it("numbers its attempt row after the quota rows, so the unique (message, attempt) key cannot collide", async () => {
    // A message the provider's quota deferred twice: two attempt rows recorded, none counted (attemptCount 0).
    const attempts: Array<{ attemptNumber: number; status: string }> = [
      { attemptNumber: 1, status: "FAILED" },
      { attemptNumber: 2, status: "FAILED" },
    ];
    const message = { id: "message-1", eventId: "event-1", status: "PENDING", templateKey: "CUSTOM_MESSAGE", attemptCount: 0, event: { messageSettings: { deliveryMode: "LOCAL_CAPTURE" } } };
    const tx = {
      messageOutbox: {
        findFirst: vi.fn(async () => message),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(message, data)),
      },
      messageDeliveryAttempt: {
        aggregate: vi.fn(async () => ({ _max: { attemptNumber: Math.max(...attempts.map((attempt) => attempt.attemptNumber)) } })),
        create: vi.fn(async ({ data }: { data: { attemptNumber: number; status: string } }) => {
          if (attempts.some((attempt) => attempt.attemptNumber === data.attemptNumber)) throw new Error("Unique constraint failed on (messageOutboxId, attemptNumber)");
          attempts.push(data);
          return data;
        }),
      },
    };
    mocks.getPrisma.mockReturnValue({ $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)) });

    const captured = await captureMessageIdsLocally(["message-1"]);

    expect(captured).toEqual(["message-1"]);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(attempts[2]).toMatchObject({ status: "CAPTURED" });
    expect(message).toMatchObject({ status: "CAPTURED", attemptCount: 1 });
  });
});
