import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getOutboxQueueHealth: vi.fn(),
  getReleaseIdentity: vi.fn(),
  getSweepHeartbeat: vi.fn(),
  getBackupStatus: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/communications/outbox-sweep", () => ({
  getOutboxQueueHealth: dependencies.getOutboxQueueHealth,
}));
vi.mock("@/lib/release", () => ({
  getReleaseIdentity: dependencies.getReleaseIdentity,
}));
vi.mock("@/modules/operations/sweep-heartbeat-repository", () => ({
  getSweepHeartbeat: dependencies.getSweepHeartbeat,
}));
vi.mock("@/modules/operations/backup-status-repository", () => ({
  getBackupStatus: dependencies.getBackupStatus,
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

const recentSweep = {
  status: "ok" as const,
  lastSucceededAt: "2026-10-09T12:00:00.000Z",
  lastFailedAt: null,
  ageMs: 60_000,
};

const healthyBackups = {
  status: "ok" as const,
  stale: false,
  lastSuccessAt: "2026-10-09T03:00:00.000Z",
  lastRunAt: "2026-10-09T03:00:00.000Z",
  lastRunOk: true,
  dumpBytes: 5000,
  assetsBytes: 700,
  offsiteOk: true,
  lastOffsiteSuccessAt: "2026-10-09T03:00:00.000Z",
  lastRehearsalAt: "2026-10-05T03:10:00.000Z",
  lastRehearsalOk: true,
  needsAttention: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getPrisma.mockReturnValue({ $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) });
  dependencies.getOutboxQueueHealth.mockResolvedValue(healthyQueue);
  dependencies.getSweepHeartbeat.mockResolvedValue(recentSweep);
  dependencies.getBackupStatus.mockResolvedValue(healthyBackups);
  dependencies.getReleaseIdentity.mockReturnValue({
    sha: "d27839dcabf253111bf4a014cb526db3b1c57469",
    buildId: "next-build-id",
  });
});

/** The wrapper needs a request: Next always supplies one. */
function healthRequest() {
  return new Request("https://events.imsda.test/api/health");
}

describe("health endpoint", () => {
  it("reports ok when the database and the outbox are both healthy", async () => {
    const response = await GET(healthRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      release: {
        sha: "d27839dcabf253111bf4a014cb526db3b1c57469",
        buildId: "next-build-id",
      },
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

    const response = await GET(healthRequest());
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

    const response = await GET(healthRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      services: { database: "unavailable" },
    });
  });

  it("stays up and marks the outbox unknown when its own check fails", async () => {
    dependencies.getOutboxQueueHealth.mockRejectedValue(new Error("query failed"));

    const response = await GET(healthRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      services: { messageOutbox: "unknown" },
      messageOutbox: null,
    });
  });

  it("reports degraded when the scheduled sweep has gone quiet", async () => {
    dependencies.getSweepHeartbeat.mockResolvedValue({
      ...recentSweep,
      status: "stale",
      ageMs: 40 * 60_000,
    });

    const response = await GET(healthRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      services: { outboxSweep: "stale" },
      outboxSweep: { ageMs: 40 * 60_000 },
    });
  });

  it("does not degrade before the first sweep has reported", async () => {
    dependencies.getSweepHeartbeat.mockResolvedValue({
      status: "never",
      lastSucceededAt: null,
      lastFailedAt: null,
      ageMs: null,
    });

    const response = await GET(healthRequest());

    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      services: { outboxSweep: "never" },
    });
  });

  it("marks the sweep unknown when its heartbeat cannot be read", async () => {
    dependencies.getSweepHeartbeat.mockRejectedValue(new Error("query failed"));

    const response = await GET(healthRequest());

    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      services: { outboxSweep: "unknown" },
      outboxSweep: null,
    });
  });

  it("shows the backup block without secrets and stays ok", async () => {
    const response = await GET(healthRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.services.backups).toBe("ok");
    expect(body.backups).toEqual(healthyBackups);
  });

  it("reports degraded, not 503, when the last backup is stale", async () => {
    dependencies.getBackupStatus.mockResolvedValue({
      ...healthyBackups,
      status: "stale",
      stale: true,
      needsAttention: true,
    });

    const response = await GET(healthRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      services: { backups: "stale" },
      backups: { stale: true },
    });
  });

  it("reports degraded when the off-site copy failed", async () => {
    dependencies.getBackupStatus.mockResolvedValue({
      ...healthyBackups,
      offsiteOk: false,
      needsAttention: true,
    });

    const response = await GET(healthRequest());

    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      backups: { offsiteOk: false },
    });
  });

  it("does not degrade before the first backup has reported", async () => {
    dependencies.getBackupStatus.mockResolvedValue({
      ...healthyBackups,
      status: "never",
      lastSuccessAt: null,
      lastRunAt: null,
      lastRunOk: null,
      offsiteOk: null,
      lastRehearsalAt: null,
      lastRehearsalOk: null,
    });

    const response = await GET(healthRequest());

    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      services: { backups: "never" },
    });
  });

  it("marks backups unknown when their status cannot be read", async () => {
    dependencies.getBackupStatus.mockRejectedValue(new Error("query failed"));

    const response = await GET(healthRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      services: { backups: "unknown" },
      backups: null,
    });
  });
});
