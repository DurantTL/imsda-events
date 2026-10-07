import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { normalizeHonorText, offeringSlotConflict } from "@/modules/honors/domain";
import { offeringSiteId } from "@/modules/honors/locations";
import { requireNoTeams, HonorConfigurationError, getEventHonorSetup, serializable } from "@/modules/honors/repository";

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
  sessions: Array<{
    name: string;
    sortOrder: number;
    action: "CREATE" | "EXISTS";
    /** The site the session lands at in the target, or null when it gets none (#589). */
    siteName: string | null;
    /** Set when the source session has a site the target event has no site of the same name for. */
    siteWarning: string | null;
  }>;
  /** Plain-language warnings to show above the preview. */
  warnings: string[];
  offerings: Array<{
    sourceOfferingId: string;
    honorName: string;
    honorCode: string;
    sessionName: string | null;
    /** The site an all-sessions class lands at (#589); null for a single-session class or none. */
    siteName: string | null;
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
  await requireNoTeams(client, targetEventId);
  const [sourceSessions, targetSessions, sourceOfferings, targetOfferings, targetLocations] = await Promise.all([
    client.honorSession.findMany({
      where: { eventId: sourceEventId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
      select: { id: true, name: true, normalizedName: true, sortOrder: true, location: { select: { name: true, normalizedName: true } } },
    }),
    client.honorSession.findMany({
      where: { eventId: targetEventId },
      select: { id: true, normalizedName: true, locationId: true },
    }),
    client.honorOffering.findMany({
      where: { eventId: sourceEventId, isActive: true },
      orderBy: [{ honor: { name: "asc" } }, { id: "asc" }],
      select: {
        id: true,
        honorId: true,
        sessionId: true,
        locationId: true,
        site: { select: { name: true, normalizedName: true } },
        span: true,
        capacity: true,
        minimumAge: true,
        perClubLimit: true,
        teacherName: true,
        location: true,
        additionalCostCents: true,
        requirementNote: true,
        updatedAt: true,
        honor: { select: { code: true, name: true, isActive: true } },
      },
    }),
    client.honorOffering.findMany({
      where: { eventId: targetEventId },
      select: { id: true, honorId: true, span: true, sessionId: true, locationId: true, session: { select: { locationId: true } } },
    }),
    client.eventLocation.findMany({ where: { eventId: targetEventId }, select: { id: true, name: true, normalizedName: true } }),
  ]);

  // Sessions are matched by site name, then session name (#589): "Sabbath
  // Morning" at Des Moines lands at the target's Des Moines. A source site with
  // no same-named target site leaves the session with no site, with a warning,
  // and the session is named "<Session> (<site>)" so sessions from different
  // sites are never merged into one.
  const targetLocationByName = new Map(targetLocations.map((location) => [location.normalizedName, location]));
  const sessionKey = (locationId: string | null, normalizedName: string) => `${locationId ?? ""}|${normalizedName}`;
  const targetSessionByKey = new Map(targetSessions.map((session) => [sessionKey(session.locationId, session.normalizedName), session.id]));
  const sourceSessionById = new Map(sourceSessions.map((session) => [session.id, session]));
  const placements = new Map(sourceSessions.map((session) => {
    const match = session.location ? targetLocationByName.get(session.location.normalizedName) ?? null : null;
    const renamed = session.location && !match ? `${session.name} (${session.location.name})`.slice(0, 80) : session.name;
    const normalizedName = renamed === session.name ? session.normalizedName : normalizeHonorText(renamed);
    return [session.id, {
      locationId: match?.id ?? null,
      siteName: match?.name ?? null,
      name: renamed,
      normalizedName,
      key: sessionKey(match?.id ?? null, normalizedName),
      warning: session.location && !match
        ? `${session.name}: ${targetEvent.name} has no site named "${session.location.name}", so this session gets no site and is named "${renamed}".`
        : null,
    }];
  }));

  // New rows are renumbered 0..n in the source's display order: they are all
  // created in one transaction (same createdAt), so a copied tie would fall
  // back to alphabetical (#570).
  const sessions = sourceSessions.map((session, position) => {
    const placement = placements.get(session.id)!;
    return {
      name: placement.name,
      sortOrder: position,
      action: targetSessionByKey.has(placement.key) ? "EXISTS" as const : "CREATE" as const,
      siteName: placement.siteName,
      siteWarning: placement.warning,
    };
  });
  const warnings = sessions.flatMap((session) => (session.siteWarning ? [session.siteWarning] : []));
  const targetLocationIds = new Set(targetLocations.map((location) => location.id));

  // Sessions that don't exist yet get a placeholder key, so conflicts between
  // offerings being copied are still caught before anything is written.
  const plannedSlots = targetOfferings.map((offering) => ({
    honorId: offering.honorId,
    span: offering.span,
    sessionId: offering.sessionId,
    locationId: offeringSiteId(offering),
  }));
  const offerings: HonorCopyPlan["offerings"] = [];
  const toCreate: Array<{
    offering: (typeof sourceOfferings)[number];
    sessionKey: string | null;
    /** The all-sessions class's site in the target (#589). */
    locationId: string | null;
  }> = [];

  for (const offering of sourceOfferings) {
    const sourceSession = offering.sessionId ? sourceSessionById.get(offering.sessionId) : undefined;
    const sessionRef = sourceSession
      ? targetSessionByKey.get(placements.get(sourceSession.id)!.key) ?? `new:${placements.get(sourceSession.id)!.key}`
      : null;
    const base = {
      sourceOfferingId: offering.id,
      honorName: offering.honor.name,
      honorCode: offering.honor.code,
      sessionName: sourceSession?.name ?? null,
      siteName: null as string | null,
      capacity: offering.capacity,
    };
    // An all-sessions class follows its site by name, like a session; no match leaves it with no site (#589).
    const siteMatch = offering.span === "ALL_SESSIONS" && offering.site ? targetLocationByName.get(offering.site.normalizedName) ?? null : null;
    const siteLost = offering.span === "ALL_SESSIONS" && Boolean(offering.site) && !siteMatch;
    const classSite = siteMatch && targetLocationIds.has(siteMatch.id) ? siteMatch.id : null;
    base.siteName = siteMatch?.name ?? null;
    if (siteLost) {
      warnings.push(`${offering.honor.name} (all sessions): ${targetEvent.name} has no site named "${offering.site!.name}", so this class gets no site.`);
    }
    if (!offering.honor.isActive) {
      offerings.push({ ...base, action: "SKIP", reason: "The honor is inactive in the catalog." });
      continue;
    }
    const slot = {
      honorId: offering.honorId,
      span: offering.span,
      sessionId: sessionRef,
      locationId: offering.span === "ALL_SESSIONS" ? classSite : sourceSession ? placements.get(sourceSession.id)!.locationId : null,
    };
    const conflict = offeringSlotConflict(slot, plannedSlots);
    if (conflict) {
      // Two sites' classes for one honor that both lost their site are the same slot: say so, rather than "already set up".
      const merged = siteLost || (sourceSession?.location && !placements.get(sourceSession.id)!.locationId);
      offerings.push({
        ...base,
        action: "SKIP",
        reason: merged
          ? "This class's site has no match at the target, so it would sit beside another class for the same honor with no site. Add the site to the target and copy again."
          : `Already set up at the target. ${conflict}`,
      });
      continue;
    }
    plannedSlots.push(slot);
    toCreate.push({ offering, sessionKey: sessionRef, locationId: classSite });
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
    targetLocations: targetLocations.map((location) => location.id).sort(),
  })).digest("hex");

  const plan: HonorCopyPlan = {
    sourceEvent,
    targetEvent,
    sessions,
    warnings,
    offerings,
    createCount: toCreate.length,
    skipCount: offerings.length - toCreate.length,
    fingerprint,
  };
  return { plan, toCreate, sourceSessions, targetSessionByKey, placements };
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

    const sessionIds = new Map(built.targetSessionByKey);
    for (const [position, session] of built.sourceSessions.entries()) {
      const placement = built.placements.get(session.id)!;
      if (sessionIds.has(placement.key)) continue;
      const created = await tx.honorSession.create({
        data: {
          eventId: targetEventId,
          locationId: placement.locationId,
          name: placement.name,
          normalizedName: placement.normalizedName,
          sortOrder: position,
        },
        select: { id: true },
      });
      sessionIds.set(placement.key, created.id);
    }

    for (const { offering, sessionKey, locationId } of built.toCreate) {
      const sessionId = sessionKey?.startsWith("new:")
        ? sessionIds.get(sessionKey.slice("new:".length)) ?? null
        : sessionKey;
      await tx.honorOffering.create({
        data: {
          eventId: targetEventId,
          honorId: offering.honorId,
          sessionId,
          locationId,
          span: offering.span,
          capacity: offering.capacity,
          minimumAge: offering.minimumAge,
          perClubLimit: offering.perClubLimit,
          teacherName: offering.teacherName,
          location: offering.location,
          additionalCostCents: offering.additionalCostCents,
          requirementNote: offering.requirementNote,
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
        sessionsWithoutSite: built.plan.warnings.length,
        createdOfferings: built.plan.createCount,
        skippedOfferings: built.plan.skipCount,
        fingerprint,
      },
    }, tx);
    return built.plan;
  });
  return { plan, setup: await getEventHonorSetup(targetEventId) };
}
