import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { normalizeHonorText, offeringSlotConflict } from "@/modules/honors/domain";
import { HonorConfigurationError, getEventHonorSetup, serializable } from "@/modules/honors/repository";

/**
 * Copying one site's sessions and offerings into another site or next year's
 * event (#357). Staff always see a preview first; apply only runs the exact
 * preview they reviewed, and it never changes or replaces anything that
 * already exists in the target.
 */

type CopyClient = Prisma.TransactionClient;

export type HonorCopyPlan = {
  sourceEvent: { id: string; name: string };
  targetEvent: { id: string; name: string };
  sessions: Array<{ name: string; sortOrder: number; action: "CREATE" | "EXISTS" }>;
  offerings: Array<{
    sourceOfferingId: string;
    honorName: string;
    honorCode: string;
    sessionName: string | null;
    capacity: number;
    action: "CREATE" | "SKIP";
    reason: string | null;
  }>;
  createCount: number;
  skipCount: number;
  fingerprint: string;
};

async function loadEvent(client: CopyClient, eventId: string) {
  const event = await client.event.findUnique({ where: { id: eventId }, select: { id: true, name: true } });
  if (!event) throw new HonorConfigurationError("EVENT_NOT_FOUND", "That event could not be found.");
  return event;
}

async function buildPlan(client: CopyClient, sourceEventId: string, targetEventId: string) {
  if (sourceEventId === targetEventId) {
    throw new HonorConfigurationError("COPY_SAME_EVENT", "Choose a different site to copy from.");
  }
  const [sourceEvent, targetEvent] = await Promise.all([
    loadEvent(client, sourceEventId),
    loadEvent(client, targetEventId),
  ]);
  const [sourceSessions, targetSessions, sourceOfferings, targetOfferings] = await Promise.all([
    client.honorSession.findMany({
      where: { eventId: sourceEventId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, normalizedName: true, sortOrder: true },
    }),
    client.honorSession.findMany({
      where: { eventId: targetEventId },
      select: { id: true, normalizedName: true },
    }),
    client.honorOffering.findMany({
      where: { eventId: sourceEventId, isActive: true },
      orderBy: [{ honor: { name: "asc" } }, { id: "asc" }],
      select: {
        id: true,
        honorId: true,
        sessionId: true,
        span: true,
        capacity: true,
        minimumAge: true,
        perClubLimit: true,
        teacherName: true,
        location: true,
        updatedAt: true,
        honor: { select: { code: true, name: true, isActive: true } },
      },
    }),
    client.honorOffering.findMany({
      where: { eventId: targetEventId },
      select: { id: true, honorId: true, span: true, sessionId: true },
    }),
  ]);

  const targetSessionByName = new Map(targetSessions.map((session) => [session.normalizedName, session.id]));
  const sourceSessionById = new Map(sourceSessions.map((session) => [session.id, session]));

  const sessions = sourceSessions.map((session) => ({
    name: session.name,
    sortOrder: session.sortOrder,
    action: targetSessionByName.has(session.normalizedName) ? "EXISTS" as const : "CREATE" as const,
  }));

  // Sessions that don't exist yet get a placeholder key, so conflicts between
  // offerings being copied are still caught before anything is written.
  const plannedSlots = targetOfferings.map((offering) => ({
    honorId: offering.honorId,
    span: offering.span,
    sessionId: offering.sessionId,
  }));
  const offerings: HonorCopyPlan["offerings"] = [];
  const toCreate: Array<{
    offering: (typeof sourceOfferings)[number];
    sessionKey: string | null;
  }> = [];

  for (const offering of sourceOfferings) {
    const sourceSession = offering.sessionId ? sourceSessionById.get(offering.sessionId) : undefined;
    const sessionKey = sourceSession
      ? targetSessionByName.get(sourceSession.normalizedName) ?? `new:${sourceSession.normalizedName}`
      : null;
    const base = {
      sourceOfferingId: offering.id,
      honorName: offering.honor.name,
      honorCode: offering.honor.code,
      sessionName: sourceSession?.name ?? null,
      capacity: offering.capacity,
    };
    if (!offering.honor.isActive) {
      offerings.push({ ...base, action: "SKIP", reason: "The honor is inactive in the catalog." });
      continue;
    }
    const slot = { honorId: offering.honorId, span: offering.span, sessionId: sessionKey };
    const conflict = offeringSlotConflict(slot, plannedSlots);
    if (conflict) {
      offerings.push({ ...base, action: "SKIP", reason: `Already set up at the target. ${conflict}` });
      continue;
    }
    plannedSlots.push(slot);
    toCreate.push({ offering, sessionKey });
    offerings.push({ ...base, action: "CREATE", reason: null });
  }

  const fingerprint = createHash("sha256").update(JSON.stringify({
    sourceEventId,
    targetEventId,
    sessions,
    offerings: offerings.map((row) => [row.sourceOfferingId, row.action]),
    sourceVersions: sourceOfferings.map((offering) => [offering.id, offering.updatedAt.toISOString()]),
    targetOfferings: targetOfferings.map((offering) => offering.id).sort(),
    targetSessions: targetSessions.map((session) => session.id).sort(),
  })).digest("hex");

  const plan: HonorCopyPlan = {
    sourceEvent,
    targetEvent,
    sessions,
    offerings,
    createCount: toCreate.length,
    skipCount: offerings.length - toCreate.length,
    fingerprint,
  };
  return { plan, toCreate, sourceSessions, targetSessionByName };
}

