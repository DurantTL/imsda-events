import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";

const optionalProfileField = (maximum: number) => z.string().trim().max(maximum);

export const teamProfileSchema = z.strictObject({
  displayName: z.string().trim().min(2).max(100),
  jobTitle: optionalProfileField(120),
  phone: optionalProfileField(40),
  bio: optionalProfileField(1_000),
});

export type TeamProfileInput = z.infer<typeof teamProfileSchema>;

export class TeamProfileError extends Error {
  constructor(
    public readonly code: "ACCOUNT_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "TeamProfileError";
  }
}

export async function updateTeamProfile(
  targetUserId: string,
  actorUserId: string,
  input: TeamProfileInput,
) {
  const profile = teamProfileSchema.parse(input);
  return getPrisma().$transaction(async (tx) => {
    const before = await tx.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        email: true,
        displayName: true,
        jobTitle: true,
        phone: true,
        bio: true,
      },
    });
    if (!before) {
      throw new TeamProfileError(
        "ACCOUNT_NOT_FOUND",
        "That team account no longer exists.",
      );
    }

    const after = await tx.user.update({
      where: { id: targetUserId },
      data: {
        displayName: profile.displayName,
        jobTitle: profile.jobTitle || null,
        phone: profile.phone || null,
        bio: profile.bio || null,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        jobTitle: true,
        phone: true,
        bio: true,
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: "STAFF_PROFILE_UPDATED",
        entityType: "User",
        entityId: targetUserId,
        correlationId: randomUUID(),
        summary: `Updated the team profile for ${after.displayName}.`,
        metadata: {
          targetUserId,
          email: before.email,
          before: {
            displayName: before.displayName,
            jobTitle: before.jobTitle,
            phone: before.phone,
            bio: before.bio,
          },
          after: {
            displayName: after.displayName,
            jobTitle: after.jobTitle,
            phone: after.phone,
            bio: after.bio,
          },
        },
      },
    });
    return after;
  });
}
