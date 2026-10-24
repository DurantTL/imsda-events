import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { offeringHonorsSelect, summarizeOfferingHonors } from "@/modules/honors/offering-honors";
import {
  HONOR_WATCHES_MAX_PER_EVENT,
  checkWatchRecipients,
  honorWatchesPutSchema,
  type HonorWatchConfig,
} from "@/modules/honors/watch-domain";

/**
 * Reading and saving an event's honor watches (#1099). The route has already checked CONFIGURE_EVENT (event administrators, and
 * system administrators who pass every check); everything that decides what is stored is checked here, on the server.
 */

export class HonorWatchError extends Error {
  constructor(message: string, readonly code: "EVENT_NOT_FOUND" | "INVALID_WATCHES") {
    super(message);
    this.name = "HonorWatchError";
  }
}

export type HonorWatchClass = { id: string; label: string; session: string; isActive: boolean };

export type HonorWatchPanel = {
  watches: Array<HonorWatchConfig & {
    /** What a chosen class or honor no longer is, so staff can fix the watch instead of waiting for an email that cannot come. */
    warnings: string[];
  }>;
  classes: HonorWatchClass[];
};

type Row = { id: string; name: string; recipients: string[]; honorIds: string[]; offeringIds: string[] };

function toConfig(row: Row): HonorWatchConfig {
  return { id: row.id, name: row.name, recipients: row.recipients, honorIds: row.honorIds, offeringIds: row.offeringIds };
}

