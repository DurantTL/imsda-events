import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/env";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import { logError } from "@/lib/logger";
import { formatCalendarDate } from "@/modules/club-registrations/domain";
import { teamLabel } from "@/modules/club-teams/domain";
import { ClubTeamError } from "@/modules/club-teams/errors";
import { permissionNotice, type PermissionDecision, type PermissionStatus } from "@/modules/club-teams/permission-domain";
import { coordinatorGrantActive } from "@/modules/event-locations/domain";

/**
 * A team member who is 18 or older on the age date needs the Area Coordinator's permission (#809). The team is registered
 * anyway; this keeps the flag, tells whoever decides, and records who decided and when.
 */

type Tx = Prisma.TransactionClient;

export type PermissionCandidate = { attendeeId: string; name: string; age: number | null; role: "MEMBER" | "COACH" };

export type PermissionSyncResult = {
  /** Names of people whose permission was declined and who are still team members: the team cannot be saved as it is. */
  declined: string[];
  /** Outbox messages queued for the Area Coordinator (or staff); deliver them after the transaction commits. */
  queuedMessageIds: string[];
};

/**
 * Brings a team's permission flags in line with who is on it, inside the caller's transaction: a flag is made (pending)
 * for each team member of 18 or older who has none, kept for those who still need it, and removed for anyone who no
 * longer does (a coach, someone under 18, someone removed). One message goes out for the people newly flagged in this
 * change, not one per save of the same people.
 */
export async function syncTeamMemberPermissions(
  tx: Tx,
  input: { eventId: string; clubEventRegistrationId: string; registrationId: string; people: readonly PermissionCandidate[]; actorUserId?: string },
): Promise<PermissionSyncResult> {
  const needing = input.people.filter((person) => person.role === "MEMBER" && person.age !== null && person.age >= 18);
  const existing = await tx.clubTeamMemberPermission.findMany({ where: { clubEventRegistrationId: input.clubEventRegistrationId } });
  const byAttendee = new Map(existing.map((row) => [row.registrationAttendeeId, row]));
  const needingIds = new Set(needing.map((person) => person.attendeeId));
  const names = new Map(input.people.map((person) => [person.attendeeId, person.name]));

  const declined = needing.filter((person) => byAttendee.get(person.attendeeId)?.status === "DECLINED").map((person) => person.name);

  const created: PermissionCandidate[] = [];
  for (const person of needing) {
    const row = byAttendee.get(person.attendeeId);
    if (!row) {
      const saved = await tx.clubTeamMemberPermission.create({
        data: { eventId: input.eventId, clubEventRegistrationId: input.clubEventRegistrationId, registrationAttendeeId: person.attendeeId, ageOnAgeDate: person.age as number },
        select: { id: true },
      });
      created.push(person);
      await writeAuditLog({
        eventId: input.eventId, actorUserId: input.actorUserId, action: "CLUB_TEAM_PERMISSION_REQUESTED", entityType: "ClubTeamMemberPermission", entityId: saved.id,
        summary: `${person.name} is ${person.age} on the age date and needs the Area Coordinator's permission to be a team member.`,
        metadata: { registrationId: input.registrationId, attendeeId: person.attendeeId, age: person.age },
      }, tx);
    } else if (row.ageOnAgeDate !== person.age) {
      await tx.clubTeamMemberPermission.update({ where: { id: row.id }, data: { ageOnAgeDate: person.age as number } });
    }
  }
  for (const row of existing) {
    if (needingIds.has(row.registrationAttendeeId)) continue;
    await tx.clubTeamMemberPermission.delete({ where: { id: row.id } });
    await writeAuditLog({
      eventId: input.eventId, actorUserId: input.actorUserId, action: "CLUB_TEAM_PERMISSION_CLEARED", entityType: "ClubTeamMemberPermission", entityId: row.id,
      summary: `${names.get(row.registrationAttendeeId) ?? "A person"} no longer needs the Area Coordinator's permission (no longer a team member of 18 or older).`,
      metadata: { registrationId: input.registrationId, attendeeId: row.registrationAttendeeId, status: row.status },
    }, tx);
  }
  const queuedMessageIds = created.length > 0 ? await queuePermissionRequest(tx, { ...input, people: created }) : [];
  return { declined, queuedMessageIds };
}

const idempotencyHash = (ids: readonly string[]) => [...ids].sort().join(",");

