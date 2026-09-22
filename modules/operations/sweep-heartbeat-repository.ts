import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  OUTBOX_SWEEP_JOB,
  assessSweepHeartbeat,
} from "@/modules/operations/sweep-heartbeat";

export async function recordSweepHeartbeat(
  outcome: "SUCCEEDED" | "FAILED",
  now = new Date(),
) {
  const field = outcome === "SUCCEEDED" ? "lastSucceededAt" : "lastFailedAt";
  await getPrisma().systemJobHeartbeat.upsert({
    where: { job: OUTBOX_SWEEP_JOB },
    create: { job: OUTBOX_SWEEP_JOB, [field]: now },
    update: { [field]: now },
  });
}

export async function getSweepHeartbeat(now = new Date()) {
  const record = await getPrisma().systemJobHeartbeat.findUnique({
    where: { job: OUTBOX_SWEEP_JOB },
    select: { lastSucceededAt: true, lastFailedAt: true },
  });
  return assessSweepHeartbeat(record, now);
}
