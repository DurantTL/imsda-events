import "server-only";

import { Prisma, type TeamResultLevel } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { ClubTeamError } from "@/modules/club-teams/errors";
import { teamLabel, type TeamLevel } from "@/modules/club-teams/domain";
import {
  emptyResults,
  resultIsBlank,
  teamResultInputSchema,
  type TeamResultsRow,
  type TeamResultView,
} from "@/modules/club-teams/results-domain";

type Result = { level: TeamResultLevel; placement: string; qualified: boolean; notes: string; updatedAt: Date };

function view(result: Result): TeamResultView {
  return { level: result.level, placement: result.placement, qualified: result.qualified, notes: result.notes, updatedAt: result.updatedAt.toISOString() };
}

/**
 * The results report (#809): every team of the event that holds a place (submitted or confirmed), with its result at each
 * level. Teams are the club's registrations on an event with teams; on any other club event each club is one row.
 */
export async function listTeamResults(eventId: string): Promise<TeamResultsRow[]> {
  const rows = await getPrisma().clubEventRegistration.findMany({
    where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
    orderBy: [{ organization: { name: "asc" } }, { teamKey: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      teamName: true,
      organization: { select: { name: true, parentOrganization: { select: { name: true } } } },
      registration: { select: { confirmationCode: true, status: true, location: { select: { name: true } } } },
      teamResults: { select: { level: true, placement: true, qualified: true, notes: true, updatedAt: true } },
    },
  });
  return rows.map((row) => {
    const results = emptyResults();
    for (const result of row.teamResults) results[result.level] = view(result);
    return {
      clubEventRegistrationId: row.id,
      teamName: row.teamName ?? "",
      clubName: row.organization.name,
      church: row.organization.parentOrganization?.name ?? null,
      confirmationCode: row.registration.confirmationCode,
      status: row.registration.status,
      locationName: row.registration.location?.name ?? null,
      results,
    };
  });
}

/** The results for one team, for its director (read only) and the print form. Nothing here ever changes them. */
export async function getResultsForRegistration(clubEventRegistrationId: string): Promise<Record<TeamLevel, TeamResultView | null>> {
  const rows = await getPrisma().clubTeamResult.findMany({
    where: { clubEventRegistrationId },
    select: { level: true, placement: true, qualified: true, notes: true, updatedAt: true },
  });
  const results = emptyResults();
  for (const row of rows) results[row.level] = view(row);
  return results;
}

/**
 * Staff enters, changes or clears one level of a team's result (#809). A result with nothing in it clears the level.
 * Every change is audited with the values before and after; saving what is already stored writes and audits nothing.
 * The registration must belong to this event and hold a place.
 */
export async function saveTeamResult(
  eventId: string,
  clubEventRegistrationId: string,
  rawInput: unknown,
  actorUserId: string,
): Promise<{ result: TeamResultView | null; changed: boolean }> {
  const input = teamResultInputSchema.parse(rawInput);
  return getPrisma().$transaction(async (tx) => {
    // Results belong to events that run teams; an event without team rules has none to enter.
    const teamEvent = await tx.eventTeamSettings.findUnique({ where: { eventId }, select: { eventId: true } });
    if (!teamEvent) throw new ClubTeamError("RESULT_INVALID", "This event doesn't use team rules, so it has no team results.");
    const team = await tx.clubEventRegistration.findFirst({
      where: { id: clubEventRegistrationId, eventId },
      select: { teamName: true, organization: { select: { name: true } }, registration: { select: { status: true } } },
    });
    if (!team) throw new ClubTeamError("REGISTRATION_NOT_FOUND", "That team is not registered for this event.");
    if (team.registration.status !== "SUBMITTED" && team.registration.status !== "CONFIRMED") {
      throw new ClubTeamError("RESULT_INVALID", "Results can only be entered for a team that is registered, not one that is waitlisted or cancelled.");
    }
    const where = { clubEventRegistrationId_level: { clubEventRegistrationId, level: input.level } };
    const existing = await tx.clubTeamResult.findUnique({ where });
    const label = teamLabel(team.organization.name, team.teamName);
    const metadata = (before: Result | null, after: Pick<Result, "placement" | "qualified" | "notes"> | null) => ({
      clubEventRegistrationId,
      level: input.level,
      before: before ? { placement: before.placement, qualified: before.qualified, notes: before.notes } : null,
      after,
    }) as Prisma.InputJsonValue;

    if (resultIsBlank(input)) {
      if (!existing) return { result: null, changed: false };
      await tx.clubTeamResult.delete({ where });
      await writeAuditLog({
        eventId, actorUserId, action: "CLUB_TEAM_RESULT_CLEARED", entityType: "ClubTeamResult", entityId: existing.id,
        summary: `Cleared the ${input.level.toLowerCase()} result for ${label}.`, metadata: metadata(existing, null),
      }, tx);
      return { result: null, changed: true };
    }
    if (existing && existing.placement === input.placement && existing.qualified === input.qualified && existing.notes === input.notes) {
      return { result: view(existing), changed: false };
    }
    const saved = await tx.clubTeamResult.upsert({
      where,
      create: { clubEventRegistrationId, level: input.level, placement: input.placement, qualified: input.qualified, notes: input.notes, updatedByUserId: actorUserId },
      update: { placement: input.placement, qualified: input.qualified, notes: input.notes, updatedByUserId: actorUserId },
    });
    await writeAuditLog({
      eventId, actorUserId, action: existing ? "CLUB_TEAM_RESULT_UPDATED" : "CLUB_TEAM_RESULT_ENTERED", entityType: "ClubTeamResult", entityId: saved.id,
      summary: `${existing ? "Updated" : "Entered"} the ${input.level.toLowerCase()} result for ${label}.`,
      metadata: metadata(existing, { placement: saved.placement, qualified: saved.qualified, notes: saved.notes }),
    }, tx);
    return { result: view(saved), changed: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
