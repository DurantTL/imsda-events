import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getServerEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { processPendingMessages } from "@/modules/communications/messaging-repository";

/**
 * A message that fails its first attempt is rescheduled with backoff, and a
 * message stranded by a container restart mid-delivery keeps a stale lock. Both
 * were only ever picked up by a button in the staff Communications page, so
 * nothing recovered them unless a person happened to look. This sweep is the
 * scheduled caller that closes that gap.
 */

/** Depth beyond which the queue is reported degraded. */
export const OUTBOX_DEPTH_ALERT_THRESHOLD = 25;
/** Age of the oldest due message beyond which the queue is reported degraded. */
export const OUTBOX_OLDEST_PENDING_ALERT_MS = 30 * 60 * 1000;

export type OutboxQueueSnapshot = {
  pending: number;
  due: number;
  processing: number;
  failed: number;
  oldestDueAgeMs: number | null;
  eventsWithDueMessages: number;
};

export type OutboxQueueHealth = OutboxQueueSnapshot & {
  status: "ok" | "degraded";
  reasons: string[];
};

export type OutboxSweepResult = {
  sweptEventIds: string[];
  skipped: Array<{ eventId: string; reason: string }>;
  snapshotBefore: OutboxQueueSnapshot;
};

/**
 * Pure: turns a snapshot into a readiness verdict. `/api/health` reported
 * healthy while email delivery was completely broken because it only checked
 * the app and `SELECT 1`.
 */
export function assessOutboxQueue(snapshot: OutboxQueueSnapshot): OutboxQueueHealth {
  const reasons: string[] = [];
  if (snapshot.due > OUTBOX_DEPTH_ALERT_THRESHOLD) {
    reasons.push(`${snapshot.due} messages are due and undelivered`);
  }
  if (
    snapshot.oldestDueAgeMs !== null
    && snapshot.oldestDueAgeMs > OUTBOX_OLDEST_PENDING_ALERT_MS
  ) {
    reasons.push(
      `the oldest due message has waited ${Math.round(snapshot.oldestDueAgeMs / 60000)} minutes`,
    );
  }
  return { ...snapshot, status: reasons.length === 0 ? "ok" : "degraded", reasons };
}

export async function getOutboxQueueSnapshot(now = new Date()): Promise<OutboxQueueSnapshot> {
  const prisma = getPrisma();
  const dueWhere = { status: "PENDING" as const, availableAt: { lte: now } };

  const [pending, due, processing, failed, oldestDue, dueEvents] = await Promise.all([
    prisma.messageOutbox.count({ where: { status: "PENDING" } }),
    prisma.messageOutbox.count({ where: dueWhere }),
    prisma.messageOutbox.count({ where: { status: "PROCESSING" } }),
    prisma.messageOutbox.count({ where: { status: "FAILED" } }),
    prisma.messageOutbox.findFirst({
      where: dueWhere,
      orderBy: { availableAt: "asc" },
      select: { availableAt: true },
    }),
    prisma.messageOutbox.groupBy({ by: ["eventId"], where: dueWhere }),
  ]);

  return {
    pending,
    due,
    processing,
    failed,
    oldestDueAgeMs: oldestDue
      ? Math.max(0, now.getTime() - oldestDue.availableAt.getTime())
      : null,
    eventsWithDueMessages: dueEvents.length,
  };
}

export async function getOutboxQueueHealth(now = new Date()): Promise<OutboxQueueHealth> {
  return assessOutboxQueue(await getOutboxQueueSnapshot(now));
}

/**
 * Compares the presented credential in constant time. Returns false when no
 * token is configured, so the endpoint is never open by omission.
 */
export function isAuthorizedSweepRequest(request: Request): boolean {
  const configured = getServerEnv().OUTBOX_SWEEP_TOKEN;
  if (!configured) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return false;

  const expectedBytes = Buffer.from(configured, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  if (expectedBytes.length !== presentedBytes.length) {
    // Still spend the comparison so length is not leaked by timing.
    timingSafeEqual(expectedBytes, expectedBytes);
    return false;
  }
  return timingSafeEqual(expectedBytes, presentedBytes);
}

/**
 * Runs the existing per-event processor for every event holding due messages.
 * One event's misconfiguration must not stop the others, so a failure is
 * recorded and the sweep continues.
 */
export async function sweepOutbox(
  options: { actorUserId?: string; now?: Date } = {},
): Promise<OutboxSweepResult> {
  const now = options.now ?? new Date();
  const snapshotBefore = await getOutboxQueueSnapshot(now);

  const dueEvents = await getPrisma().messageOutbox.groupBy({
    by: ["eventId"],
    where: { status: "PENDING", availableAt: { lte: now } },
  });

  const sweptEventIds: string[] = [];
  const skipped: Array<{ eventId: string; reason: string }> = [];

  for (const { eventId } of dueEvents) {
    try {
      await processPendingMessages(eventId, options.actorUserId);
      sweptEventIds.push(eventId);
    } catch (error) {
      skipped.push({
        eventId,
        reason: error instanceof Error ? error.message : "The queue could not be processed.",
      });
    }
  }

  return { sweptEventIds, skipped, snapshotBefore };
}
