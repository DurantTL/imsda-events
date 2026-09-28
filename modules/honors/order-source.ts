import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  listNeededNeedsElsewhere,
  moveNeededNeedsToClub,
  type NeedCandidate,
  syncOrderNeeds,
} from "@/modules/club-orders/repository";

/**
 * Honors as an order source (#487): the only place that knows a completed,
 * un-ordered honor is a "need". Everything past this file (the order list,
 * stock, and the fulfillment states) is generic (`modules/club-orders`) and
 * will be reused by uniform ordering (#497) and earned awards (#532) with
 * their own source, never by touching this one.
 */

/**
 * The stable need key for one person's patch for one honor. Keyed on the
 * person and the honor, never on an entry id: #486 records are append-only,
 * so a re-completion or a completion-date correction adds a new entry, and
 * that must never make a second need for the same patch.
 */
export function honorNeedSourceId(personId: string, honorId: string) {
  return `${personId}:${honorId}`;
}

/**
 * This club's active roster members whose latest entry for some honor is
 * COMPLETED, with the catalog item that honor's patch is, when the catalog
 * links one (#531). Only the latest entry per person-and-honor counts, same
 * as the Honors page.
 */
async function pendingHonorCompletions(organizationId: string) {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, status: "ACTIVE", personId: { not: null } },
    select: { personId: true },
  });
  const personIds = [...new Set(members.map((member) => member.personId!))];
  if (personIds.length === 0) return [];
  const entries = await getPrisma().memberHonorEntry.findMany({
    where: { personId: { in: personIds } },
    orderBy: { seq: "desc" },
    select: { personId: true, honorId: true, status: true, completionDate: true, honor: { select: { name: true } } },
  });
  const latestByPersonHonor = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const key = honorNeedSourceId(entry.personId, entry.honorId);
    if (!latestByPersonHonor.has(key)) latestByPersonHonor.set(key, entry);
  }
  const completed = [...latestByPersonHonor.values()].filter((entry) => entry.status === "COMPLETED");
  if (completed.length === 0) return [];
  const items = await getPrisma().clubSupplyItem.findMany({
    where: { honorId: { in: [...new Set(completed.map((entry) => entry.honorId))] } },
    select: { id: true, honorId: true },
  });
  const itemByHonor = new Map(items.map((item) => [item.honorId, item.id]));
  return completed.map((entry): NeedCandidate => ({
    sourceId: honorNeedSourceId(entry.personId, entry.honorId),
    personId: entry.personId,
    itemId: itemByHonor.get(entry.honorId) ?? null,
    sourceLabel: entry.honor.name,
    sourceDate: entry.completionDate,
  }));
}

/**
 * Records new needs from this club's completed honors (#487), skipping any
 * already on file, and brings a transferred member's not-yet-ordered needs
 * with them: a NEEDED need recorded under a club where the person is no
 * longer active moves to this club. Ordered, received, and awarded needs stay
 * with the club that ordered them. Only editors' visits and write paths call
 * this; a view-only visit never writes.
 */
export async function syncHonorOrderNeeds(organizationId: string) {
  const candidates = await pendingHonorCompletions(organizationId);
  const created = await syncOrderNeeds(organizationId, "HONOR", candidates);
  const elsewhere = await listNeededNeedsElsewhere(organizationId, "HONOR", candidates.map((candidate) => candidate.sourceId));
  let moved = 0;
  if (elsewhere.length > 0) {
    const stillActive = await getPrisma().clubRosterMember.findMany({
      where: { status: "ACTIVE", OR: elsewhere.map((need) => ({ personId: need.personId, organizationId: need.organizationId })) },
      select: { personId: true, organizationId: true },
    });
    const activeAt = new Set(stillActive.map((member) => `${member.personId}\u0000${member.organizationId}`));
    const toMove = elsewhere.filter((need) => !activeAt.has(`${need.personId}\u0000${need.organizationId}`));
    moved = (await moveNeededNeedsToClub(organizationId, toMove)).count;
  }
  return { count: created.count, moved };
}
