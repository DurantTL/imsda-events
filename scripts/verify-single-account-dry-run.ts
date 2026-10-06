/**
 * Proves the single-account dry run (#554) against a real PostgreSQL database:
 * it seeds synthetic staff/attendee pairs and conflicts, runs the dry run,
 * asserts the report, and asserts that NO row changed anywhere it could have
 * (row counts, newest updatedAt, and a checksum of every row, before and
 * after). It also proves the database itself refuses a write inside the
 * dry run's read-only transaction. Fictitious rows only; it removes them.
 *
 *   npm run test:single-account-dry-run
 */
import { execFileSync } from "node:child_process";
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import { runSingleAccountDryRun, withReadOnlyTransaction } from "../modules/account-merge/dry-run";
import type { DryRunReport } from "../modules/account-merge/dry-run-domain";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "sadry";
const id = (name: string) => `${P}_${name}`;
const email = (name: string) => `${P}.${name}@example.test`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

const PAST = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date(Date.now() + 86_400_000);
const HASH = "synthetic-not-a-real-hash";

const userIds = ["clean", "conflict", "disabled", "unverified", "staffonly", "dupa", "dupb", "pending", "solo1", "solo2"].map(id);
const accountIds = ["clean", "conflict", "disabled", "unverified", "attonly", "dup", "pending", "twin1", "twin2"].map(id);

async function cleanup() {
  await prisma.registration.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.organization.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.attendeeAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.event.deleteMany({ where: { id: { startsWith: P } } });
}

/** Tables the dry run reads, or that a bug could plausibly touch. */
const TABLES = [
  "User", "AttendeeAccount", "AuthCredential", "AttendeeCredential", "UserSession", "AttendeeSession",
  "EventMembership", "AuditLog", "UserPasskey", "AttendeePasskey", "UserMfaEnrollment",
  "AttendeeMfaEnrollment", "MfaRecoveryCode", "AttendeeMfaRecoveryCode", "ClubDirectorGrant",
  "AreaCoordinatorGrant", "AttendeeIdentity", "UserPersonLink", "AttendeeAccountPersonLink",
  "Registration", "Person", "StaffActAs", "MessageOutbox",
] as const;

type Snapshot = Record<string, { count: number; newestUpdatedAt: string | null; checksum: string }>;

async function snapshot(): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const table of TABLES) {
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
      table,
    );
    const hasUpdatedAt = columns.some((column) => column.column_name === "updatedAt");
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint; newest: Date | null; checksum: string }>>(
      `SELECT COUNT(*)::bigint AS count,
              ${hasUpdatedAt ? 'MAX(t."updatedAt")' : "NULL::timestamp"} AS newest,
              md5(coalesce(string_agg(t::text, '|' ORDER BY t."id"), '')) AS checksum
       FROM "${table}" t`,
    );
    result[table] = {
      count: Number(rows[0].count),
      newestUpdatedAt: rows[0].newest ? rows[0].newest.toISOString() : null,
      checksum: rows[0].checksum,
    };
  }
  return result;
}

