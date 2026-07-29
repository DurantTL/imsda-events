import "server-only";

import { getPrisma } from "@/lib/prisma";
import { logInfo } from "@/lib/logger";
import type { GoogleIdentity } from "@/integrations/oauth/google";
import { normalizeAttendeeEmail } from "@/modules/attendee-accounts/account-service";
import { createAttendeeSession } from "@/modules/attendee-accounts/session-store";

/**
 * Turning a verified Google identity into an attendee session.
 *
 * The rule underneath all of it: an account claims registrations by verified
 * email, so anything that attaches an identity to an account has to be at least
 * as strong as the emailed code it replaces. Google asserting `email_verified`
 * for an address it is authoritative for is stronger — it is the mail provider
 * saying so, rather than us inferring it from someone reading a message.
 */

export type FederatedSignIn =
  | {
    outcome: "signed-in";
    accountId: string;
    linkage:
      | "existing-identity"
      | "linked-to-password-account"
      | "claimed-pending"
      | "rebound-google-only"
      | "created";
    session: { token: string; expiresAt: Date };
  }
  | { outcome: "refused"; reason: "unverified-email" | "account-disabled" | "identity-conflict" };

export async function signInWithGoogle(
  identity: GoogleIdentity,
  userAgent: string | null,
  now = new Date(),
): Promise<FederatedSignIn> {
  // An unverified address claims nothing. Google will hand one over for an
  // account that merely typed an address in, and treating that as proof would
  // give away somebody else's registrations.
  if (!identity.emailVerified) return { outcome: "refused", reason: "unverified-email" };

  const email = normalizeAttendeeEmail(identity.email);
  const prisma = getPrisma();

  const existing = await prisma.attendeeIdentity.findUnique({
    where: { provider_subject: { provider: "GOOGLE", subject: identity.subject } },
    select: { id: true, accountId: true, account: { select: { disabledAt: true } } },
  });

  if (existing) {
    if (existing.account.disabledAt) return { outcome: "refused", reason: "account-disabled" };
    await prisma.attendeeIdentity.update({
      where: { id: existing.id },
      data: { lastUsedAt: now, email },
    });
    return {
      outcome: "signed-in",
      accountId: existing.accountId,
      linkage: "existing-identity",
      session: await createAttendeeSession(existing.accountId, userAgent),
    };
  }

  const account = await prisma.attendeeAccount.findUnique({
    where: { email },
    select: {
      id: true,
      status: true,
      disabledAt: true,
      credential: { select: { id: true } },
      identities: { where: { provider: "GOOGLE" }, select: { id: true } },
    },
  });

  if (account?.disabledAt) return { outcome: "refused", reason: "account-disabled" };

  if (!account) {
    const created = await prisma.attendeeAccount.create({
      data: {
        email,
        displayName: identity.name ?? email,
        // Google has already established what our own code exists to establish.
        // Asking for a second proof of the same fact is friction with no answer.
        status: "ACTIVE",
        emailVerifiedAt: now,
        identities: {
          create: { provider: "GOOGLE", subject: identity.subject, email, lastUsedAt: now },
        },
      },
      select: { id: true },
    });
    return {
      outcome: "signed-in",
      accountId: created.id,
      linkage: "created",
      session: await createAttendeeSession(created.id, userAgent),
    };
  }

  // A Google-only account can be deleted and recreated at the same address,
  // which gives it a new subject. The address is the claim this application
  // protects, and Google's verified assertion is at least as strong as the
  // emailed code that would otherwise prove it. Rebinding is therefore safe
  // only for an active account with no password fallback: a mixed-method
  // account can sign in with its password and must not have an identity changed
  // merely because another Google subject asserted the same address.
  if (account.identities.length > 0) {
    if (account.status === "ACTIVE" && !account.credential) {
      await prisma.$transaction([
        prisma.attendeeIdentity.update({
          where: { id: account.identities[0].id },
          data: { subject: identity.subject, email, lastUsedAt: now },
        }),
        prisma.attendeeAccountToken.updateMany({
          where: { accountId: account.id, usedAt: null },
          data: { usedAt: now },
        }),
        prisma.attendeeSession.updateMany({
          where: { accountId: account.id, revokedAt: null },
          data: { revokedAt: now },
        }),
      ]);
      logInfo("A verified Google assertion rebound a Google-only attendee account.", {
        accountId: account.id,
      });
      return {
        outcome: "signed-in",
        accountId: account.id,
        linkage: "rebound-google-only",
        session: await createAttendeeSession(account.id, userAgent),
      };
    }
    return { outcome: "refused", reason: "identity-conflict" };
  }

  const claimingPending = account.status !== "ACTIVE";

  const linked = await prisma.$transaction(async (tx) => {
    await tx.attendeeIdentity.create({
      data: {
        accountId: account.id,
        provider: "GOOGLE",
        subject: identity.subject,
        email,
        lastUsedAt: now,
      },
    });

    if (!claimingPending) return "linked-to-password-account" as const;

    // The account was created by a password sign-up that never verified the
    // address — so whoever set that password never proved they could read this
    // inbox, and may well not be the person now signing in with Google.
    // Activating it as-is would leave their password live on a verified
    // account: the pre-hijacking attack, where someone claims an address in
    // advance and waits for the real owner to federate onto it.
    //
    // The password is therefore destroyed rather than kept, and every session
    // is revoked. Whoever set it can set a new one through recovery, which
    // requires reading this inbox.
    if (account.credential) {
      await tx.attendeeCredential.delete({ where: { id: account.credential.id } });
    }
    await tx.attendeeAccountToken.updateMany({
      where: { accountId: account.id, usedAt: null },
      data: { usedAt: now },
    });
    await tx.attendeeSession.updateMany({
      where: { accountId: account.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.attendeeAccount.update({
      where: { id: account.id },
      data: { status: "ACTIVE", emailVerifiedAt: now },
    });
    return "claimed-pending" as const;
  });

  if (linked === "claimed-pending") {
    // Worth a line in the log: it is the one path that destroys a credential,
    // and if it ever fires in volume that is an attack in progress.
    logInfo("A Google sign-in claimed an attendee account whose sign-up was never verified.", {
      accountId: account.id,
      discardedPassword: Boolean(account.credential),
    });
  }

  return {
    outcome: "signed-in",
    accountId: account.id,
    linkage: linked,
    session: await createAttendeeSession(account.id, userAgent),
  };
}
