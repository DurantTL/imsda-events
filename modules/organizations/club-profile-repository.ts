import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import type { ClubProfileInput } from "@/modules/organizations/club-profile-schemas";
import { normalizeOrganizationName } from "@/modules/organizations/domain";
import { OrganizationOperationError } from "@/modules/organizations/repository";

/**
 * Club profile (#375): the club's name, sponsoring church, meeting details,
 * and public contact. Edited by the club's director or deputy, or by
 * conference staff. Every save is audited with the fields that changed.
 */

export type ClubProfileActor = { userId: string } | { accountId: string };

const profileFields = ["meetingPlace", "meetingSchedule", "contactEmail", "contactPhone", "publicDescription", "listPublicly"] as const;

export async function getClubProfile(organizationId: string) {
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      type: true,
      name: true,
      isActive: true,
      parentOrganization: { select: { id: true, name: true } },
      clubProfile: true,
    },
  });
  if (!club || club.type !== "CLUB") return null;
  const profile = club.clubProfile;
  return {
    id: club.id,
    name: club.name,
    isActive: club.isActive,
    sponsoringChurchId: club.parentOrganization?.id ?? null,
    sponsoringChurchName: club.parentOrganization?.name ?? null,
    meetingPlace: profile?.meetingPlace ?? "",
    meetingSchedule: profile?.meetingSchedule ?? "",
    contactEmail: profile?.contactEmail ?? "",
    contactPhone: profile?.contactPhone ?? "",
    publicDescription: profile?.publicDescription ?? "",
    listPublicly: profile?.listPublicly ?? false,
    updatedAt: profile?.updatedAt.toISOString() ?? null,
  };
}

export type ClubProfileRecord = NonNullable<Awaited<ReturnType<typeof getClubProfile>>>;

/** Active churches a club may name as its sponsor, plus the club's current one even if inactive. */
export async function listChurchOptions(currentChurchId: string | null = null) {
  const churches = await getPrisma().organization.findMany({
    where: { type: "CHURCH", OR: [{ isActive: true }, ...(currentChurchId ? [{ id: currentChurchId }] : [])] },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  return churches;
}

export async function updateClubProfile(organizationId: string, input: ClubProfileInput, actor: ClubProfileActor) {
  await getPrisma().$transaction(async (tx) => {
    const club = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, type: true, name: true, parentOrganizationId: true, clubProfile: true },
    });
    if (!club || club.type !== "CLUB") {
      throw new OrganizationOperationError("ORGANIZATION_NOT_FOUND", "That club could not be found.");
    }
    if (input.sponsoringChurchId !== null && input.sponsoringChurchId !== club.parentOrganizationId) {
      const church = await tx.organization.findUnique({
        where: { id: input.sponsoringChurchId },
        select: { type: true, isActive: true },
      });
      if (!church || church.type !== "CHURCH" || !church.isActive) {
        throw new OrganizationOperationError("ORGANIZATION_PARENT_INVALID", "Choose an active church as the club's sponsoring church.");
      }
    }

    const changed: string[] = [];
    if (input.name !== club.name) changed.push("name");
    if (input.sponsoringChurchId !== club.parentOrganizationId) changed.push("sponsoringChurch");
    for (const field of profileFields) {
      const before = club.clubProfile?.[field] ?? (field === "listPublicly" ? false : "");
      if (input[field] !== before) changed.push(field);
    }
    if (changed.length === 0) return;

    await tx.organization.update({
      where: { id: organizationId },
      data: {
        name: input.name,
        normalizedName: normalizeOrganizationName(input.name),
        parentOrganizationId: input.sponsoringChurchId,
      },
    });
    const details = {
      meetingPlace: input.meetingPlace,
      meetingSchedule: input.meetingSchedule,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      publicDescription: input.publicDescription,
      listPublicly: input.listPublicly,
    };
    await tx.clubProfile.upsert({
      where: { organizationId },
      create: { organizationId, ...details },
      update: details,
    });
    await writeAuditLog({
      ...("userId" in actor ? { actorUserId: actor.userId } : {}),
      action: "CLUB_PROFILE_UPDATED",
      entityType: "Organization",
      entityId: organizationId,
      summary: `Updated the club profile for ${input.name}.`,
      metadata: {
        organizationId,
        fields: changed,
        ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : {}),
      },
    }, tx);
  });
  return getClubProfile(organizationId);
}
