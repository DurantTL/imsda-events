/**
 * The supported way to get from a fresh deploy to a real administrator account.
 *
 * A brand-new database has zero users and there is no first-run setup screen,
 * so this is the only legitimate cold-start path. It writes exactly one row set
 * — a user, its pending credential, and a one-time activation token — and no
 * fictitious operational data. `prisma/seed.ts` remains demo data and refuses
 * to run outside a local database.
 *
 * Usage:
 *   npm run admin:create -- --email you@imsda.org --name "Your Name"
 *
 * The activation URL is printed once, to stdout. Nothing stores it: only the
 * SHA-256 digest of the token reaches the database.
 */
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../modules/access/passwords";
import { createOpaqueToken, hashOpaqueToken } from "../modules/access/tokens";

loadEnvConfig(process.cwd());

const ACTIVATION_LIFETIME_MINUTES = 7 * 24 * 60;

type Options = {
  email: string;
  displayName: string;
  promoteExisting: boolean;
};

function usage(message: string): never {
  console.error(`${message}

Usage:
  npm run admin:create -- --email <address> --name "<display name>" [--promote-existing]

  --email             The administrator's real email address.
  --name              The name shown in the workspace and in audit entries.
  --promote-existing  Allow promoting an account that already exists.`);
  process.exit(1);
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  let promoteExisting = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--promote-existing") {
      promoteExisting = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match) usage(`Unrecognised argument: ${argument}`);
    const [, key, inlineValue] = match;
    const value = inlineValue ?? argv[++index];
    if (value === undefined) usage(`--${key} needs a value.`);
    values.set(key, value);
  }

  const email = values.get("email")?.trim().toLowerCase() ?? "";
  const displayName = values.get("name")?.trim() ?? "";

  if (!email) usage("--email is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) usage(`--email is not a valid address: ${email}`);
  if (displayName.length < 2) usage("--name is required and must be at least 2 characters.");

  return { email, displayName, promoteExisting };
}

function appBaseUrl() {
  const configured = process.env.APP_BASE_URL?.trim();
  if (!configured) {
    throw new Error(
      "APP_BASE_URL must be set so the activation link points at the real deployment.",
    );
  }
  return new URL(configured).origin;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const baseUrl = appBaseUrl();
  const prisma = new PrismaClient();

  try {
    const existing = await prisma.user.findUnique({
      where: { email: options.email },
      select: { id: true, globalRole: true, accountStatus: true },
    });

    if (existing && !options.promoteExisting) {
      throw new Error(
        `${options.email} already exists. Re-run with --promote-existing to make it a system administrator and issue a fresh activation link.`,
      );
    }

    // Nobody is ever handed a password. The account is created
    // PENDING_ACTIVATION holding a random hash that no one knows, and its owner
    // sets the first password through the activation link below.
    const unusableHash = await hashPassword(`${createOpaqueToken()}-pending-activation`);
    const token = createOpaqueToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ACTIVATION_LIFETIME_MINUTES * 60 * 1000);

    const user = await prisma.$transaction(async (tx) => {
      const record = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              displayName: options.displayName,
              globalRole: "SYSTEM_ADMIN",
              accountStatus: "PENDING_ACTIVATION",
              activatedAt: null,
            },
            select: { id: true, email: true, displayName: true },
          })
        : await tx.user.create({
            data: {
              email: options.email,
              displayName: options.displayName,
              globalRole: "SYSTEM_ADMIN",
              accountStatus: "PENDING_ACTIVATION",
            },
            select: { id: true, email: true, displayName: true },
          });

      await tx.authCredential.upsert({
        where: { userId: record.id },
        update: {
          passwordHash: unusableHash,
          passwordUpdatedAt: now,
          failedAttempts: 0,
          lockedUntil: null,
          disabledAt: null,
        },
        create: { userId: record.id, passwordHash: unusableHash },
      });

      // Any activation or reset link already outstanding for this account is
      // consumed, so exactly one link is live at a time.
      await tx.passwordResetToken.updateMany({
        where: { userId: record.id, usedAt: null },
        data: { usedAt: now },
      });
      await tx.passwordResetToken.create({
        data: {
          userId: record.id,
          tokenHash: hashOpaqueToken(token),
          purpose: "ACCOUNT_ACTIVATION",
          expiresAt,
        },
      });

      await tx.userSession.updateMany({
        where: { userId: record.id, revokedAt: null },
        data: { revokedAt: now },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: record.id,
          action: existing ? "SYSTEM_ADMIN_PROMOTED" : "SYSTEM_ADMIN_BOOTSTRAPPED",
          entityType: "User",
          entityId: record.id,
          correlationId: randomUUID(),
          summary: `${record.displayName} was granted SYSTEM_ADMIN from the command line.`,
          metadata: { email: record.email, viaBootstrapScript: true, promotedExisting: Boolean(existing) },
        },
      });

      return record;
    });

    const activationUrl = new URL(
      `/reset-password?token=${encodeURIComponent(token)}`,
      baseUrl,
    ).toString();

    console.log(`
${existing ? "Promoted" : "Created"} system administrator: ${user.displayName} <${user.email}>

The account is PENDING_ACTIVATION and cannot sign in until a password is set.
Open this one-time link to activate it. It expires ${expiresAt.toISOString()}.

  ${activationUrl}

This link is shown once and is not recoverable — only its digest is stored.
`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
