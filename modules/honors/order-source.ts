import "server-only";

import { getPrisma } from "@/lib/prisma";
import { type NeedCandidate, syncOrderNeeds } from "@/modules/club-orders/repository";

/**
 * Honors as an order source (#487): the only place that knows a completed,
 * un-ordered honor is a "need". Everything past this file (the order list,
 * stock, and the fulfillment states) is generic (`modules/club-orders`) and
 * will be reused by uniform ordering (#497) and earned awards (#532) with
 * their own source, never by touching this one.
 */

/**
 * This club's active roster members whose latest entry for some honor is
 * COMPLETED, with the entry id that made it so (the need's stable
 * `sourceId`) and the catalog item that honor's patch is, when the catalog
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
    select: { id: true, personId: true, honorId: true, status: true },
  });
  const latestByPersonHonor = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const key = `${entry.personId}\u0000${entry.honorId}`;
    if (!latestByPersonHonor.has(key)) latestByPersonHonor.set(key, entry);
  }
  const completed = [...latestByPersonHonor.values()].filter((entry) => entry.status === "COMPLETED");
  if (completed.length === 0) return [];
  const items = await getPrisma().clubSupplyItem.findMany({
    where: { honorId: { in: completed.map((entry) => entry.honorId) } },
    select: { id: true, honorId: true },
  });
  const itemByHonor = new Map(items.map((item) => [item.honorId, item.id]));
  return completed.map((entry): NeedCandidate => ({
    sourceId: entry.id,
    personId: entry.personId,
    itemId: itemByHonor.get(entry.honorId) ?? null,
  }));
}

/**
 * Records new needs from this club's completed honors (#487). Safe to call on
 * every visit to the order screen: an honor already recorded as a need (the
 * `ClubOrderNeed` unique on `[sourceType, sourceId]`) is skipped, so only
 * genuinely new completions since the last visit become new needs.
 */
export async function syncHonorOrderNeeds(organizationId: string) {
  const candidates = await pendingHonorCompletions(organizationId);
  return syncOrderNeeds(organizationId, "HONOR", candidates);
}
