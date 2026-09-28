import "server-only";

import { randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  auditActorFields,
  ClubOrderError,
  type ClubOrderActor,
  lockClubOrders,
} from "@/modules/club-orders/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";
import {
  groupUniformCatalog,
  isUniformSection,
  splitSizedItemName,
  UNIFORM_SECTIONS,
  type UniformItemGroup,
} from "@/modules/uniforms/domain";

/**
 * Uniforms as an order source (#497), the counterpart of
 * `modules/honors/order-source.ts`. Honors are found by scanning completions;
 * uniform needs are recorded by hand, so this file is the only place that
 * creates or removes `UNIFORM` needs. A need is a `ClubOrderNeed` for one
 * member and one sized catalog item (each size is its own item), and from
 * there everything is the generic order layer (`modules/club-orders`): the
 * same order batches, stock math, locks, exports and audit.
 *
 * Status mapping: needed -> ordered -> received -> issued is the layer's
 * NEEDED -> ORDERED -> RECEIVED -> AWARDED.
 *
 * Every write here takes the same per-club lock as ordering and receiving,
 * so a bulk entry can never interleave with a "Place order".
 */

const OPEN_STATUSES = ["NEEDED", "ORDERED", "RECEIVED"] as const;

/** A uniform need's stable key: generated, since a member can legitimately need the same item again after being issued one. */
export function uniformNeedSourceId() {
  return `uniform:${randomUUID()}`;
}

/** Today's calendar date (`YYYY-MM-DD`), which orders uniform needs oldest-first with honors' completion dates. */
function calendarDate(now: Date) {
  return now.toISOString().slice(0, 10);
}

/**
 * Records uniform needs in bulk (#497): every member x every item, under the
 * club's lock. Members must be active on this club's roster this club year;
 * items must be active catalog rows in a uniform section. A member who
 * already has an open (needed, ordered, or received) need for that item is
 * skipped, so re-submitting the same entry never doubles anything up.
 * `alreadyHasOne` (the spreadsheet's "2") records the need directly as
 * issued: nothing to order, and stock is never touched.
 * Audited with counts and the item ids only, never a name.
 */
export async function recordUniformNeeds(
  organizationId: string,
  input: { personIds: readonly string[]; itemIds: readonly string[]; alreadyHasOne: boolean },
  actor: ClubOrderActor,
  now = new Date(),
) {
  const personIds = [...new Set(input.personIds)];
  const itemIds = [...new Set(input.itemIds)];
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const [items, members] = await Promise.all([
      tx.clubSupplyItem.findMany({
        where: { id: { in: itemIds }, isActive: true, section: { in: [...UNIFORM_SECTIONS] } },
        select: { id: true, name: true },
      }),
      tx.clubRosterMember.findMany({
        where: { organizationId, clubYear: clubYearFor(now), status: "ACTIVE", personId: { in: personIds } },
        select: { personId: true },
      }),
    ]);
    if (items.length !== itemIds.length) {
      throw new ClubOrderError("ITEM_NOT_ORDERABLE", "One of those items isn't an active uniform item in the supply catalog.");
    }
    const onRoster = new Set(members.map((member) => member.personId));
    if (personIds.some((personId) => !onRoster.has(personId))) {
      throw new ClubOrderError("MEMBER_NOT_ON_ROSTER", "Everyone must be an active member of this club's roster this year.");
    }
    const open = await tx.clubOrderNeed.findMany({
      where: {
        organizationId,
        sourceType: "UNIFORM",
        status: { in: [...OPEN_STATUSES] },
        personId: { in: personIds },
        itemId: { in: itemIds },
      },
      select: { personId: true, itemId: true },
    });
    const alreadyOpen = new Set(open.map((need) => `${need.personId}\u0000${need.itemId}`));
    const data = items.flatMap((item) => personIds
      .filter((personId) => !alreadyOpen.has(`${personId}\u0000${item.id}`))
      .map((personId) => ({
        organizationId,
        sourceType: "UNIFORM" as const,
        sourceId: uniformNeedSourceId(),
        personId,
        itemId: item.id,
        sourceLabel: splitSizedItemName(item.name).baseName,
        sourceDate: calendarDate(now),
        status: input.alreadyHasOne ? ("AWARDED" as const) : ("NEEDED" as const),
      })));
    const skipped = personIds.length * itemIds.length - data.length;
    if (data.length > 0) await tx.clubOrderNeed.createMany({ data });
    if (data.length > 0) {
      const who = auditActorFields(actor);
      await writeAuditLog({
        ...who.actorFields,
        action: input.alreadyHasOne ? "CLUB_UNIFORM_NEEDS_RECORDED_ISSUED" : "CLUB_UNIFORM_NEEDS_RECORDED",
        entityType: "ClubOrderNeed",
        summary: input.alreadyHasOne
          ? `Recorded ${data.length} uniform item${data.length === 1 ? "" : "s"} members already have.`
          : `Recorded ${data.length} uniform need${data.length === 1 ? "" : "s"}.`,
        metadata: {
          organizationId,
          needCount: data.length,
          skippedCount: skipped,
          memberCount: personIds.length,
          itemIds: itemIds,
          alreadyHasOne: input.alreadyHasOne,
          ...who.metadata,
        },
      }, tx);
    }
    return { created: data.length, skipped, alreadyHadOne: input.alreadyHasOne ? data.length : 0 };
  });
}

