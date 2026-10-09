/**
 * Proves a copy of SECRET_ENCRYPTION_KEY can open data from a restored backup.
 *
 * A key backup that has never been used to read anything is an untested
 * assumption. Run this against a SCRATCH database restored from a dump (see
 * "Testing the key backup" in docs/DEPLOY-DOCKER.md), with the key supplied
 * from the BACKUP copy (SECRET_ENCRYPTION_KEY_FILE pointing at it) rather than
 * from the production file.
 *
 *   1. Canary: seals and opens a fixed synthetic string, which proves the key
 *      loaded and the cipher works.
 *   2. Restored data: opens one sealed authenticator secret from the scratch
 *      database. That proves the backup key is the key the data was sealed with.
 *
 * It prints pass/fail only. It never prints the key, a plaintext, or a sealed
 * value, and it refuses to run against a database named like the live one.
 *
 * Usage (DATABASE_URL must point at the scratch database):
 *   npm run key:restore-check
 *   npm run key:restore-check -- --canary-only     # no database needed
 */
import { PrismaClient } from "@prisma/client";
import { getEncryptionKeyStatus, getServerEnv, resolveEncryptionKey } from "../../lib/env";
import { openSecret, sealSecret } from "../../lib/secret-box";

// Must match SECRET_PURPOSE in modules/access/mfa-service.ts.
const MFA_PURPOSE = "mfa-totp-secret";
const CANARY = "synthetic-canary-not-a-secret";

function fail(message: string): never {
  console.error(`[key-restore-check] FAILED: ${message}`);
  process.exit(1);
}

async function main() {
  const resolved = resolveEncryptionKey();
  if (!resolved.ok) fail(resolved.issue);
  const status = getEncryptionKeyStatus();
  if (!status.configured) {
    fail("no encryption key is configured. Set SECRET_ENCRYPTION_KEY_FILE to the backup copy of the key.");
  }
  try {
    getServerEnv();
  } catch (error) {
    fail(error instanceof Error ? error.message : "the environment is not valid");
  }
  console.log(`[key-restore-check] key loaded from ${status.source === "file" ? "a file" : "the environment"}`);

  if (openSecret(sealSecret(CANARY, "key-restore-canary"), "key-restore-canary") !== CANARY) {
    fail("the canary value did not round-trip");
  }
  console.log("[key-restore-check] canary seal and open: ok");

  if (process.argv.includes("--canary-only")) {
    console.log("[key-restore-check] PASSED (canary only; no restored data was read)");
    return;
  }

  const databaseName = new URL(getServerEnv().DATABASE_URL).pathname.replace(/^\//, "");
  if (!/restore|scratch|check|test/i.test(databaseName)) {
    fail(`DATABASE_URL points at "${databaseName}", which does not look like a scratch database (its name must contain restore, scratch, check or test).`);
  }

  const prisma = new PrismaClient();
  try {
    const enrollment = await prisma.userMfaEnrollment.findFirst({ select: { sealedSecret: true } });
    if (!enrollment) {
      fail("the restored database has no authenticator enrolment to read. Use a dump taken after an administrator enrolled.");
    }
    try {
      openSecret(enrollment.sealedSecret, MFA_PURPOSE);
    } catch {
      fail("the key could NOT open a sealed value from the restored database. This is not the key that sealed it.");
    }
    console.log("[key-restore-check] opened one sealed value from the restored database: ok");
  } finally {
    await prisma.$disconnect();
  }
  console.log("[key-restore-check] PASSED");
}

main().catch(() => fail("unexpected error (details withheld so no sealed value is printed)"));