/**
 * Writes the request to the event's outbox (the event's own delivery mode, so local capture works in development): to the
 * Area Coordinator of the team's location while their grant is active, otherwise to the event's staff who manage
 * registrations. One message per recipient for the people newly flagged in this change.
 */
async function queuePermissionRequest(
  tx: Tx,
  input: { eventId: string; registrationId: string; people: readonly PermissionCandidate[] },
): Promise<string[]> {
  const registration = await tx.registration.findUnique({
    where: { id: input.registrationId },
    select: {
      confirmationCode: true,
      event: { select: { name: true } },
      location: { select: { name: true, coordinator: { select: { email: true, displayName: true, disabledAt: true, areaCoordinatorGrant: { select: { revokedAt: true, expiresAt: true } } } } } },
      clubRegistration: { select: { teamName: true, organization: { select: { name: true } } } },
    },
  });
  if (!registration) return [];
  const settings = await tx.eventTeamSettings.findUnique({ where: { eventId: input.eventId }, select: { ageAsOf: true } });
  const coordinator = registration.location?.coordinator;
  const recipients: Array<{ email: string; name: string; staff: boolean }> = [];
  if (coordinator && !coordinator.disabledAt && coordinatorGrantActive(coordinator.areaCoordinatorGrant)) {
    recipients.push({ email: coordinator.email, name: coordinator.displayName, staff: false });
  } else {
    const memberships = await tx.eventMembership.findMany({
      where: {
        eventId: input.eventId,
        status: "ACTIVE",
        OR: [{ role: { in: ["EVENT_ADMIN", "REGISTRATION_MANAGER"] } }, { permissions: { has: "MANAGE_REGISTRATION" } }],
        user: { accountStatus: "ACTIVE", NOT: { credential: { is: { disabledAt: { not: null } } } } },
      },
      select: { user: { select: { email: true, displayName: true } } },
    });
    for (const membership of memberships) recipients.push({ email: membership.user.email, name: membership.user.displayName, staff: true });
  }
  if (recipients.length === 0) return [];

  const messageSettings = await tx.eventMessageSettings.findUnique({
    where: { eventId: input.eventId },
    select: { deliveryMode: true, senderName: true, senderEmail: true, replyToEmail: true },
  }) ?? { deliveryMode: "LOCAL_CAPTURE" as const, senderName: "IMSDA Events", senderEmail: null, replyToEmail: null };
  const label = teamLabel(registration.clubRegistration?.organization.name ?? "A club", registration.clubRegistration?.teamName ?? null);
  const dateText = settings?.ageAsOf ? formatCalendarDate(settings.ageAsOf) : "the event date";
  const baseUrl = getServerEnv().APP_BASE_URL;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const link = recipient.staff ? `${baseUrl}/more/team-results?event=${input.eventId}` : `${baseUrl}/account/area-clubs/team-permissions`;
    const bodyText = [
      `Hello ${recipient.name.trim() || "there"},`,
      "",
      `${label} is registered for ${registration.event.name}. Team members 18 and over need permission from the Area Coordinator, and these people are 18 or older on ${dateText}:`,
      "",
      ...input.people.map((person) => `- ${person.name} (${person.age})`),
      "",
      "The team is registered. Please review and grant or decline permission:",
      link,
      "",
      "IMSDA Events",
    ].join("\n");
    const suppressed = messageSettings.deliveryMode === "DISABLED";
    const message = await tx.messageOutbox.upsert({
      where: { idempotencyKey: `team-permission:${input.registrationId}:${idempotencyHash(input.people.map((person) => person.attendeeId))}:${email}` },
      update: {},
      create: {
        eventId: input.eventId,
        registrationId: input.registrationId,
        templateKey: "TEAM_PERMISSION_REQUEST",
        recipientKind: "INTERNAL",
        recipientEmail: email,
        recipientName: recipient.name.trim() || null,
        senderNameSnapshot: messageSettings.senderName,
        senderEmailSnapshot: messageSettings.senderEmail,
        replyToEmailSnapshot: messageSettings.replyToEmail,
        subjectSnapshot: `Permission needed: team members 18 and over on ${label}`,
        bodyTextSnapshot: bodyText,
        metadata: { trigger: "TEAM_PERMISSION_REQUEST", deliveryMode: messageSettings.deliveryMode, realDelivery: messageSettings.deliveryMode === "EXTERNAL_EMAIL", confirmationCode: registration.confirmationCode, people: input.people.length },
        idempotencyKey: `team-permission:${input.registrationId}:${idempotencyHash(input.people.map((person) => person.attendeeId))}:${email}`,
        correlationId: randomUUID(),
        status: suppressed ? "SUPPRESSED" : "PENDING",
        lastError: suppressed ? "Delivery is disabled for this event." : null,
      },
      select: { id: true, status: true },
    });
    if (message.status === "PENDING") ids.push(message.id);
  }
  return ids;
}

