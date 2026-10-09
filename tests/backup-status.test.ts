import { describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: prisma.getPrisma }));

import {
  BACKUP_STALE_AFTER_MS,
  assessBackupStatus,
  backupStatusDegradesHealth,
  toPublicBackupStatus,
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

const empty = {
  latest: null,
  latestSuccess: null,
  latestOffsiteSuccess: null,
  latestRehearsal: null,
  latestRehearsalSuccess: null,
  migrationFinishedAt: null,
};

describe("assessBackupStatus", () => {
  it("is ok for a recent, off-site, rehearsed backup", () => {
    const latest = run();
    const status = assessBackupStatus(
      {
        latest,
        latestSuccess: latest,
        latestOffsiteSuccess: latest,
        latestRehearsal: { finishedAt: hoursAgo(30), ok: true },
        latestRehearsalSuccess: { finishedAt: hoursAgo(30) },
        migrationFinishedAt: hoursAgo(24 * 30),
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

  it("is never, and does not degrade health, in the first 36 hours after the table exists", () => {
    const fresh = assessBackupStatus({ ...empty, migrationFinishedAt: hoursAgo(35) }, now);
    const unknownAge = assessBackupStatus(empty, now);

    expect(fresh).toMatchObject({ status: "never", stale: false, lastSuccessAt: null });
    expect(backupStatusDegradesHealth(fresh)).toBe(false);
    expect(unknownAge.status).toBe("never");
  });

  it("goes stale when nothing was ever recorded 36 hours after the table was created", () => {
    const status = assessBackupStatus({ ...empty, migrationFinishedAt: hoursAgo(37) }, now);

    expect(status).toMatchObject({ status: "stale", stale: true, needsAttention: true });
    expect(backupStatusDegradesHealth(status)).toBe(true);
  });

  it("needs attention when off-site copies stopped working 36 hours ago", () => {
    const latest = run({ hours: 3, offsiteOk: null });
    const status = assessBackupStatus(
      { ...empty, latest, latestSuccess: latest, latestOffsiteSuccess: { finishedAt: hoursAgo(40) } },
      now,
    );

    expect(status.needsAttention).toBe(true);
  });

  it("needs attention when the last successful rehearsal is older than 8 days", () => {
    const latest = run();
    const base = { ...empty, latest, latestSuccess: latest, latestOffsiteSuccess: latest };
    const recent = assessBackupStatus(
      { ...base, latestRehearsal: { finishedAt: hoursAgo(190), ok: true }, latestRehearsalSuccess: { finishedAt: hoursAgo(190) } },
      now,
    );
    const old = assessBackupStatus(
      { ...base, latestRehearsal: { finishedAt: hoursAgo(193), ok: true }, latestRehearsalSuccess: { finishedAt: hoursAgo(193) } },
      now,
    );
    const neverRehearsed = assessBackupStatus({ ...base, migrationFinishedAt: hoursAgo(24 * 9) }, now);
    const newDeploy = assessBackupStatus({ ...base, migrationFinishedAt: hoursAgo(24 * 3) }, now);

    expect(recent.needsAttention).toBe(false);
    expect(old.needsAttention).toBe(true);
    expect(neverRehearsed.needsAttention).toBe(true);
    expect(newDeploy.needsAttention).toBe(false);
  });

  it("shows only non-sensitive fields publicly", () => {
    const latest = run();
    const full = assessBackupStatus({ ...empty, latest, latestSuccess: latest, latestOffsiteSuccess: latest }, now);

    expect(Object.keys(toPublicBackupStatus(full)).sort()).toEqual(
      ["lastRehearsalAt", "lastSuccessAt", "needsAttention", "stale", "status"],
    );
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
    prisma.getPrisma.mockReturnValue({
      backupRun: { findFirst },
      $queryRaw: vi.fn().mockResolvedValue([{ finished_at: hoursAgo(24 * 20) }]),
    });

    const status = await getBackupStatus(now);

    expect(findFirst).toHaveBeenCalledTimes(5);
    expect(status.dumpBytes).toBe(123456789012);
    expect(status.assetsBytes).toBeNull();
    expect(status.status).toBe("ok");
  });

  it("treats an unreadable migration table as no anchor", async () => {
    prisma.getPrisma.mockReturnValue({
      backupRun: { findFirst: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockRejectedValue(new Error("no table")),
    });

    const status = await getBackupStatus(now);

    expect(status.status).toBe("never");
  });
});
