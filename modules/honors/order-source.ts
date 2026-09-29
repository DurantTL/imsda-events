import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  listNeededNeedsElsewhere,
  moveNeededNeedsToClub,
  type NeedCandidate,
  reconcileNeededNeeds,
  syncOrderNeeds,
} from "@/modules/club-orders/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";

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
 * This club's active members on this club year's roster (the same rows the
 * Honors page reads), and for each person-and-honor their latest entry — only
 * the latest counts, same as the Honors page. A latest entry that's COMPLETED
 * is a need candidate, carrying the catalog item that honor's patch is linked
 * to right now (#531); one that's no longer COMPLETED (corrected back to in
 * progress) is a withdrawn completion.
 */
async function honorCompletionsForClub(organizationId: string, now: Date) {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear: clubYearFor(now), status: "ACTIVE", personId: { not: null } },
    select: { personId: true },
  });
  const personIds = [...new Set(members.map((member) => member.personId!))];
  if (personIds.length === 0) return { candidates: [], withdrawnSourceIds: [] };
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
  const latest = [...latestByPersonHonor.values()];
  const completed = latest.filter((entry) => entry.status === "COMPLETED");
  const withdrawnSourceIds = latest
    .filter((entry) => entry.status !== "COMPLETED")
    .map((entry) => honorNeedSourceId(entry.personId, entry.honorId));
  if (completed.length === 0) return { candidates: [], withdrawnSourceIds };
  const items = await getPrisma().clubSupplyItem.findMany({
    where: { honorId: { in: [...new Set(completed.map((entry) => entry.honorId))] } },
    orderBy: { id: "asc" },
    select: { id: true, honorId: true },
  });
  const itemByHonor = new Map<string, string>();
  for (const item of items) if (item.honorId && !itemByHonor.has(item.honorId)) itemByHonor.set(item.honorId, item.id);
  const candidates = completed.map((entry): NeedCandidate => ({
    sourceId: honorNeedSourceId(entry.personId, entry.honorId),
    personId: entry.personId,
    itemId: itemByHonor.get(entry.honorId) ?? null,
    sourceLabel: entry.honor.name,
    sourceDate: entry.completionDate,
  }));
  return { candidates, withdrawnSourceIds };
}

/**
 * Brings this club's honor needs up to date (#487). Only editors' visits and
 * write paths call this; a view-only visit never writes.
 *   1. New completions become needs; ones already on file are skipped.
 *   2. A transferred member's not-yet-ordered needs come with them: a NEEDED
 *      need recorded under a club where the person is no longer active this
 *      club year moves here. Ordered, received, and awarded needs stay with
 *      the club that ordered them.
 *   3. NEEDED needs take the catalog item their honor is linked to now (an
 *      honor linked or re-linked in the catalog after the need was recorded),
 *      and a NEEDED need whose completion was withdrawn is removed.
 */
export async function syncHonorOrderNeeds(organizationId: string, now = new Date()) {
  const { candidates, withdrawnSourceIds } = await honorCompletionsForClub(organizationId, now);
  const created = await syncOrderNeeds(organizationId, "HONOR", candidates, now);
  const elsewhere = await listNeededNeedsElsewhere(organizationId, "HONOR", candidates.map((candidate) => candidate.sourceId));
  let moved = 0;
  if (elsewhere.length > 0) {
    const stillActive = await getPrisma().clubRosterMember.findMany({
      where: {
        status: "ACTIVE",
        clubYear: clubYearFor(now),
        OR: elsewhere.map((need) => ({ personId: need.personId, organizationId: need.organizationId })),
      },
      select: { personId: true, organizationId: true },
    });
    const activeAt = new Set(stillActive.map((member) => `${member.personId}\u0000${member.organizationId}`));
    const toMove = elsewhere.filter((need) => !activeAt.has(`${need.personId}\u0000${need.organizationId}`));
    moved = (await moveNeededNeedsToClub(organizationId, toMove)).count;
  }
  const reconciled = await reconcileNeededNeeds(
    organizationId,
    "HONOR",
    new Map(candidates.map((candidate) => [candidate.sourceId, candidate.itemId])),
    withdrawnSourceIds,
  );
  return { count: created.count, moved, ...reconciled };
}
