import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clubComplianceState, type ClubComplianceState } from "@/modules/background-checks/domain";
import {
  personCheckEvidenceSelect,
  rosterMemberCheckEvidenceSelect,
  uncachedChecksForRosterMembers,
} from "@/modules/background-checks/repository";
import type { ClubActor } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { isSelfNomination, type DriverEligibleAttendeeType } from "@/modules/driver-verification/domain";
import { actorIdentity, personIdForActor, type GlobalReviewerActor } from "@/modules/driver-verification/access";
import type { DriverClearanceInput } from "@/modules/driver-verification/schemas";

/**
 * Storage for the driver verification queue and its reviews (#491). The
 * queue itself is never a stored list — it's every current, active, willing
 * staff or adult roster row, joined with the background check already on
 * file (`modules/background-checks`) and any past review. Only
 * `DriverVerification`'s reviewer, date, and outcome are ever written; no
 * license or insurance number or file has anywhere to go here.
 */

export type DriverVerificationErrorCode = "PERSON_NOT_FOUND" | "SELF_REVIEW";

export class DriverVerificationError extends Error {
  constructor(public readonly code: DriverVerificationErrorCode, message: string) {
    super(message);
    this.name = "DriverVerificationError";
  }
}

export type DriverQueueScope = { kind: "GLOBAL" } | { kind: "CLUB"; organizationId: string };

const WILLING_DRIVER_TYPES: DriverEligibleAttendeeType[] = ["STAFF", "ADULT"];

const willingDriverSelect = {
  id: true,
  personId: true,
  organizationId: true,
  attendeeType: true,
  ...rosterMemberCheckEvidenceSelect,
  person: {
    select: {
      firstName: true,
      lastName: true,
      ...personCheckEvidenceSelect,
      backgroundCheckMatch: { select: { entry: { select: { complianceStatus: true, expiresOn: true, issuesNote: true } } } },
      driverVerification: {
        select: {
          clearedToTransport: true,
          note: true,
          reviewedAt: true,
          reviewedBy: { select: { displayName: true } },
          reviewedByUser: { select: { displayName: true } },
        },
      },
    },
  },
} satisfies Prisma.ClubRosterMemberSelect;

type WillingDriverRow = Prisma.ClubRosterMemberGetPayload<{ select: typeof willingDriverSelect }>;

export type DriverQueueEntry = {
  personId: string;
  rosterMemberId: string;
  firstName: string;
  lastName: string;
  attendeeType: DriverEligibleAttendeeType;
  organizationId: string;
  organizationName: string;
  backgroundCheck: { state: ClubComplianceState; note: string | null };
  verification: {
    clearedToTransport: boolean;
    note: string;
    reviewedAt: string;
    reviewerName: string;
  } | null;
};

/**
 * The background-check issue note is conference staff only (#427, the same
 * rule as `clubRosterComplianceStatuses`): a club's own queue never carries
 * it, not even a blank to hide — `note` is always null there. Whether a club
 * reviewer should see it is a human decision still open on #491.
 */
function serializeQueueEntry(
  member: WillingDriverRow,
  today: string,
  includeNotes: boolean,
  uncached: Awaited<ReturnType<typeof uncachedChecksForRosterMembers>>,
): DriverQueueEntry | null {
  if (!member.personId || !member.person) return null;
  // The cached match, or the same read-time lookup the club roster uses (#527).
  const check = member.person.backgroundCheckMatch?.entry ?? uncached.get(member.personId) ?? null;
  const verification = member.person.driverVerification;
  return {
    personId: member.personId,
    rosterMemberId: member.id,
    firstName: member.person.firstName,
    lastName: member.person.lastName,
    attendeeType: member.attendeeType as DriverEligibleAttendeeType,
    organizationId: member.organizationId,
    organizationName: member.organization.name,
    backgroundCheck: { state: clubComplianceState(check, today), note: includeNotes ? check?.issuesNote ?? null : null },
    verification: verification ? {
      clearedToTransport: verification.clearedToTransport,
      note: verification.note,
      reviewedAt: verification.reviewedAt.toISOString(),
      reviewerName: verification.reviewedByUser?.displayName ?? verification.reviewedBy?.displayName ?? "A staff member",
    } : null,
  };
}

