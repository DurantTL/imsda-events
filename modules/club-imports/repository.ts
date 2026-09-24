import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { churchStem, importScope, type ClubImportDraft } from "@/modules/club-imports/domain";
import type { ClubImportItem } from "@/modules/club-imports/schemas";
import { normalizeOrganizationName } from "@/modules/organizations/domain";

/**
 * Club import storage (#376). The export itself is never stored: the preview
 * is computed and returned, and the confirm step receives only what the
 * administrator kept. Each club imports in its own transaction, so one bad
 * row never blocks the rest. Audit entries carry counts, never names.
 */

function nameKey(firstName: string, lastName: string) {
  return `${firstName} ${lastName}`.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/** What the preview needs to know about the directory: church matches, existing clubs, earlier imports. */
export async function annotateImportDrafts(drafts: ClubImportDraft[]) {
  const prisma = getPrisma();
  const [churches, clubs, identities] = await Promise.all([
    prisma.organization.findMany({ where: { type: "CHURCH", isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.organization.findMany({ where: { type: "CLUB" }, select: { id: true, name: true, normalizedName: true, isActive: true } }),
    prisma.externalIdentity.findMany({
      where: { provider: "FLUENT_FORMS", externalId: { in: drafts.map((draft) => draft.entryId) } },
      select: { externalId: true, providerScope: true, organization: { select: { id: true, name: true } } },
    }),
  ]);
  const churchByStem = new Map<string, { id: string; name: string }>();
  for (const church of churches) {
    const stem = churchStem(church.name);
    if (stem && !churchByStem.has(stem)) churchByStem.set(stem, church);
  }
  const clubByName = new Map(clubs.map((club) => [club.normalizedName, club]));

  return {
    churches,
    drafts: drafts.map((draft) => {
      const imported = identities.find((identity) => identity.externalId === draft.entryId && identity.providerScope === importScope(draft.clubYear));
      const church = churchByStem.get(churchStem(draft.churchName)) ?? null;
      const club = clubByName.get(normalizeOrganizationName(draft.clubName)) ?? null;
      return {
        ...draft,
        churchId: church?.id ?? null,
        newChurchName: church ? "" : draft.churchName,
        alreadyImported: imported?.organization ? { id: imported.organization.id, name: imported.organization.name } : null,
        existingClub: club ? { id: club.id, name: club.name, isActive: club.isActive } : null,
      };
    }),
  };
}

export type AnnotatedImportDraft = Awaited<ReturnType<typeof annotateImportDrafts>>["drafts"][number];

export type ClubImportResult = {
  sourceKey: string;
  clubName: string;
  status: "IMPORTED" | "ALREADY_IMPORTED" | "FAILED";
  message: string;
  organizationId: string | null;
  membersAdded: number;
  membersSkipped: number;
  invitesCreated: number;
};

class ImportRefused extends Error {}

async function importOne(item: ClubImportItem, actorUserId: string, now: Date): Promise<ClubImportResult> {
  const scope = importScope(item.clubYear);
  const base = { sourceKey: item.sourceKey, clubName: item.clubName, membersAdded: 0, membersSkipped: 0, invitesCreated: 0 };
  const prisma = getPrisma();

  const earlier = await prisma.externalIdentity.findUnique({
    where: { provider_providerScope_externalId: { provider: "FLUENT_FORMS", providerScope: scope, externalId: item.entryId } },
    select: { organizationId: true },
  });
  if (earlier) {
    return { ...base, status: "ALREADY_IMPORTED", message: "This registration was imported before. Nothing was changed.", organizationId: earlier.organizationId };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      let churchId: string | null = null;
      let churchCreated = false;
      if (item.churchId) {
        const church = await tx.organization.findUnique({ where: { id: item.churchId }, select: { type: true, isActive: true } });
        if (!church || church.type !== "CHURCH" || !church.isActive) throw new ImportRefused("The chosen church is no longer available.");
        churchId = item.churchId;
      } else if (item.newChurchName) {
        const normalizedName = normalizeOrganizationName(item.newChurchName);
        const existing = await tx.organization.findFirst({ where: { type: "CHURCH", normalizedName }, select: { id: true, isActive: true } });
        if (existing && !existing.isActive) throw new ImportRefused("A church with that name is inactive. Reactivate it or choose another.");
        if (existing) {
          churchId = existing.id;
        } else {
          const church = await tx.organization.create({ data: { type: "CHURCH", name: item.newChurchName, normalizedName }, select: { id: true } });
          churchId = church.id;
          churchCreated = true;
        }
      }

      // Every club has a sponsoring church; church-billed events invoice it.
      if (!churchId) throw new ImportRefused("Choose or create the club's sponsoring church before importing.");

      const normalizedName = normalizeOrganizationName(item.clubName);
      let club = await tx.organization.findFirst({ where: { type: "CLUB", normalizedName }, select: { id: true, isActive: true, parentOrganizationId: true } });
      if (club && !club.isActive) throw new ImportRefused("A club with that name is inactive. Reactivate it first, or give the import another name.");
      const clubCreated = !club;
      if (!club) {
        club = await tx.organization.create({
          data: { type: "CLUB", name: item.clubName, normalizedName, parentOrganizationId: churchId },
          select: { id: true, isActive: true, parentOrganizationId: true },
        });
      } else if (!club.parentOrganizationId) {
        await tx.organization.update({ where: { id: club.id }, data: { parentOrganizationId: churchId } });
      }

      const yearImport = await tx.externalIdentity.findUnique({
        where: { organizationId_provider_providerScope: { organizationId: club.id, provider: "FLUENT_FORMS", providerScope: scope } },
        select: { id: true },
      });
      if (yearImport) throw new ImportRefused(`This club already has an imported registration for ${item.clubYear}.`);
      await tx.externalIdentity.create({
        data: {
          organizationId: club.id,
          provider: "FLUENT_FORMS",
          providerScope: scope,
          externalId: item.entryId,
          displayLabel: `Yearly club registration, ${item.clubYear}`,
          lastVerifiedAt: now,
        },
      });

      const existing = await tx.clubRosterMember.findMany({
        where: { organizationId: club.id, clubYear: item.clubYear, status: { not: "REMOVED" } },
        select: { person: { select: { firstName: true, lastName: true } } },
      });
      const seen = new Set(existing.filter((row) => row.person).map((row) => nameKey(row.person!.firstName, row.person!.lastName)));
      let membersAdded = 0;
      let membersSkipped = 0;
      for (const person of item.people) {
        const key = nameKey(person.firstName, person.lastName);
        if (seen.has(key)) {
          membersSkipped += 1;
          continue;
        }
        seen.add(key);
        const created = await tx.person.create({ data: { firstName: person.firstName, lastName: person.lastName }, select: { id: true } });
        await tx.clubRosterMember.create({
          data: {
            organizationId: club.id,
            clubYear: item.clubYear,
            personId: created.id,
            attendeeType: person.attendeeType,
            role: person.role,
            classLevel: person.classLevel,
            reportedAge: person.reportedAge,
            source: "IMPORT",
          },
        });
        membersAdded += 1;
      }

      let invitesCreated = 0;
      for (const invite of item.invites) {
        const open = await tx.clubInvite.findFirst({
          where: { organizationId: club.id, email: invite.email, status: { in: ["PENDING", "SENT"] } },
          select: { id: true },
        });
        const grant = await tx.clubDirectorGrant.findFirst({
          where: {
            organizationId: club.id,
            revokedAt: null,
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            attendeeAccount: { email: invite.email },
          },
          select: { id: true },
        });
        if (open || grant) continue;
        await tx.clubInvite.create({
          data: { organizationId: club.id, email: invite.email, name: invite.name, role: invite.role, source: "IMPORT", createdByUserId: actorUserId },
        });
        invitesCreated += 1;
      }

      await writeAuditLog({
        actorUserId,
        action: "CLUB_IMPORTED",
        entityType: "Organization",
        entityId: club.id,
        summary: clubCreated ? "Imported a club from the yearly registration form." : "Imported a yearly registration into an existing club.",
        metadata: {
          organizationId: club.id,
          sourceKey: item.sourceKey,
          clubYear: item.clubYear,
          clubCreated,
          churchCreated,
          membersAdded,
          membersSkipped,
          invitesCreated,
        },
      }, tx);

      return {
        ...base,
        status: "IMPORTED" as const,
        message: clubCreated ? "Club created." : "Added to the existing club.",
        organizationId: club.id,
        membersAdded,
        membersSkipped,
        invitesCreated,
      };
    });
  } catch (error) {
    if (error instanceof ImportRefused) return { ...base, status: "FAILED", message: error.message, organizationId: null };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ...base, status: "ALREADY_IMPORTED", message: "This registration was imported at the same moment by another request.", organizationId: null };
    }
    throw error;
  }
}

export async function importClubs(items: ClubImportItem[], actorUserId: string, now = new Date()) {
  const results: ClubImportResult[] = [];
  for (const item of items) results.push(await importOne(item, actorUserId, now));
  return results;
}
