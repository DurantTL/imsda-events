import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { ClubTeamError } from "@/modules/club-teams/errors";
import {
  levelInfoFromJson,
  teamSettingsInputSchema,
  type TeamSettings,
} from "@/modules/club-teams/domain";

type Client = Pick<Prisma.TransactionClient, "eventTeamSettings">;

function toSettings(row: {
  allowMultipleTeams: boolean;
  minTeamMembers: number | null;
  maxTeamMembers: number | null;
  maxAlternates: number;
  ageAsOf: string | null;
  maxMemberAge: number | null;
  booksLine: string;
  levelInfo: unknown;
}): TeamSettings {
  return {
    allowMultipleTeams: row.allowMultipleTeams,
    minTeamMembers: row.minTeamMembers,
    maxTeamMembers: row.maxTeamMembers,
    maxAlternates: row.maxAlternates,
    ageAsOf: row.ageAsOf,
    maxMemberAge: row.maxMemberAge,
    booksLine: row.booksLine,
    levelInfo: levelInfoFromJson(row.levelInfo),
  };
}

/** The event's team rules (#809), or null for an event that does not use teams: one registration per club, no limits. */
export async function getTeamSettings(eventId: string, client: Client = getPrisma()): Promise<TeamSettings | null> {
  const row = await client.eventTeamSettings.findUnique({ where: { eventId } });
  return row ? toSettings(row) : null;
}

/** A Serializable transaction that lost a race (P2034) is run again, a few times, before it is given up on. */
async function retrySerialization<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") || attempt >= 2) throw error;
    }
  }
}

/**
 * Sets an event's team rules (CONFIGURE_EVENT, audited). The guards keep an event
 * from ending up with registrations its own rules cannot describe:
 * - only a club event has teams;
 * - several teams cannot be turned off once any club has more than one registration or a named team;
 * - they cannot be turned on while registrations without a team name exist, or the event has classes
 *   (class picking works on one registration per club).
 */
export async function saveTeamSettings(eventId: string, actorUserId: string, rawInput: unknown): Promise<TeamSettings> {
  const input = teamSettingsInputSchema.parse(rawInput);
  return retrySerialization(() => getPrisma().$transaction(async (tx) => {
    // The lock a club's draft save takes shared, and a Serializable transaction: a club registration or draft that races this
    // save either sees the new rules or makes this save fail and try again, never slips between the checks and the write.
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR NO KEY UPDATE`;
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true, audience: true, name: true } });
    if (!event) throw new ClubTeamError("EVENT_NOT_FOUND", "That event could not be found.");
    if (event.audience !== "CLUB") throw new ClubTeamError("NOT_A_CLUB_EVENT", "Team settings are for club events.");
    const existing = await tx.eventTeamSettings.findUnique({ where: { eventId } });
    if (input.allowMultipleTeams && !existing?.allowMultipleTeams) {
      const [unnamed, classes, drafts] = await Promise.all([
        tx.clubEventRegistration.count({ where: { eventId, teamKey: "" } }),
        tx.honorOffering.count({ where: { eventId } }),
        tx.clubRegistrationDraft.count({ where: { eventId, draftKey: "" } }),
      ]);
      if (drafts > 0) {
        throw new ClubTeamError("DRAFTS_IN_PROGRESS", `${drafts === 1 ? "A club has" : `${drafts} clubs have`} started a registration for this event without submitting it. Those drafts can't carry over to teams, so they need to be submitted, or removed, before the event switches to teams.`);
      }
      if (unnamed > 0) {
        throw new ClubTeamError("REGISTRATIONS_WITHOUT_TEAM", "Clubs have already registered for this event without a team name, so it cannot switch to named teams.");
      }
      if (classes > 0) {
        throw new ClubTeamError("CLASSES_NOT_SUPPORTED", "This event has classes, which a club picks once for its one registration, so it cannot take several teams per club.");
      }
    }
    if (!input.allowMultipleTeams && existing?.allowMultipleTeams) {
      const named = await tx.clubEventRegistration.count({ where: { eventId, teamKey: { not: "" } } });
      if (named > 0) {
        throw new ClubTeamError("TEAMS_IN_USE", "Teams have already registered for this event, so several teams per club cannot be turned off.");
      }
    }
    const data = {
      allowMultipleTeams: input.allowMultipleTeams,
      minTeamMembers: input.minTeamMembers,
      maxTeamMembers: input.maxTeamMembers,
      maxAlternates: input.maxAlternates,
      ageAsOf: input.ageAsOf,
      maxMemberAge: input.maxMemberAge,
      booksLine: input.booksLine,
      levelInfo: input.levelInfo as unknown as Prisma.InputJsonValue,
    };
    const saved = await tx.eventTeamSettings.upsert({ where: { eventId }, create: { eventId, ...data }, update: data });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "EVENT_TEAM_SETTINGS_UPDATED",
      entityType: "EventTeamSettings",
      entityId: eventId,
      summary: `Updated the team rules for ${event.name}.`,
      metadata: {
        before: existing ? toSettings(existing) : null,
        after: toSettings(saved),
      } as unknown as Prisma.InputJsonValue,
    }, tx);
    return toSettings(saved);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 }));
}

/** Removes an event's team rules, back to one registration per club. Refused while teams are registered. */
export async function removeTeamSettings(eventId: string, actorUserId: string): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    const existing = await tx.eventTeamSettings.findUnique({ where: { eventId } });
    if (!existing) return;
    const named = await tx.clubEventRegistration.count({ where: { eventId, teamKey: { not: "" } } });
    if (named > 0) throw new ClubTeamError("TEAMS_IN_USE", "Teams have already registered for this event, so its team rules cannot be removed.");
    await tx.eventTeamSettings.delete({ where: { eventId } });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "EVENT_TEAM_SETTINGS_REMOVED",
      entityType: "EventTeamSettings",
      entityId: eventId,
      summary: "Removed the event's team rules.",
      metadata: { before: toSettings(existing) } as unknown as Prisma.InputJsonValue,
    }, tx);
  });
}
