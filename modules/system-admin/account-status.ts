import "server-only";

import { getPrisma } from "@/lib/prisma";

/**
 * Turns an account's sign-in on or off across the whole platform.
 *
 * `AuthCredential.disabledAt` already stopped a sign-in and already invalidated
 * a live session — but nothing ever set it. Every reference was a read, so an
 * account, once created, could sign in forever. Removing someone from an event
 * took away what they could reach; it never took away the ability to get in.
 *
 * Disabling rather than deleting, deliberately. A person's rows are referenced
 * by audit entries, published announcements, and message template versions —
 * the record of who did what, which is meant to outlive their access. Deleting
 * the account would either destroy that history or fail against the constraints
 * protecting it.
 */
export class AccountStatusError extends Error {
  constructor(
    public readonly code:
      | "ACCOUNT_NOT_FOUND"
      | "CANNOT_DISABLE_SELF"
      | "LAST_SYSTEM_ADMIN"
      | "NO_CREDENTIAL",
    message: string,
  ) {
    super(message);
    this.name = "AccountStatusError";
  }
}

export function refusesAccountDisable(input: {
  targetUserId: string;
  actorUserId: string;
  targetIsSystemAdmin: boolean;
  otherEnabledSystemAdminCount: number;
}) {
  // Locking yourself out is never the intent, and it is the one mistake nobody
  // can undo from inside the application.
  if (input.targetUserId === input.actorUserId) return "CANNOT_DISABLE_SELF" as const;
  // The last way in has to stay open, or the platform needs a database console
  // to recover.
  if (input.targetIsSystemAdmin && input.otherEnabledSystemAdminCount === 0) {
    return "LAST_SYSTEM_ADMIN" as const;
  }
  return null;
}

export async function setAccountDisabled(
  targetUserId: string,
  disabled: boolean,
  actorUserId: string,
) {
  const prisma = getPrisma();
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      displayName: true,
      email: true,
      globalRole: true,
      credential: { select: { id: true, disabledAt: true } },
    },
  });
  if (!target) {
    throw new AccountStatusError("ACCOUNT_NOT_FOUND", "That account no longer exists.");
  }
  if (!target.credential) {
    throw new AccountStatusError(
      "NO_CREDENTIAL",
      "That account has never been activated, so it has no sign-in to disable.",
    );
  }

  if (disabled) {
    const otherEnabledSystemAdminCount = await prisma.user.count({
      where: {
        globalRole: "SYSTEM_ADMIN",
        id: { not: targetUserId },
        credential: { is: { disabledAt: null } },
      },
    });
    const refusal = refusesAccountDisable({
      targetUserId,
      actorUserId,
      targetIsSystemAdmin: target.globalRole === "SYSTEM_ADMIN",
      otherEnabledSystemAdminCount,
    });
    if (refusal === "CANNOT_DISABLE_SELF") {
      throw new AccountStatusError(
        "CANNOT_DISABLE_SELF",
        "You cannot disable your own sign-in. Ask another system administrator.",
      );
    }
    if (refusal === "LAST_SYSTEM_ADMIN") {
      throw new AccountStatusError(
        "LAST_SYSTEM_ADMIN",
        "This is the only system administrator who can still sign in. Give another account that role first.",
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.authCredential.update({
      where: { id: target.credential!.id },
      data: { disabledAt: disabled ? new Date() : null },
    });
    if (disabled) {
      // A disabled account with a live session is still signed in until that
      // session is next checked. Revoking now closes the door immediately.
      await tx.userSession.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: disabled ? "ACCOUNT_SIGN_IN_DISABLED" : "ACCOUNT_SIGN_IN_ENABLED",
        entityType: "User",
        entityId: targetUserId,
        correlationId: `account-status:${targetUserId}:${Date.now()}`,
        summary: disabled
          ? `Disabled sign-in for ${target.email} and revoked their sessions.`
          : `Restored sign-in for ${target.email}.`,
        metadata: { targetUserId, displayName: target.displayName, disabled },
      },
    });
  });
}