async function seed() {
  await prisma.event.create({
    data: { id: id("event"), slug: `${P}-event`, name: "Dry Run Test Event", startsAt: FUTURE, endsAt: FUTURE },
  });

  // A clean pair: same email, same name, staff password and MFA, an attendee with registrations.
  await prisma.user.create({
    data: {
      id: id("clean"), email: email("clean"), displayName: "Casey Clean", globalRole: "SYSTEM_ADMIN",
      credential: { create: { passwordHash: HASH } },
      mfaEnrollment: { create: { sealedSecret: "synthetic", status: "ACTIVE" } },
      sessions: { create: { tokenHash: `${P}_sess_clean`, expiresAt: FUTURE } },
    },
  });
  await prisma.attendeeAccount.create({
    data: { id: id("clean"), email: email("clean"), displayName: "Casey Clean", status: "ACTIVE", emailVerifiedAt: PAST },
  });

  // A pair with review-level conflicts: two passwords, two authenticators, a different name, passkeys on both.
  await prisma.user.create({
    data: {
      id: id("conflict"), email: email("conflict"), displayName: "Robin Staff",
      credential: { create: { passwordHash: HASH } },
      mfaEnrollment: { create: { sealedSecret: "synthetic", status: "ACTIVE", lockedUntil: FUTURE } },
      passkeys: { create: { credentialId: `${P}_pk_staff`, publicKey: Buffer.from("x"), deviceType: "singleDevice", name: "Synthetic" } },
    },
  });
  await prisma.attendeeAccount.create({
    data: {
      id: id("conflict"), email: email("conflict"), displayName: "Roberta Attendee", status: "ACTIVE", emailVerifiedAt: PAST,
      credential: { create: { passwordHash: HASH } },
      mfaEnrollment: { create: { sealedSecret: "synthetic", status: "ACTIVE" } },
      passkeys: { create: { credentialId: `${P}_pk_att`, publicKey: Buffer.from("y"), deviceType: "singleDevice", name: "Synthetic" } },
      identities: { create: { provider: "GOOGLE", subject: `${P}_google`, email: email("conflict") } },
      sessions: { create: { tokenHash: `${P}_sess_att`, expiresAt: FUTURE } },
    },
  });

  // A pair where the attendee account is disabled.
  // A staff role with no authenticator and no passkey.
  await prisma.user.create({ data: { id: id("disabled"), email: email("disabled"), displayName: "Dana Disabled", globalRole: "SYSTEM_ADMIN" } });
  await prisma.attendeeAccount.create({
    data: { id: id("disabled"), email: email("disabled"), displayName: "Dana Disabled", status: "ACTIVE", emailVerifiedAt: PAST, disabledAt: PAST },
  });

  // A pair where the attendee email was never verified.
  await prisma.user.create({ data: { id: id("unverified"), email: email("unverified"), displayName: "Uma Unverified" } });
  await prisma.attendeeAccount.create({
    data: { id: id("unverified"), email: email("unverified"), displayName: "Uma Unverified" },
  });

  // A staff user who was invited and never activated, with a matching attendee.
  await prisma.user.create({
    data: { id: id("pending"), email: email("pending"), displayName: "Pia Pending", accountStatus: "PENDING_ACTIVATION" },
  });
  await prisma.attendeeAccount.create({
    data: { id: id("pending"), email: email("pending"), displayName: "Pia Pending", status: "ACTIVE", emailVerifiedAt: PAST },
  });

  // Unpaired on each side.
  await prisma.user.create({ data: { id: id("staffonly"), email: email("staffonly"), displayName: "Sam Staffonly" } });
  await prisma.attendeeAccount.create({
    data: { id: id("attonly"), email: email("attonly"), displayName: "Alex Attendeeonly", status: "ACTIVE", emailVerifiedAt: PAST },
  });

  // Two staff rows whose emails differ only by case: ambiguous, never paired.
  await prisma.user.create({ data: { id: id("dupa"), email: `${P}.dup@example.test`, displayName: "Dup One" } });
  await prisma.user.create({ data: { id: id("dupb"), email: `${P}.DUP@example.test`, displayName: "Dup Two" } });
  await prisma.attendeeAccount.create({
    data: { id: id("dup"), email: `${P}.dup@example.test`, displayName: "Dup One", status: "ACTIVE", emailVerifiedAt: PAST },
  });

  // Same-side duplicates with no counterpart on the other side: ambiguous, never staff-only/attendee-only.
  await prisma.user.create({ data: { id: id("solo1"), email: `${P}.solo@example.test`, displayName: "Solo One" } });
  await prisma.user.create({ data: { id: id("solo2"), email: `${P}.SOLO@example.test`, displayName: "Solo Two" } });
  await prisma.attendeeAccount.create({ data: { id: id("twin1"), email: `${P}.twin@example.test`, displayName: "Twin One", status: "ACTIVE", emailVerifiedAt: PAST } });
  await prisma.attendeeAccount.create({ data: { id: id("twin2"), email: `${P}.TWIN@example.test`, displayName: "Twin Two", status: "ACTIVE", emailVerifiedAt: PAST } });

  // Audit rows on the staff side, and registrations reachable by the clean pair's email.
  await prisma.auditLog.createMany({
    data: [1, 2, 3].map((n) => ({
      actorUserId: id("clean"), action: "synthetic.test", entityType: "Test", correlationId: `${P}_corr_${n}`, summary: "synthetic",
    })),
  });
  const person = await prisma.person.create({
    data: { id: id("person"), firstName: "Casey", lastName: "Clean", normalizedEmail: email("clean") },
  });
  for (const n of [1, 2]) {
    await prisma.registration.create({
      data: {
        id: id(`reg${n}`),
        eventId: id("event"),
        accountHolderPersonId: person.id,
        confirmationCode: `${P}-${n}`,
        status: "CONFIRMED",
        totalAmount: "25.00",
        contactSnapshot: { email: email("clean") },
      },
    });
  }
}

