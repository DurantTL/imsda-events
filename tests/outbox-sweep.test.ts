import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  processPendingMessages: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processPendingMessages: dependencies.processPendingMessages,
}));

import {
  assessOutboxQueue,
  getOutboxQueueSnapshot,
  isAuthorizedSweepRequest,
  OUTBOX_DEPTH_ALERT_THRESHOLD,
  sweepOutbox,
  type OutboxQueueSnapshot,
} from "@/modules/communications/outbox-sweep";

const sweepToken = "a-sweep-token-that-is-long-enough-for-production";

const healthySnapshot: OutboxQueueSnapshot = {
  pending: 2,
  due: 1,
  processing: 0,
  failed: 0,
  oldestDueAgeMs: 30_000,
  eventsWithDueMessages: 1,
};

function prismaFixture(options: {
  counts?: number[];
  oldestDue?: { availableAt: Date } | null;
  dueEvents?: Array<{ eventId: string }>;
} = {}) {
  const counts = options.counts ?? [2, 1, 0, 0];
  const count = vi.fn();
  for (const value of counts) count.mockResolvedValueOnce(value);
  const prisma = {
    messageOutbox: {
      count,
      findFirst: vi.fn().mockResolvedValue(options.oldestDue ?? null),
      groupBy: vi.fn().mockResolvedValue(options.dueEvents ?? []),
    },
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return prisma;
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({ OUTBOX_SWEEP_TOKEN: sweepToken });
  dependencies.processPendingMessages.mockResolvedValue({});
});

describe("outbox queue readiness", () => {
  it("reports ok for a queue that is draining", () => {
    expect(assessOutboxQueue(healthySnapshot)).toMatchObject({ status: "ok", reasons: [] });
  });

  it("reports degraded once the queue is backed up", () => {
    const assessment = assessOutboxQueue({
      ...healthySnapshot,
      due: OUTBOX_DEPTH_ALERT_THRESHOLD + 1,
    });

    expect(assessment.status).toBe("degraded");
    expect(assessment.reasons[0]).toContain("due and undelivered");
  });

  it("reports degraded when the oldest due message has waited too long", () => {
    const assessment = assessOutboxQueue({
      ...healthySnapshot,
      oldestDueAgeMs: 45 * 60 * 1000,
    });

    expect(assessment.status).toBe("degraded");
    expect(assessment.reasons[0]).toContain("45 minutes");
  });

  it("measures the age of the oldest due message", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    prismaFixture({
      counts: [7, 4, 1, 2],
      oldestDue: { availableAt: new Date("2026-07-24T11:40:00.000Z") },
      dueEvents: [{ eventId: "evt_a" }, { eventId: "evt_b" }],
    });

    expect(await getOutboxQueueSnapshot(now)).toEqual({
      pending: 7,
      due: 4,
      processing: 1,
      failed: 2,
      oldestDueAgeMs: 20 * 60 * 1000,
      eventsWithDueMessages: 2,
    });
  });

  it("reports no age when nothing is due", async () => {
    prismaFixture({ counts: [0, 0, 0, 0], oldestDue: null });

    expect((await getOutboxQueueSnapshot()).oldestDueAgeMs).toBeNull();
  });
});

describe("sweep authorisation", () => {
  function bearer(token: string | null) {
    return new Request("https://events.imsda.test/api/internal/outbox/sweep", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  it("accepts the configured token", () => {
    expect(isAuthorizedSweepRequest(bearer(sweepToken))).toBe(true);
  });

  it("rejects a wrong token, a missing header, and a non-bearer scheme", () => {
    expect(isAuthorizedSweepRequest(bearer("wrong-token-of-the-same-length!!"))).toBe(false);
    expect(isAuthorizedSweepRequest(bearer(null))).toBe(false);
    expect(isAuthorizedSweepRequest(new Request(
      "https://events.imsda.test/api/internal/outbox/sweep",
      { method: "POST", headers: { authorization: `Basic ${sweepToken}` } },
    ))).toBe(false);
  });

  it("is closed rather than open when no token is configured", () => {
    dependencies.getServerEnv.mockReturnValue({ OUTBOX_SWEEP_TOKEN: undefined });

    expect(isAuthorizedSweepRequest(bearer(sweepToken))).toBe(false);
    expect(isAuthorizedSweepRequest(bearer(""))).toBe(false);
  });
});

describe("sweeping the queue", () => {
  it("processes every event that has a due message", async () => {
    prismaFixture({ dueEvents: [{ eventId: "evt_a" }, { eventId: "evt_b" }] });

    const result = await sweepOutbox();

    expect(result.sweptEventIds).toEqual(["evt_a", "evt_b"]);
    expect(result.skipped).toEqual([]);
    expect(dependencies.processPendingMessages).toHaveBeenCalledTimes(2);
  });

  it("records no actor so unattended work is not attributed to a person", async () => {
    prismaFixture({ dueEvents: [{ eventId: "evt_a" }] });

    await sweepOutbox();

    expect(dependencies.processPendingMessages).toHaveBeenCalledWith("evt_a", undefined);
  });

  it("keeps going when one event's delivery is misconfigured", async () => {
    prismaFixture({ dueEvents: [{ eventId: "evt_a" }, { eventId: "evt_b" }] });
    dependencies.processPendingMessages.mockRejectedValueOnce(
      new Error("Message delivery is turned off for this event."),
    );

    const result = await sweepOutbox();

    expect(result.sweptEventIds).toEqual(["evt_b"]);
    expect(result.skipped).toEqual([
      { eventId: "evt_a", reason: "Message delivery is turned off for this event." },
    ]);
  });

  it("does nothing when the queue is empty", async () => {
    prismaFixture({ dueEvents: [] });

    expect((await sweepOutbox()).sweptEventIds).toEqual([]);
    expect(dependencies.processPendingMessages).not.toHaveBeenCalled();
  });
});
