import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  BACKUP_KIND,
  REHEARSAL_KIND,
  assessBackupStatus,
  type BackupRunRecord,
} from "@/modules/operations/backup-status";

type Row = {
  startedAt: Date;
  finishedAt: Date;
  ok: boolean;
  dumpBytes: bigint | null;
  assetsBytes: bigint | null;
  offsiteOk: boolean | null;
};

const select = {
  startedAt: true,
  finishedAt: true,
  ok: true,
  dumpBytes: true,
  assetsBytes: true,
  offsiteOk: true,
} as const;

function toRecord(row: Row | null): BackupRunRecord | null {
  if (!row) return null;
  return {
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    ok: row.ok,
    dumpBytes: row.dumpBytes === null ? null : Number(row.dumpBytes),
    assetsBytes: row.assetsBytes === null ? null : Number(row.assetsBytes),
    offsiteOk: row.offsiteOk,
  };
}

const newest = { finishedAt: "desc" } as const;

export async function getBackupStatus(now = new Date()) {
  const db = getPrisma().backupRun;
  const [latest, latestSuccess, latestOffsite, latestRehearsal] = await Promise.all([
    db.findFirst({ where: { kind: BACKUP_KIND }, orderBy: newest, select }),
    db.findFirst({ where: { kind: BACKUP_KIND, ok: true }, orderBy: newest, select }),
    db.findFirst({ where: { kind: BACKUP_KIND, offsiteOk: true }, orderBy: newest, select }),
    db.findFirst({ where: { kind: REHEARSAL_KIND }, orderBy: newest, select }),
  ]);
  return assessBackupStatus(
    {
      latest: toRecord(latest),
      latestSuccess: toRecord(latestSuccess),
      latestOffsiteSuccess: toRecord(latestOffsite),
      latestRehearsal: toRecord(latestRehearsal),
    },
    now,
  );
}