export async function previewHonorCopy(targetEventId: string, sourceEventId: string) {
  return (await buildPlan(getPrisma(), sourceEventId, targetEventId)).plan;
}

export async function applyHonorCopy(
  targetEventId: string,
  sourceEventId: string,
  fingerprint: string,
  actorUserId: string,
) {
  const plan = await serializable(async (tx) => {
    const built = await buildPlan(tx, sourceEventId, targetEventId);
    if (built.plan.fingerprint !== fingerprint) {
      throw new HonorConfigurationError(
        "COPY_SOURCE_CHANGED",
        "One of the sites changed since you previewed this copy. Preview it again before copying.",
      );
    }

    const sessionIds = new Map(built.targetSessionByName);
    for (const session of built.sourceSessions) {
      if (sessionIds.has(session.normalizedName)) continue;
      const created = await tx.honorSession.create({
        data: {
          eventId: targetEventId,
          name: session.name,
          normalizedName: normalizeHonorText(session.name),
          sortOrder: session.sortOrder,
        },
        select: { id: true },
      });
      sessionIds.set(session.normalizedName, created.id);
    }

    for (const { offering, sessionKey } of built.toCreate) {
      const sessionId = sessionKey?.startsWith("new:")
        ? sessionIds.get(sessionKey.slice("new:".length)) ?? null
        : sessionKey;
      await tx.honorOffering.create({
        data: {
          eventId: targetEventId,
          honorId: offering.honorId,
          sessionId,
          span: offering.span,
          capacity: offering.capacity,
          minimumAge: offering.minimumAge,
          perClubLimit: offering.perClubLimit,
          teacherName: offering.teacherName,
          location: offering.location,
        },
      });
    }

    await writeAuditLog({
      eventId: targetEventId,
      actorUserId,
      action: "HONOR_OFFERINGS_COPIED",
      entityType: "Event",
      entityId: targetEventId,
      summary: `Copied ${built.plan.createCount} honor offerings from ${built.plan.sourceEvent.name}; skipped ${built.plan.skipCount}.`,
      metadata: {
        sourceEventId,
        createdSessions: built.plan.sessions.filter((session) => session.action === "CREATE").length,
        createdOfferings: built.plan.createCount,
        skippedOfferings: built.plan.skipCount,
        fingerprint,
      },
    }, tx);
    return built.plan;
  });
  return { plan, setup: await getEventHonorSetup(targetEventId) };
}
