import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { EarnedAwardError } from "@/modules/earned-awards/errors";

/**
 * Event patches (#532): staff link a catalog item to a club event, and the
 * awards screen then suggests it for every member who attended. Linking only
 * records the link; it orders nothing. Needs `CONFIGURE_EVENT` on that event
 * (the route checks), and every change is audited against the event.
 *
 * Camporee patches are conference-made, so their catalog items may have no
 * AdventSource number. They link like any other item; the order screen flags
 * a missing number the same way it does for honors (#487).
 */

/** The catalog sections an event's patch or pin can come from. */
export const EVENT_PATCH_SECTIONS = ["CAMPOREES", "PATHFINDER_BIBLE_EXPERIENCE", "TEEN_LEADERSHIP_TRAINING", "MISCELLANEOUS"] as const;

export type EventAwardItemRow = {
  itemId: string;
  name: string;
  section: string;
  catalogNumber: string | null;
};

const itemSelect = { id: true, name: true, section: true, catalogNumber: true } satisfies Prisma.ClubSupplyItemSelect;

function toRow(item: { id: string; name: string; section: string; catalogNumber: string | null }): EventAwardItemRow {
  return { itemId: item.id, name: item.name, section: item.section, catalogNumber: item.catalogNumber };
}

/** The items linked to one event, and the catalog items staff may link. */
export async function listEventAwardItems(eventId: string) {
  const [event, linked, choices] = await Promise.all([
    getPrisma().event.findUnique({ where: { id: eventId }, select: { audience: true } }),
    getPrisma().eventAwardItem.findMany({
      where: { eventId },
      select: { item: { select: itemSelect } },
    }),
    getPrisma().clubSupplyItem.findMany({
      where: { isActive: true, section: { in: [...EVENT_PATCH_SECTIONS] } },
      orderBy: [{ section: "asc" }, { name: "asc" }],
      select: itemSelect,
    }),
  ]);
  return {
    isClubEvent: event?.audience === "CLUB",
    linked: linked.map((row) => toRow(row.item)).sort((a, b) => a.name.localeCompare(b.name)),
    choices: choices.map(toRow),
  };
}

/** Links a catalog item to a club event (#532). Linking it again changes nothing and writes no audit row. */
export async function linkEventAwardItem(eventId: string, itemId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { audience: true } });
    if (!event) throw new EarnedAwardError("EVENT_NOT_FOUND", "That event could not be found.");
    if (event.audience !== "CLUB") throw new EarnedAwardError("NOT_A_CLUB_EVENT", "Patches can only be linked to a club event.");
    const item = await tx.clubSupplyItem.findFirst({
      where: { id: itemId, isActive: true, section: { in: [...EVENT_PATCH_SECTIONS] } },
      select: { id: true },
    });
    if (!item) throw new EarnedAwardError("ITEM_NOT_ALLOWED", "Choose an active camporee, PBE, TLT, or miscellaneous item from the supply catalog.");
    const created = await tx.eventAwardItem.createMany({ data: [{ eventId, itemId }], skipDuplicates: true });
    if (created.count === 0) return;
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "EVENT_AWARD_ITEM_LINKED",
      entityType: "EventAwardItem",
      summary: "Linked a catalog item to this club event as its patch or pin.",
      metadata: { eventId, itemId },
    }, tx);
  });
  return listEventAwardItems(eventId);
}

/** Unlinks a catalog item from an event (#532). Needs already added stay: they are the club's. */
export async function unlinkEventAwardItem(eventId: string, itemId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const removed = await tx.eventAwardItem.deleteMany({ where: { eventId, itemId } });
    if (removed.count === 0) return;
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "EVENT_AWARD_ITEM_UNLINKED",
      entityType: "EventAwardItem",
      summary: "Unlinked a catalog item from this club event.",
      metadata: { eventId, itemId },
    }, tx);
  });
  return listEventAwardItems(eventId);
}
