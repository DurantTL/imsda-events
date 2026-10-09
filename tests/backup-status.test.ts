import { describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: prisma.getPrisma }));

import {
  BACKUP_STALE_AFTER_MS,
  assessBackupStatus,
  backupStatusDegradesHealth,
  type BackupRunRecord,
} from "@/modules/operations/backup-status";
import { getBackupStatus } from "@/modules/operations/backup-status-repository";

const now = new Date("2026-10-12T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

function run(overrides: Partial<BackupRunRecord> & { hours?: number } = {}): BackupRunRecord {
  const finishedAt = hoursAgo(overrides.hours ?? 9);
  return {
    startedAt: new Date(finishedAt.getTime() - 240_000),
    finishedAt,
    ok: true,
    dumpBytes: 5000,
    assetsBytes: 700,
    offsiteOk: true,
    ...overrides,
  };
}

const empty = { latest: null, latestSuccess: null, latestOffsiteSuccess: null, latestRehearsal: null };

describe("assessBackupStatus", () => {
  it("is ok for a recent, off-site, rehearsed backup", () => {
    const latest = run();
    const status = assessBackupStatus(
      {
        latest,
        latestSuccess: latest,
        latestOffsiteSuccess: latest,
        latestRehearsal: { finishedAt: hoursAgo(30), ok: true },
      },
      now,
    );

    expect(status).toMatchObject({
      status: "ok",
      stale: false,
      lastSuccessAt: hoursAgo(9).toISOString(),
      offsiteOk: true,
      lastRehearsalOk: true,
      dumpBytes: 5000,
      assetsBytes: 700,
      needsAttention: false,
    });
    expect(backupStatusDegradesHealth(status)).toBe(false);
  });

  it("is stale only after 36 hours without a success", () => {
    const edge = run({ hours: 36 });
    const over = run({ hours: 36.01 });

    expect(assessBackupStatus({ ...empty, latest: edge, latestSuccess: edge }, now).stale).toBe(false);
    const status = assessBackupStatus({ ...empty, latest: over, latestSuccess: over }, now);
    expect(status).toMatchObject({ status: "stale", stale: true, needsAttention: true });
    expect(BACKUP_STALE_AFTER_MS).toBe(36 * 3_600_000);
  });

  it("is stale when recent runs fail but the last success is old", () => {
    const old = run({ hours: 50 });
    const failed = run({ hours: 2, ok: false, offsiteOk: null });

    const status = assessBackupStatus({ ...empty, latest: failed, latestSuccess: old }, now);

    expect(status).toMatchObject({ status: "stale", stale: true, lastRunOk: false });
  });

  it("is failing when the latest run failed but a success is recent", () => {
    const good = run({ hours: 20 });
    const failed = run({ hours: 1, ok: false });

    const status = assessBackupStatus({ ...empty, latest: failed, latestSuccess: good }, now);

    expect(status).toMatchObject({ status: "failing", stale: false, needsAttention: true });
  });

  it("is never, and does not degrade health, before the first report", () => {
    const status = assessBackupStatus(empty, now);

    expect(status).toMatchObject({ status: "never", stale: false, lastSuccessAt: null });
    expect(backupStatusDegradesHealth(status)).toBe(false);
  });

  it("needs attention when the off-site copy failed or the rehearsal failed", () => {
    const offsiteFailed = run({ offsiteOk: false });
    const a = assessBackupStatus({ ...empty, latest: offsiteFailed, latestSuccess: offsiteFailed }, now);
    expect(a).toMatchObject({ status: "ok", offsiteOk: false, needsAttention: true });

    const good = run();
    const b = assessBackupStatus(
      { ...empty, latest: good, latestSuccess: good, latestRehearsal: { finishedAt: hoursAgo(5), ok: false } },
      now,
    );
    expect(b).toMatchObject({ lastRehearsalOk: false, needsAttention: true });
  });

  it("treats a missing off-site configuration as unknown, not failed", () => {
    const noOffsite = run({ offsiteOk: null });

    const status = assessBackupStatus({ ...empty, latest: noOffsite, latestSuccess: noOffsite }, now);

    expect(status.offsiteOk).toBeNull();
    expect(status.needsAttention).toBe(false);
  });
});

describe("getBackupStatus", () => {
  it("converts bigint sizes and queries each signal", async () => {
    const row = {
      startedAt: hoursAgo(9.1),
      finishedAt: hoursAgo(9),
      ok: true,
      dumpBytes: BigInt("123456789012"),
      assetsBytes: null,
      offsiteOk: true,
    };
    const findFirst = vi.fn().mockResolvedValue(row);
    prisma.getPrisma.mockReturnValue({ backupRun: { findFirst } });

    const status = await getBackupStatus(now);

    expect(findFirst).toHaveBeenCalledTimes(4);
    expect(status.dumpBytes).toBe(123456789012);
    expect(status.assetsBytes).toBeNull();
    expect(status.status).toBe("ok");
  });
});