/**
 * Every willing driver on a current, active staff or adult roster row —
 * every club's for a system administrator, or one club's for its director
 * or deputy — with their background-check status and note, and their most
 * recent review if any.
 */
export async function listWillingDrivers(scope: DriverQueueScope, now = new Date()): Promise<DriverQueueEntry[]> {
  const clubYear = clubYearFor(now);
  const today = calendarDateInEventTimeZone(now, "America/Chicago");
  const members = await getPrisma().clubRosterMember.findMany({
    where: {
      clubYear,
      status: "ACTIVE",
      willingToDrive: true,
      attendeeType: { in: WILLING_DRIVER_TYPES },
      ...(scope.kind === "CLUB" ? { organizationId: scope.organizationId } : {}),
    },
    select: willingDriverSelect,
    orderBy: [{ person: { lastName: "asc" } }, { person: { firstName: "asc" } }],
  });
  const uncached = await uncachedChecksForRosterMembers(members);
  return members
    .map((member) => serializeQueueEntry(member, today, scope.kind === "GLOBAL", uncached))
    .filter((entry): entry is DriverQueueEntry => entry !== null);
}

/**
 * Records a reviewer's decision. Refuses self-nomination outright (checked
 * before anything else, whatever role the actor holds) and refuses a person
 * outside the reviewer's scope or not currently a willing driver, so a club
 * director can't be used to clear someone from another club, or someone who
 * never checked the box. The previous decision, if any, is replaced — the
 * history of who decided what lives in the audit log, not in extra rows.
 */
export async function recordDriverClearance(
  personId: string,
  scope: DriverQueueScope,
  input: Pick<DriverClearanceInput, "clearedToTransport" | "note">,
  actor: ClubActor | GlobalReviewerActor,
  now = new Date(),
) {
  const identity = actorIdentity(actor);
  const reviewerPersonId = await personIdForActor(identity);
  if (isSelfNomination(reviewerPersonId, personId)) {
    throw new DriverVerificationError("SELF_REVIEW", "You can't clear yourself to transport youth. Ask another reviewer.");
  }

  const clubYear = clubYearFor(now);
  const member = await getPrisma().clubRosterMember.findFirst({
    where: {
      personId,
      clubYear,
      status: "ACTIVE",
      willingToDrive: true,
      attendeeType: { in: WILLING_DRIVER_TYPES },
      ...(scope.kind === "CLUB" ? { organizationId: scope.organizationId } : {}),
    },
    select: { id: true },
  });
  if (!member) {
    throw new DriverVerificationError(
      "PERSON_NOT_FOUND",
      "That person isn't a willing driver on a roster you can review.",
    );
  }

  const actAsId = "actAsId" in actor ? actor.actAsId : undefined;
  await getPrisma().$transaction(async (tx) => {
    await tx.driverVerification.upsert({
      where: { personId },
      create: {
        personId,
        clearedToTransport: input.clearedToTransport,
        note: input.note,
        reviewedAt: now,
        ...("accountId" in identity ? { reviewedByAccountId: identity.accountId } : { reviewedByUserId: identity.userId }),
      },
      update: {
        clearedToTransport: input.clearedToTransport,
        note: input.note,
        reviewedAt: now,
        reviewedByAccountId: "accountId" in identity ? identity.accountId : null,
        reviewedByUserId: "accountId" in identity ? null : identity.userId,
      },
    });
    await writeAuditLog({
      ...("userId" in identity ? { actorUserId: identity.userId } : {}),
      action: "DRIVER_VERIFICATION_REVIEWED",
      entityType: "DriverVerification",
      entityId: personId,
      summary: `Recorded a driver clearance decision: ${input.clearedToTransport ? "cleared" : "not cleared"} to transport youth.`,
      metadata: {
        personId,
        clearedToTransport: input.clearedToTransport,
        scope: scope.kind,
        ...(scope.kind === "CLUB" ? { organizationId: scope.organizationId } : {}),
        ...("accountId" in identity ? { actorAttendeeAccountId: identity.accountId } : {}),
        ...(actAsId ? { actAsId } : {}),
      },
    }, tx);
  });
}