/** Delivery runs after the transaction commits and never rolls a committed change back; a failure leaves the message queued. */
export async function deliverPermissionMessages(messageIds: readonly string[]) {
  if (messageIds.length === 0) return;
  try {
    await processQueuedMessageIdsAfterCommit([...messageIds]);
  } catch (error) {
    logError("A team permission request could not be delivered right now; it stays queued.", error);
  }
}

export type TeamPermissionRow = {
  id: string;
  eventId: string;
  eventName: string;
  registrationId: string;
  clubEventRegistrationId: string;
  teamLabel: string;
  locationName: string | null;
  name: string;
  age: number;
  status: PermissionStatus;
  decidedAt: string | null;
  decidedBy: string | null;
};

const rowSelect = {
  id: true, eventId: true, clubEventRegistrationId: true, status: true, ageOnAgeDate: true, decidedAt: true,
  decidedByUser: { select: { displayName: true } },
  decidedByAccount: { select: { displayName: true } },
  attendee: { select: { profileSnapshot: true } },
  clubEventRegistration: {
    select: {
      registrationId: true, teamName: true,
      organization: { select: { name: true } },
      registration: { select: { location: { select: { name: true } }, event: { select: { name: true } } } },
    },
  },
} satisfies Prisma.ClubTeamMemberPermissionSelect;

type RowShape = Prisma.ClubTeamMemberPermissionGetPayload<{ select: typeof rowSelect }>;

function personName(snapshot: unknown) {
  const record = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : {};
  return `${typeof record.firstName === "string" ? record.firstName : ""} ${typeof record.lastName === "string" ? record.lastName : ""}`.trim() || "Someone";
}

function toRow(row: RowShape): TeamPermissionRow {
  return {
    id: row.id,
    eventId: row.eventId,
    eventName: row.clubEventRegistration.registration.event.name,
    registrationId: row.clubEventRegistration.registrationId,
    clubEventRegistrationId: row.clubEventRegistrationId,
    teamLabel: teamLabel(row.clubEventRegistration.organization.name, row.clubEventRegistration.teamName),
    locationName: row.clubEventRegistration.registration.location?.name ?? null,
    name: personName(row.attendee.profileSnapshot),
    age: row.ageOnAgeDate,
    status: row.status,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedByUser?.displayName ?? row.decidedByAccount?.displayName ?? null,
  };
}

const statusOrder: Record<PermissionStatus, number> = { PENDING: 0, DECLINED: 1, GRANTED: 2 };
const byUrgency = (a: TeamPermissionRow, b: TeamPermissionRow) => statusOrder[a.status] - statusOrder[b.status] || a.teamLabel.localeCompare(b.teamLabel) || a.name.localeCompare(b.name);

/** Every flag on an event's active teams, pending first, for staff who manage registrations. */
export async function listEventTeamPermissions(eventId: string): Promise<TeamPermissionRow[]> {
  const rows = await getPrisma().clubTeamMemberPermission.findMany({
    where: { eventId, clubEventRegistration: { registration: { status: { in: ["SUBMITTED", "CONFIRMED", "WAITLISTED"] } } } },
    select: rowSelect,
  });
  return rows.map(toRow).sort(byUrgency);
}

/**
 * The flags on teams registered at a location this Area Coordinator is set as the coordinator of, while their grant is
 * active and their account enabled. Nothing for anyone else.
 */
export async function listCoordinatorTeamPermissions(accountId: string, now = new Date()): Promise<TeamPermissionRow[]> {
  const rows = await getPrisma().clubTeamMemberPermission.findMany({
    where: {
      clubEventRegistration: {
        registration: {
          status: { in: ["SUBMITTED", "CONFIRMED", "WAITLISTED"] },
          location: { is: { coordinatorAccountId: accountId, coordinator: { is: { disabledAt: null, areaCoordinatorGrant: { is: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } } } } } },
        },
      },
    },
    select: rowSelect,
  });
  return rows.map(toRow).sort(byUrgency);
}

