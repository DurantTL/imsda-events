import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  personCheckEvidenceSelect,
  rosterMemberCheckEvidenceSelect,
  uncachedChecksForRosterMembers,
} from "@/modules/background-checks/repository";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { isSelfNomination, type DriverEligibleAttendeeType } from "@/modules/driver-verification/domain";
import { personIdForActor, type GlobalReviewerActor } from "@/modules/driver-verification/access";
import {
  clubDriverLabel,
  deriveDriverClearance,
  isDriverException,
  type DriverClearance,
  type DriverClearanceStatus,
} from "@/modules/driver-verification/clearance";
import type { DriverClearanceInput } from "@/modules/driver-verification/schemas";

/**
 * Driver clearance reads (#491, #544). Nothing here is a stored list or a
 * stored clearance: every read takes the current, active, willing staff or
 * adult roster rows and derives clearance from the background-check list on
 * file (`deriveDriverClearance`, matched at read time as #527 does), so a
 * new upload or a person added later changes it with no staff action.
 *
 * Staff get exceptions only, with the issues text as written. A club gets
 * a label per driver (`clubDriverLabel`) and never the text. A staff
 * override (`DriverVerification`) stands over the derived result, is shown
 * beside it, and is audited. Only the reviewer, date, outcome, and note are
 * ever written; no license or insurance data has anywhere to go here.
 */

export type DriverVerificationErrorCode = "PERSON_NOT_FOUND" | "SELF_REVIEW";

export class DriverVerificationError extends Error {
  constructor(public readonly code: DriverVerificationErrorCode, message: string) {
    super(message);
    this.name = "DriverVerificationError";
  }
}

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

export type DriverOverride = {
  clearedToTransport: boolean;
  note: string;
  reviewedAt: string;
  reviewerName: string;
};

/** One exception in the staff queue (#544). Staff only: carries the issues text. */
export type StaffDriverEntry = {
  personId: string;
  rosterMemberId: string;
  firstName: string;
  lastName: string;
  attendeeType: DriverEligibleAttendeeType;
  organizationId: string;
  organizationName: string;
  /** What the background-check list says, before any override. */
  clearance: DriverClearance;
  /** The issues column exactly as written; null when the person has no check or none was written. */
  issuesText: string | null;
  /** A staff override, which stands over `clearance` until replaced. */
  override: DriverOverride | null;
};

/** One willing driver as a club sees them (#544): a label, never the issues text, a reason, or an override note. */
export type ClubDriverEntry = {
  rosterMemberId: string;
  firstName: string;
  lastName: string;
  attendeeType: DriverEligibleAttendeeType;
  status: DriverClearanceStatus;
  label: string;
};

type Evidence = Awaited<ReturnType<typeof uncachedChecksForRosterMembers>>;

function overrideOf(member: WillingDriverRow): DriverOverride | null {
  const verification = member.person?.driverVerification;
  if (!verification) return null;
  return {
    clearedToTransport: verification.clearedToTransport,
    note: verification.note,
    reviewedAt: verification.reviewedAt.toISOString(),
    reviewerName: verification.reviewedByUser?.displayName ?? verification.reviewedBy?.displayName ?? "A staff member",
  };
}

async function loadWillingDrivers(where: Prisma.ClubRosterMemberWhereInput, now: Date) {
  const today = calendarDateInEventTimeZone(now, "America/Chicago");
  const members = await getPrisma().clubRosterMember.findMany({
    where: { status: "ACTIVE", willingToDrive: true, attendeeType: { in: WILLING_DRIVER_TYPES }, ...where },
    select: willingDriverSelect,
    orderBy: [{ person: { lastName: "asc" } }, { person: { firstName: "asc" } }],
  });
  const uncached: Evidence = await uncachedChecksForRosterMembers(members);
  return members.flatMap((member) => {
    if (!member.personId || !member.person) return [];
    // The cached match, or the same read-time lookup the club roster uses (#527).
    const check = member.person.backgroundCheckMatch?.entry ?? uncached.get(member.personId) ?? null;
    return [{ member, check, clearance: deriveDriverClearance(check, today) }];
  });
}

