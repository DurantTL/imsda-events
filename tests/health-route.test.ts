import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getOutboxQueueHealth: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/communications/outbox-sweep", () => ({
  getOutboxQueueHealth: dependencies.getOutboxQueueHealth,
}));

import { GET } from "@/app/api/health/route";

const healthyQueue = {
  status: "ok" as const,
  reasons: [] as string[],
  pending: 1,
  due: 0,
  processing: 0,
  failed: 0,
  oldestDueAgeMs: null,
  eventsWithDueMessages: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getPrisma.mockReturnValue({ $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) });
  dependencies.getOutboxQueueHealth.mockResolvedValue(healthyQueue);
});

describe("health endpoint", () => {
  it("reports ok when the database and the outbox are both healthy", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      services: { application: "ok", database: "ok", messageOutbox: "ok" },
    });
  });

  it("no longer reports healthy while email delivery is broken", async () => {
    dependencies.getOutboxQueueHealth.mockResolvedValue({
      ...healthyQueue,
      status: "degraded",
      due: 90,
      reasons: ["90 messages are due and undelivered"],
    });

    const response = await GET();
    const body = await response.json();

    // Still 200: a backed-up queue must not make the orchestrator restart a
    // container that is otherwise serving registrations.
    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.messageOutbox.reasons).toEqual(["90 messages are due and undelivered"]);
  });

  it("returns 503 only when the database is unreachable", async () => {
    dependencies.getPrisma.mockReturnValue({
      $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")),
    });

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      services: { database: "unavailable" },
    });
  });

  it("stays up and marks the outbox unknown when its own check fails", async () => {
    dependencies.getOutboxQueueHealth.mockRejectedValue(new Error("query failed"));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      services: { messageOutbox: "unknown" },
      messageOutbox: null,
    });
  });
});
