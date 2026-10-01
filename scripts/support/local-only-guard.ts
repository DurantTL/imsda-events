/**
 * Shared refusal rules for scripts that write fictitious data or mint
 * sessions. They run only against a local database, never in production.
 * `prisma/seed.ts` and `scripts/verify-badge-print.ts` both use this, and it
 * must stay free of Prisma and session-store imports so it can run first.
 */
const localHostnames = ["localhost", "127.0.0.1", "::1", "[::1]"];

export function isLocalHostname(hostname: string) {
  return localHostnames.includes(hostname.toLowerCase());
}

type Env = Record<string, string | undefined>;

/** Throws unless NODE_ENV is not production and DATABASE_URL points at this machine. */
export function assertLocalDatabase(env: Env = process.env, action = "run this script") {
  if (env.NODE_ENV === "production") {
    throw new Error(`Refusing to ${action} with NODE_ENV=production.`);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(`Refusing to ${action}: DATABASE_URL is not a valid URL.`);
  }
  if (!isLocalHostname(hostname)) {
    throw new Error(`Refusing to ${action} outside a local database (received ${hostname}).`);
  }
}

/** Throws unless the URL points at this machine. */
export function assertLocalUrl(value: string, name: string) {
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (!isLocalHostname(hostname)) {
    throw new Error(`Refusing to use ${name} outside localhost (received ${hostname}).`);
  }
}

/** Throws unless the email is one of the seeded @imsda-events.test accounts. */
export function assertSeededStaffEmail(email: string) {
  if (!/^[^@\s]+@imsda-events\.test$/i.test(email)) {
    throw new Error(`Refusing to sign in as ${email}: only seeded @imsda-events.test accounts are allowed.`);
  }
}
