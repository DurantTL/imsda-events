import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  householdMemberInputSchema,
  membershipIntervalsOverlap,
  membershipCoversDate,
  type HouseholdMemberRecord,
} from "@/modules/people/household-domain";

export class HouseholdMembershipError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "ALREADY_MEMBER" | "NOT_ACTIVE" | "INVALID_RANGE" | "OVERLAPPING_MEMBERSHIP",
    message: string,
  ) {
    super(message);
    this.name = "HouseholdMembershipError";
  }
}

function serialize(row: {
  id: string;
  householdId: string;
  personId: string;
  relationship: string | null;
  canManage: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}): HouseholdMemberRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    personId: row.personId,
    relationship: row.relationship,
    canManage: row.canManage,
    effectiveFrom: row.effectiveFrom ? row.effectiveFrom.toISOString() : null,
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
  };
}

/**
 * Adds a person to a household as of `effectiveFrom` (default now). Checks
 * for an overlapping membership of the same person in the same household
 * before writing, then relies on the database's `EXCLUDE USING gist`
 * constraint (`HouseholdMember_no_overlapping_membership`) as the
 * authoritative guard against a race between the check and the write.
 */
export async function addHouseholdMember(householdId: string, personId: string, rawInput: unknown = {}) {
  const input = householdMemberInputSchema.parse(rawInput);
  const prisma = getPrisma();

  const [household, person] = await Promise.all([
    prisma.household.findUnique({ where: { id: householdId }, select: { id: true } }),
    prisma.person.findUnique({ where: { id: personId }, select: { id: true } }),
  ]);
  if (!household) throw new HouseholdMembershipError("NOT_FOUND", "That household was not found.");
  if (!person) throw new HouseholdMembershipError("NOT_FOUND", "That person was not found.");

  const effectiveFrom = input.effectiveFrom ?? new Date();
  const existing = await prisma.householdMember.findMany({
    where: { householdId, personId },
    select: { effectiveFrom: true, effectiveTo: true },
  });
  const overlaps = existing.some((member) =>
    membershipIntervalsOverlap(
      { effectiveFrom: member.effectiveFrom, effectiveTo: member.effectiveTo },
      { effectiveFrom, effectiveTo: null },
    ),
  );
  if (overlaps) {
    throw new HouseholdMembershipError(
      "OVERLAPPING_MEMBERSHIP",
      "This person already has an active or overlapping membership in this household.",
    );
  }

  try {
    const created = await prisma.householdMember.create({
      data: {
        householdId,
        personId,
        relationship: input.relationship ?? null,
        canManage: input.canManage,
        effectiveFrom,
      },
    });
    return serialize(created);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientUnknownRequestError && /exclu/i.test(error.message)) {
      throw new HouseholdMembershipError(
        "OVERLAPPING_MEMBERSHIP",
        "This person already has an active or overlapping membership in this household.",
      );
    }
    throw error;
  }
}

/**
 * Closes an open household membership as of `closedAt` (default now).
 * Never deletes the row — this is the "removing someone closes the
 * membership" behavior the point-in-time resolution below depends on.
 */
export async function closeHouseholdMember(membershipId: string, closedAt: Date = new Date()) {
  const prisma = getPrisma();
  const existing = await prisma.householdMember.findUnique({ where: { id: membershipId } });
  if (!existing) throw new HouseholdMembershipError("NOT_FOUND", "That household membership was not found.");
  if (existing.effectiveTo !== null) {
    throw new HouseholdMembershipError("NOT_ACTIVE", "That household membership is already closed.");
  }
  if (existing.effectiveFrom !== null && closedAt <= existing.effectiveFrom) {
    throw new HouseholdMembershipError(
      "INVALID_RANGE",
      "A membership cannot be closed at or before the date it started.",
    );
  }

  const closed = await prisma.householdMember.update({
    where: { id: membershipId },
    data: { effectiveTo: closedAt },
  });
  return serialize(closed);
}

/**
 * Point-in-time household resolution: who was in this household on
 * `asOf`, not who is in it today. A past registration should read this
 * instead of the household's current member list.
 */
export async function householdMembersAsOf(householdId: string, asOf: Date) {
  const rows = await getPrisma().householdMember.findMany({
    where: {
      householdId,
      AND: [
        { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  // Defence in depth: re-check the same interval logic in application code
  // in case a future query change loosens the filter above.
  return rows
    .filter((row) => membershipCoversDate({ effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo }, asOf))
    .map(serialize);
}

/** Every household a person belonged to as of `asOf`. */
export async function personHouseholdsAsOf(personId: string, asOf: Date) {
  const rows = await getPrisma().householdMember.findMany({
    where: {
      personId,
      AND: [
        { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .filter((row) => membershipCoversDate({ effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo }, asOf))
    .map(serialize);
}

/** Current (as-of-now) members of a household. A thin, named alias over
 * `householdMembersAsOf` for call sites that only care about "now". */
export async function currentHouseholdMembers(householdId: string) {
  return householdMembersAsOf(householdId, new Date());
}

/** The full membership history of a person in a household, closed rows
 * included, oldest first. */
export async function householdMembershipHistory(householdId: string, personId: string) {
  const rows = await getPrisma().householdMember.findMany({
    where: { householdId, personId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(serialize);
}