/**
 * The staff queue (#544): only the willing drivers who need a look, across
 * every club: needs review, not cleared, or expiring within
 * `DRIVER_EXPIRY_WARNING_DAYS`. Cleared drivers are not listed. Any staff
 * override is shown on the row.
 */
export async function listDriverExceptions(now = new Date()): Promise<StaffDriverEntry[]> {
  const loaded = await loadWillingDrivers({ clubYear: clubYearFor(now) }, now);
  return loaded
    .filter(({ clearance }) => isDriverException(clearance))
    .map(({ member, check, clearance }) => ({
      personId: member.personId!,
      rosterMemberId: member.id,
      firstName: member.person!.firstName,
      lastName: member.person!.lastName,
      attendeeType: member.attendeeType as DriverEligibleAttendeeType,
      organizationId: member.organizationId,
      organizationName: member.organization.name,
      clearance,
      issuesText: check?.issuesNote ?? null,
      override: overrideOf(member),
    }));
}

/**
 * A club's willing drivers with a clearance label each (#544), for the
 * club's driver list and its roster. The label is all a club gets: no
 * issues text, no reason, no override note. A staff override decides the
 * label when there is one.
 */
export async function clubDriverEntries(organizationId: string, clubYear: string, now = new Date()): Promise<ClubDriverEntry[]> {
  const loaded = await loadWillingDrivers({ organizationId, clubYear }, now);
  return loaded.map(({ member, clearance }) => {
    const override = overrideOf(member);
    const status: DriverClearanceStatus = override ? (override.clearedToTransport ? "CLEARED" : "NOT_CLEARED") : clearance.status;
    return {
      rosterMemberId: member.id,
      firstName: member.person!.firstName,
      lastName: member.person!.lastName,
      attendeeType: member.attendeeType as DriverEligibleAttendeeType,
      status,
      label: clubDriverLabel(status, override ? null : clearance.expiresOn),
    };
  });
}

/** `clubDriverEntries` keyed by roster member id, for the roster's chip. */
export async function clubDriverLabels(organizationId: string, clubYear: string, now = new Date()) {
  const entries = await clubDriverEntries(organizationId, clubYear, now);
  return Object.fromEntries(entries.map((entry) => [entry.rosterMemberId, { status: entry.status, label: entry.label }]));
}

/**
 * Records a staff override of the derived clearance, with a note (#544).
 * Refuses self-nomination outright (checked before anything else) and a
 * person who isn't currently a willing driver. The previous override, if
 * any, is replaced; the history lives in the audit log, which also records
 * what the background-check list said at the time (never the issues text).
 */
export async function recordDriverClearance(
  personId: string,
  input: Pick<DriverClearanceInput, "clearedToTransport" | "note">,
  actor: GlobalReviewerActor,
  now = new Date(),
) {
  const reviewerPersonId = await personIdForActor({ userId: actor.userId });
  if (isSelfNomination(reviewerPersonId, personId)) {
    throw new DriverVerificationError("SELF_REVIEW", "You can't clear yourself to transport youth. Ask another reviewer.");
  }

  const [current] = await loadWillingDrivers({ personId, clubYear: clubYearFor(now) }, now);
  if (!current) {
    throw new DriverVerificationError("PERSON_NOT_FOUND", "That person isn't a willing driver on a current roster.");
  }

  await getPrisma().$transaction(async (tx) => {
    await tx.driverVerification.upsert({
      where: { personId },
      create: {
        personId,
        clearedToTransport: input.clearedToTransport,
        note: input.note,
        reviewedAt: now,
        reviewedByUserId: actor.userId,
      },
      update: {
        clearedToTransport: input.clearedToTransport,
        note: input.note,
        reviewedAt: now,
        reviewedByAccountId: null,
        reviewedByUserId: actor.userId,
      },
    });
    await writeAuditLog({
      actorUserId: actor.userId,
      action: "DRIVER_VERIFICATION_REVIEWED",
      entityType: "DriverVerification",
      entityId: personId,
      summary: `Overrode driver clearance: ${input.clearedToTransport ? "cleared" : "not cleared"} to transport youth.`,
      metadata: {
        personId,
        clearedToTransport: input.clearedToTransport,
        derivedStatus: current.clearance.status,
        hasNote: input.note.length > 0,
      },
    }, tx);
  });
}
