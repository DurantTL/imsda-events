/**
 * Proves a copy of SECRET_ENCRYPTION_KEY can open data from a restored backup.
 *
 * A key backup that has never been used to read anything is an untested
 * assumption. Run this against a SCRATCH database restored from a dump (see
 * "Keeping and testing the key backup" in docs/DEPLOY-DOCKER.md), with the key
 * supplied from the BACKUP copy (SECRET_ENCRYPTION_KEY_FILE pointing at it)
 * rather than from the production file.
 *
 *   1. Canary: seals and opens a fixed synthetic string, which proves the key
 *      loaded and the cipher works.
 *   2. Restored data: opens one sealed authenticator secret from the scratch
 *      database. That proves the backup key is the key the data was sealed with.
 *
 * It needs only the key (SECRET_ENCRYPTION_KEY_FILE or SECRET_ENCRYPTION_KEY)
 * and, unless --canary-only, DATABASE_URL. It does not load the full server
 * environment, so it runs without the other production secrets. It prints
 * pass/fail only: never the key, a plaintext, a sealed value or the database
 * URL. It refuses any database whose name is not `restore_check` or does not
 * end in `_restore_check`.
 *
 * Usage:
 *   npm run key:restore-check                     # DATABASE_URL = scratch database
 *   npm run key:restore-check -- --canary-only    # no database needed
 */
import { resolveEncryptionKey } from "../../lib/env";
import { MIN_SECRET_KEY_LENGTH, openSecretWithKey, sealSecretWithKey } from "../../lib/secret-box";

// Must match SECRET_PURPOSE in modules/access/mfa-service.ts.
const MFA_PURPOSE = "mfa-totp-secret";
const CANARY = "synthetic-canary-not-a-secret";
const CANARY_PURPOSE = "key-restore-canary";

export type KeyRestoreCheckOptions = {
  env: Record<string, string | undefined>;
  canaryOnly: boolean;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Returns one sealed authenticator secret from the scratch database, or null if none. */
  readSealedValue: (databaseUrl: string) => Promise<string | null>;
};

export function isScratchDatabaseName(name: string) {
  return name === "restore_check" || name.endsWith("_restore_check");
}

/** Returns the process exit code. */
export async function runKeyRestoreCheck(options: KeyRestoreCheckOptions): Promise<number> {
  const { env, log } = options;
  const fail = (message: string) => {
    options.error(`[key-restore-check] FAILED: ${message}`);
    return 1;
  };

  const resolved = resolveEncryptionKey(env);
  if (!resolved.ok) return fail(resolved.issue);
  const key = resolved.key;
  if (!key) {
    return fail("no encryption key is configured. Set SECRET_ENCRYPTION_KEY_FILE to the backup copy of the key.");
  }
  if (key.length < MIN_SECRET_KEY_LENGTH) {
    return fail(`the key is shorter than ${MIN_SECRET_KEY_LENGTH} characters, so it cannot be the production key.`);
  }
  log(`[key-restore-check] key loaded from ${resolved.source === "file" ? "a file" : "the environment"}`);

  try {
    if (openSecretWithKey(sealSecretWithKey(CANARY, CANARY_PURPOSE, key), CANARY_PURPOSE, key) !== CANARY) {
      return fail("the canary value did not round-trip");
    }
  } catch {
    return fail("the canary value did not round-trip");
  }
  log("[key-restore-check] canary seal and open: ok");

  if (options.canaryOnly) {
    log("[key-restore-check] PASSED (canary only; no restored data was read)");
    return 0;
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) return fail("DATABASE_URL must point at the scratch database.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    return fail("DATABASE_URL is not a valid URL.");
  }
  if (!isScratchDatabaseName(databaseName)) {
    return fail(`DATABASE_URL points at "${databaseName}", which is not a scratch database (its name must be restore_check or end in _restore_check).`);
  }

  let sealed: string | null;
  try {
    sealed = await options.readSealedValue(databaseUrl);
  } catch {
    return fail("could not read from the scratch database (details withheld).");
  }
  if (!sealed) {
    return fail("the restored database has no authenticator enrolment to read. Use a dump taken after an administrator enrolled.");
  }
  try {
    openSecretWithKey(sealed, MFA_PURPOSE, key);
  } catch {
    return fail("the key could NOT open a sealed value from the restored database. This is not the key that sealed it.");
  }
  log("[key-restore-check] opened one sealed value from the restored database: ok");
  log("[key-restore-check] PASSED");
  return 0;
}

async function readSealedValueFromPrisma(databaseUrl: string) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const row = await prisma.userMfaEnrollment.findFirst({ select: { sealedSecret: true } });
    return row?.sealedSecret ?? null;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("verify-key-restore.ts")) {
  runKeyRestoreCheck({
    env: process.env,
    canaryOnly: process.argv.includes("--canary-only"),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    readSealedValue: readSealedValueFromPrisma,
  })
    .catch(() => {
      console.error("[key-restore-check] FAILED: unexpected error (details withheld)");
      return 1;
    })
    .then((code) => process.exit(code));
}
