/**
 * Removes an account's second factor from the command line.
 *
 * MFA is enforced at sign-in for administrators, which means a lost
 * authenticator with no recovery codes left is a locked-out account and there
 * is no self-service way back. This is that way back, and it deliberately
 * requires shell access to the deployment: the person running it is already
 * trusted with the database.
 *
 * The account is not left without a second factor for long — its next sign-in
 * enrols a new one, because the role still requires it.
 *
 * Usage:
 *   npm run admin:reset-mfa -- --email you@imsda.org
 */
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());

function usage(message: string): never {
  console.error(`${message}

Usage:
  npm run admin:reset-mfa -- --email <address>

  --email  The account whose authenticator should be removed.`);
  process.exit(1);
}

function parseEmail(argv: string[]) {
  const index = argv.indexOf("--email");
  const value = index === -1 ? undefined : argv[index + 1];
  const email = value?.trim().toLowerCase() ?? "";
  if (!email) usage("--email is required.");
  return email;
}

async function main() {
  const email = parseEmail(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, displayName: true, mfaEnrollment: { select: { id: true } } },
    });
    if (!user) usage(`No account exists for ${email}.`);
    if (!user.mfaEnrollment) {
      console.log(`${email} has no authenticator enrolled. Nothing to remove.`);
      return;
    }

    await prisma.$transaction(async (tx) => {
      // Recovery codes cascade with the enrolment.
      await tx.userMfaEnrollment.delete({ where: { id: user.mfaEnrollment!.id } });
      // Any half-finished sign-in is retired, and so is every live session:
      // whoever reset this must not inherit a session that predates it.
      await tx.mfaChallenge.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          action: "MFA_RESET_BY_OPERATOR",
          entityType: "User",
          entityId: user.id,
          correlationId: randomUUID(),
          summary: `The authenticator for ${email} was removed from the command line.`,
          metadata: { email, viaScript: true, sessionsRevoked: true },
        },
      });
    });

    console.log(`
Removed the authenticator for ${user.displayName} <${email}>.
Every session for that account was signed out.

If the account administers events it will be asked to enrol a new authenticator
on its next sign-in, before any session is issued.
`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