function pairFor(report: DryRunReport, name: string) {
  const pair = report.pairs.find((candidate) => candidate.staffUserId === id(name));
  assert(pair, `pair ${name} present`);
  return pair;
}

const codesOf = (report: DryRunReport, name: string) => pairFor(report, name).conflicts.map((conflict) => conflict.code);

async function main() {
  await cleanup();
  await seed();
  const before = await snapshot();

  const report = await runSingleAccountDryRun(prisma, { showEmails: false });

  // 1. Pairing and the unpaired counts (the database may hold other, seeded rows).
  const mine = report.pairs.filter((pair) => pair.staffUserId.startsWith(`${P}_`));
  assert(mine.length === 5, `five synthetic pairs, got ${mine.length}`);
  assert(report.summary.pairs >= 5 && report.summary.staffOnly >= 1 && report.summary.attendeeOnly >= 1, "summary counts the unpaired sides");
  assert(report.summary.ambiguousGroups >= 1 && report.ambiguous.some((group) => group.staffIds.includes(id("dupa"))), "case-duplicate staff rows are ambiguous, not paired");
  assert(!report.pairs.some((pair) => pair.staffUserId === id("dupa") || pair.staffUserId === id("dupb")), "ambiguous rows are never paired");
  assert(!report.pairs.some((pair) => pair.staffUserId === id("staffonly")), "staff-only is not a pair");
  const ambiguousIds = report.ambiguous.map((group) => [...group.staffIds, ...group.attendeeIds]).flat();
  for (const name of ["solo1", "solo2", "twin1", "twin2"]) {
    assert(ambiguousIds.includes(id(name)), `${name} is ambiguous even with no counterpart`);
  }
  console.log("ok  pairs by normalised email; staff-only, attendee-only and ambiguous (including same-side duplicates) counted apart");

  // 2. Conflicts.
  assert(pairFor(report, "clean").status === "clean", "clean pair is clean");
  const conflict = codesOf(report, "conflict");
  for (const code of ["BOTH_HAVE_PASSWORD", "MFA_BOTH_ENROLLED", "NAME_MISMATCH", "PASSKEYS_ON_BOTH", "ATTENDEE_GOOGLE_IDENTITY"]) {
    assert(conflict.includes(code as never), `conflict pair reports ${code}, got ${conflict.join(",")}`);
  }
  assert(conflict.includes("MFA_LOCKED" as never), "authenticator lockout reported");
  assert(pairFor(report, "conflict").status === "needs-review", "conflict pair needs review");
  assert(codesOf(report, "disabled").includes("STAFF_NO_SECOND_FACTOR" as never), "staff role without a second factor blocks");
  assert(codesOf(report, "disabled").includes("ATTENDEE_DISABLED") && pairFor(report, "disabled").status === "blocked", "disabled attendee blocks");
  assert(codesOf(report, "unverified").includes("ATTENDEE_EMAIL_UNVERIFIED") && pairFor(report, "unverified").status === "blocked", "unverified email blocks");
  assert(codesOf(report, "pending").includes("STAFF_NOT_ACTIVATED"), "never-activated staff blocks");
  console.log("ok  conflicts: passwords, MFA, names, passkeys, Google, disabled, unverified, not activated");

  // 3. Linked-row counts.
  const clean = pairFor(report, "clean");
  assert(clean.staff.globalRole === "SYSTEM_ADMIN", "staff globalRole reported");
  assert(clean.staff.auditRows === 3, `staff audit rows 3, got ${clean.staff.auditRows}`);
  assert(clean.staff.sessions === 1, `staff active sessions 1, got ${clean.staff.sessions}`);
  const conflictPair = pairFor(report, "conflict");
  assert(conflictPair.staff.passkeys === 1 && conflictPair.attendee.passkeys === 1, "passkey counts on each side");
  assert(conflictPair.attendee.sessions === 1, "attendee active sessions 1");
  const registrationsSeeded = await prisma.registration.count({ where: { id: { startsWith: P } } });
  assert(clean.attendee.registrations === registrationsSeeded, `registrations ${registrationsSeeded}, got ${clean.attendee.registrations}`);
  console.log("ok  per-side counts: registrations, roles, passkeys, sessions, audit rows");

  // 4. Masking, and the flag that lifts it.
  const json = JSON.stringify(report);
  assert(!json.includes(`${P}.clean@example.test`) && !json.includes("Casey Clean"), "default output holds no full email or name");
  assert(clean.email === "s***@e***.test", `masked email, got ${clean.email}`);
  const shown = await runSingleAccountDryRun(prisma, { showEmails: true });
  assert(pairFor(shown, "clean").email === email("clean"), "--show-emails shows the full address");
  const cli = (...args: string[]) =>
    execFileSync("npx", ["tsx", "scripts/single-account-dry-run.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const cliJson = JSON.parse(cli("--json")) as DryRunReport;
  assert(cliJson.readOnly === true && cliJson.emailsShown === false, "CLI --json is masked");
  assert(!JSON.stringify(cliJson).includes(`${P}.`), "CLI --json holds no full synthetic email");
  assert(/Single-account dry run/.test(cli()), "CLI text output");
  console.log("ok  masked by default; full emails only with --show-emails; CLI --json works");

  // 5. The database refuses writes inside the dry run's transaction.
  const refused = await withReadOnlyTransaction(prisma, async (tx) =>
    tx.user.create({ data: { id: id("illegal"), email: email("illegal"), displayName: "Illegal" } }).then(() => null, (error: unknown) => error),
  );
  assert(refused !== null, "a write inside the read-only transaction must fail");
  const text = String((refused as Error).message);
  assert(/read-only transaction|25006/i.test(text), `expected PostgreSQL read-only error, got ${text}`);
  assert(!(refused instanceof Prisma.PrismaClientValidationError), "refusal came from the database, not the client");
  assert((await prisma.user.count({ where: { id: id("illegal") } })) === 0, "the refused write left no row");
  console.log("ok  PostgreSQL refuses writes inside the dry-run transaction (25006)");

  // 6. Nothing changed: counts, newest updatedAt, and a checksum of every row.
  const after = await snapshot();
  for (const table of TABLES) {
    assert(before[table].count === after[table].count, `${table}: row count changed ${before[table].count} -> ${after[table].count}`);
    assert(before[table].newestUpdatedAt === after[table].newestUpdatedAt, `${table}: newest updatedAt changed`);
    assert(before[table].checksum === after[table].checksum, `${table}: row contents changed`);
  }
  console.log(`ok  no row changed in ${TABLES.length} tables (counts, updatedAt and checksums identical before and after)`);
}

main()
  .then(async () => {
    await cleanup();
    console.log("single-account dry run verified");
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