/**
 * Removes uniform needs that were entered by mistake (#497): only UNIFORM
 * needs still NEEDED, so anything on an order or issued is never touched.
 * Guarded delete under the club's lock; one audit row with the count.
 */
export async function removeUniformNeeds(organizationId: string, needIds: readonly string[], actor: ClubOrderActor) {
  return getPrisma().$transaction(async (tx) => {
    await lockClubOrders(tx, organizationId);
    const removed = await tx.clubOrderNeed.deleteMany({
      where: { id: { in: [...needIds] }, organizationId, sourceType: "UNIFORM", status: "NEEDED" },
    });
    if (removed.count === 0) return { removed: 0 };
    const who = auditActorFields(actor);
    await writeAuditLog({
      ...who.actorFields,
      action: "CLUB_UNIFORM_NEEDS_REMOVED",
      entityType: "ClubOrderNeed",
      summary: `Removed ${removed.count} not-yet-ordered uniform need${removed.count === 1 ? "" : "s"}.`,
      metadata: { organizationId, needCount: removed.count, ...who.metadata },
    }, tx);
    return { removed: removed.count };
  });
}

export type UniformNeedRow = {
  needId: string;
  personId: string;
  firstName: string;
  lastName: string;
  itemName: string;
  size: string;
  status: "NEEDED" | "ORDERED" | "RECEIVED";
};

export type UniformMember = { personId: string; firstName: string; lastName: string };

export type UniformWorkspaceData = {
  /** Uniform items grouped by name, sizes as variants: the picker. Empty for a view-only visit. */
  catalog: UniformItemGroup[];
  /** Active members of this club this year, names only. Empty for a view-only visit. */
  members: UniformMember[];
  /** Open uniform needs (needed, ordered, received), names and the item and size only. */
  needs: UniformNeedRow[];
  /** How many uniform items have been issued in all, for the count on screen. */
  issuedCount: number;
};

/**
 * The Uniforms section's data (#497). Names, the item and its size, and the
 * status only; no other personal field is ever loaded. The picker and member
 * list (`forEditing`) are only for a director or deputy; a registrar or Area
 * Coordinator reads the open needs. Reads only.
 */
export async function loadUniformWorkspace(
  organizationId: string,
  { forEditing }: { forEditing: boolean },
  now = new Date(),
): Promise<UniformWorkspaceData> {
  const prisma = getPrisma();
  const [needs, issuedCount, catalogRows, roster] = await Promise.all([
    prisma.clubOrderNeed.findMany({
      where: { organizationId, sourceType: "UNIFORM", status: { in: [...OPEN_STATUSES] }, itemId: { not: null } },
      select: { id: true, status: true, personId: true, item: { select: { name: true, section: true } }, person: { select: { firstName: true, lastName: true } } },
    }),
    prisma.clubOrderNeed.count({ where: { organizationId, sourceType: "UNIFORM", status: "AWARDED" } }),
    forEditing
      ? prisma.clubSupplyItem.findMany({
        where: { isActive: true, section: { in: [...UNIFORM_SECTIONS] } },
        select: { id: true, section: true, name: true, catalogNumber: true },
      })
      : Promise.resolve([]),
    forEditing
      ? prisma.clubRosterMember.findMany({
        where: { organizationId, clubYear: clubYearFor(now), status: "ACTIVE", personId: { not: null } },
        select: { person: { select: { id: true, firstName: true, lastName: true } } },
      })
      : Promise.resolve([]),
  ]);
  const byName = (a: { lastName: string; firstName: string }, b: { lastName: string; firstName: string }) =>
    a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
  const rows = needs
    .filter((need) => need.item && isUniformSection(need.item.section))
    .map((need): UniformNeedRow => {
      const { baseName, size } = splitSizedItemName(need.item!.name);
      return {
        needId: need.id,
        personId: need.personId,
        firstName: need.person.firstName,
        lastName: need.person.lastName,
        itemName: baseName,
        size,
        status: need.status as UniformNeedRow["status"],
      };
    })
    .sort((a, b) => byName(a, b) || a.itemName.localeCompare(b.itemName) || a.size.localeCompare(b.size));
  const members = [...new Map(roster.flatMap((row) => (row.person ? [[row.person.id, {
    personId: row.person.id, firstName: row.person.firstName, lastName: row.person.lastName,
  }] as const] : []))).values()].sort(byName);
  return {
    catalog: groupUniformCatalog(catalogRows.map((row) => ({ itemId: row.id, section: row.section, name: row.name, catalogNumber: row.catalogNumber }))),
    members,
    needs: rows,
    issuedCount,
  };
}