/** Flags for one team, by attendee, for the team page and the printed form. */
export async function permissionsForRegistration(clubEventRegistrationId: string, client: Pick<Tx, "clubTeamMemberPermission"> = getPrisma()) {
  const rows = await client.clubTeamMemberPermission.findMany({
    where: { clubEventRegistrationId },
    select: { registrationAttendeeId: true, status: true, decidedAt: true, decidedByUser: { select: { displayName: true } }, decidedByAccount: { select: { displayName: true } } },
  });
  return new Map(rows.map((row) => [row.registrationAttendeeId, {
    status: row.status as PermissionStatus,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedByUser?.displayName ?? row.decidedByAccount?.displayName ?? null,
  }]));
}

/** The sentences a director is shown for a team's flags (pending and declined; granted ones are reassurance, shown too), by registration. */
export async function permissionNoticesForRegistration(registrationId: string): Promise<string[]> {
  const rows = await getPrisma().clubTeamMemberPermission.findMany({
    where: { clubEventRegistration: { registrationId } },
    orderBy: { createdAt: "asc" },
    select: { status: true, attendee: { select: { profileSnapshot: true } } },
  });
  return rows.map((row) => permissionNotice(row.status, personName(row.attendee.profileSnapshot)));
}

/** Pending flags per team of an event, for the results report. */
export async function pendingPermissionCounts(eventId: string): Promise<Map<string, number>> {
  const groups = await getPrisma().clubTeamMemberPermission.groupBy({ by: ["clubEventRegistrationId"], where: { eventId, status: "PENDING" }, _count: { _all: true } });
  return new Map(groups.map((group) => [group.clubEventRegistrationId, group._count._all]));
}

/**
 * Grants or declines one flag. Staff who manage the event's registrations decide any flag of their event; an Area
 * Coordinator decides flags of teams at their own locations (checked by the caller through `scope`). Audited with who
 * decided and the status before and after. A decision can be changed later.
 */
export async function decideTeamPermission(input: {
  permissionId: string;
  decision: PermissionDecision;
  actor: { userId: string } | { accountId: string };
  scope: { eventId: string } | { coordinatorAccountId: string };
  now?: Date;
}): Promise<TeamPermissionRow> {
  const now = input.now ?? new Date();
  return getPrisma().$transaction(async (tx) => {
    const found = await tx.clubTeamMemberPermission.findFirst({
      where: {
        id: input.permissionId,
        ...("eventId" in input.scope
          ? { eventId: input.scope.eventId }
          : { clubEventRegistration: { registration: { location: { is: { coordinatorAccountId: input.scope.coordinatorAccountId, coordinator: { is: { disabledAt: null, areaCoordinatorGrant: { is: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } } } } } } } } }),
      },
      select: rowSelect,
    });
    if (!found) throw new ClubTeamError("REGISTRATION_NOT_FOUND", "That permission request was not found.");
    const before = found.status;
    if (before !== input.decision) {
      await tx.clubTeamMemberPermission.update({
        where: { id: input.permissionId },
        data: {
          status: input.decision,
          decidedAt: now,
          decidedByUserId: "userId" in input.actor ? input.actor.userId : null,
          decidedByAccountId: "accountId" in input.actor ? input.actor.accountId : null,
        },
      });
      const row = toRow(found);
      await writeAuditLog({
        eventId: found.eventId,
        actorUserId: "userId" in input.actor ? input.actor.userId : undefined,
        action: input.decision === "GRANTED" ? "CLUB_TEAM_PERMISSION_GRANTED" : "CLUB_TEAM_PERMISSION_DECLINED",
        entityType: "ClubTeamMemberPermission",
        entityId: found.id,
        summary: `${input.decision === "GRANTED" ? "Granted" : "Declined"} permission for ${row.name} (${row.age}) to be a team member of ${row.teamLabel}.`,
        metadata: { before, after: input.decision, ...("accountId" in input.actor ? { decidedByAccountId: input.actor.accountId } : {}) },
      }, tx);
    }
    const after = await tx.clubTeamMemberPermission.findUniqueOrThrow({ where: { id: input.permissionId }, select: rowSelect });
    return toRow(after);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