async function loadClasses(eventId: string): Promise<HonorWatchClass[]> {
  const offerings = await getPrisma().honorOffering.findMany({
    where: { eventId },
    select: { id: true, isActive: true, span: true, session: { select: { name: true, sortOrder: true } }, honors: offeringHonorsSelect },
  });
  return offerings
    .map((offering) => ({
      id: offering.id,
      label: summarizeOfferingHonors(offering.honors).honorName || "Class",
      session: offering.span === "ALL_SESSIONS" ? "All sessions" : offering.session?.name ?? "Session",
      isActive: offering.isActive,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.session.localeCompare(b.session) || a.id.localeCompare(b.id));
}

async function panelFor(eventId: string, rows: Row[]): Promise<HonorWatchPanel> {
  const classes = await loadClasses(eventId);
  const classIds = new Set(classes.map((entry) => entry.id));
  const honorIds = [...new Set(rows.flatMap((row) => row.honorIds))];
  const knownHonors = honorIds.length === 0
    ? new Set<string>()
    : new Set((await getPrisma().honor.findMany({ where: { id: { in: honorIds } }, select: { id: true } })).map((honor) => honor.id));
  return {
    classes,
    watches: rows.map((row) => {
      const warnings: string[] = [];
      const keptClasses = row.offeringIds.filter((id) => classIds.has(id));
      if (keptClasses.length < row.offeringIds.length) {
        warnings.push(keptClasses.length === 0 && row.honorIds.length === 0
          ? "The classes this watch looked at were deleted, so it watches nothing now. Choose an honor or class, or remove this watch, then save."
          : "A class this watch looked at was deleted. It has been taken off the list; save to confirm.");
      }
      if (row.honorIds.some((id) => !knownHonors.has(id))) warnings.push("An honor this watch looked at is no longer in the catalog. Remove it and save.");
      // A deleted class is dropped from what staff see and re-save, so it can never block saving the other watches.
      return { ...toConfig(row), offeringIds: keptClasses, warnings };
    }),
  };
}

export async function getHonorWatchPanel(eventId: string): Promise<HonorWatchPanel> {
  const rows = await getPrisma().honorWatch.findMany({ where: { eventId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  return panelFor(eventId, rows);
}

/**
 * Replaces the event's whole watch list. Rows keep their id when the request names it (so the summary point is remembered),
 * new ones are created, and rows left out are removed. A save never moves a watch's summary point: changes already owed to the
 * watch (since its last summary) are still sent, whatever it looks at after the save. A named id must be one of THIS event's
 * watches. Audited with ids and counts only: never an address or a name.
 */
export async function replaceHonorWatches(eventId: string, actorUserId: string, body: unknown, now = new Date()): Promise<HonorWatchPanel> {
  const parsed = honorWatchesPutSchema.safeParse(body);
  if (!parsed.success) throw new HonorWatchError(parsed.error.issues[0]?.message ?? "The watches could not be read.", "INVALID_WATCHES");
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) throw new HonorWatchError("That event could not be found.", "EVENT_NOT_FOUND");

  const namedIds = parsed.data.watches.flatMap((input) => (input.id ? [input.id] : []));
  if (new Set(namedIds).size !== namedIds.length) throw new HonorWatchError("A watch is listed twice. Reload the page and try again.", "INVALID_WATCHES");

  const wantedHonors = [...new Set(parsed.data.watches.flatMap((input) => input.honorIds))];
  const wantedClasses = [...new Set(parsed.data.watches.flatMap((input) => input.offeringIds))];
  const [realHonors, realClasses] = await Promise.all([
    wantedHonors.length === 0 ? [] : prisma.honor.findMany({ where: { id: { in: wantedHonors } }, select: { id: true } }),
    wantedClasses.length === 0 ? [] : prisma.honorOffering.findMany({ where: { id: { in: wantedClasses }, eventId }, select: { id: true } }),
  ]);
  const honorSet = new Set(realHonors.map((row) => row.id));
  const classSet = new Set(realClasses.map((row) => row.id));

  // The recipients each watch of this event has stored now: an old address left alone passes, a new one must be valid (#1193).
  const storedWatches = namedIds.length === 0 ? [] : await prisma.honorWatch.findMany({ where: { eventId, id: { in: namedIds } }, select: { id: true, recipients: true } });
  const checked = parsed.data.watches.map((input, index) => {
    const label = `Watch ${index + 1}`;
    const recipients = checkWatchRecipients(input.recipients, storedWatches.find((row) => row.id === input.id)?.recipients ?? []);
    if (!recipients.ok) throw new HonorWatchError(`${label}: ${recipients.message}`, "INVALID_WATCHES");
    const honorIds = [...new Set(input.honorIds)];
    const offeringIds = [...new Set(input.offeringIds)];
    if (honorIds.length + offeringIds.length === 0) throw new HonorWatchError(`${label}: choose at least one honor or class to watch.`, "INVALID_WATCHES");
    if (honorIds.some((id) => !honorSet.has(id))) throw new HonorWatchError(`${label}: choose honors from the catalog.`, "INVALID_WATCHES");
    if (offeringIds.some((id) => !classSet.has(id))) throw new HonorWatchError(`${label}: choose classes from this event.`, "INVALID_WATCHES");
    return { input, emails: recipients.emails, honorIds, offeringIds, index };
  });
  if (checked.length > HONOR_WATCHES_MAX_PER_EVENT) throw new HonorWatchError(`An event has at most ${HONOR_WATCHES_MAX_PER_EVENT} honor watches.`, "INVALID_WATCHES");

  const saved = await prisma.$transaction(async (tx) => {
    const keptIds = checked.flatMap((entry) => (entry.input.id ? [entry.input.id] : []));
    const removed = await tx.honorWatch.deleteMany({ where: { eventId, id: { notIn: keptIds } } });
    const ids: string[] = [];
    for (const entry of checked) {
      const data = { position: entry.index, name: entry.input.name, recipients: entry.emails, honorIds: entry.honorIds, offeringIds: entry.offeringIds };
      if (entry.input.id) {
        // Only the watch's own event, checked in the same statement as the write: a request cannot reach another event's row by
        // naming its id, and a watch removed since the page was loaded is a conflict. The summary point is deliberately not touched.
        const updated = await tx.honorWatch.updateMany({ where: { id: entry.input.id, eventId }, data });
        if (updated.count === 0) throw new HonorWatchError("A watch was changed or removed by someone else. Reload the page and try again.", "INVALID_WATCHES");
        ids.push(entry.input.id);
      } else {
        const created = await tx.honorWatch.create({ data: { ...data, eventId, createdAt: now }, select: { id: true } });
        ids.push(created.id);
      }
    }
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "HONOR_WATCHES_CHANGED",
      entityType: "Event",
      entityId: eventId,
      summary: "Changed the event's honor watches.",
      // Ids and counts only: never an address or a watch name.
      metadata: {
        watchIds: ids,
        watchCount: ids.length,
        removedCount: removed.count,
        recipientCount: checked.reduce((sum, entry) => sum + entry.emails.length, 0),
        honorCount: checked.reduce((sum, entry) => sum + entry.honorIds.length, 0),
        classCount: checked.reduce((sum, entry) => sum + entry.offeringIds.length, 0),
      },
    }, tx);
    return tx.honorWatch.findMany({ where: { eventId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2025" || error.code === "P2003")) {
      throw new HonorWatchError("A watch was changed or removed by someone else. Reload the page and try again.", "INVALID_WATCHES");
    }
    throw error;
  });
  return panelFor(eventId, saved);
}
