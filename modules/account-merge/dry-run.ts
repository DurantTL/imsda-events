import { Prisma, type PrismaClient } from "@prisma/client";
import {
  buildReport,
  pairKey,
  type AttendeeAccountRow,
  type DryRunReport,
  type MfaState,
  type StaffAccountRow,
} from "./dry-run-domain";

/**
 * Loads every staff `User` and `AttendeeAccount` for the single-account dry
 * run (#554). READ-ONLY by construction:
 *
 *  - everything runs inside one transaction that starts with
 *    `SET TRANSACTION READ ONLY`, so PostgreSQL itself refuses any write
 *    (error 25006) even if this file were edited to attempt one;
 *  - the transaction is REPEATABLE READ, so the counts are one consistent
 *    snapshot;
 *  - only `find*`, `count` and `$queryRaw` are used (a test enforces it).
 *
 * It selects counts, ids and booleans: never names, phones, hashes or secrets.
 * Display names are compared inside PostgreSQL and only "they differ" comes
 * back. Registrations are counted in SQL per account, so guest emails (people
 * with no account) are never loaded.
 */

export type ReadOnlyTransaction = Prisma.TransactionClient;

export async function withReadOnlyTransaction<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  run: (tx: ReadOnlyTransaction) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // Must be the first statement of the transaction.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return run(tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 10_000,
      timeout: 300_000,
    },
  );
}

function mfaState(enrollment: { status: "PENDING" | "ACTIVE" } | null): MfaState {
  return enrollment ? enrollment.status : "NONE";
}

/**
 * Registrations reachable by each account's verified email, counted in SQL and
 * joined to the account so only (accountId, count) comes back. This is the same
 * rule `registrations-repository.ts` uses to decide what an account may see:
 * the contact email in the snapshot, falling back to the account holder's
 * Person, never a DRAFT.
 */
async function registrationCountsByAccount(tx: ReadOnlyTransaction): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<Array<{ accountId: string; count: bigint }>>(Prisma.sql`
    SELECT account."id" AS "accountId", COUNT(*)::bigint AS count
    FROM "AttendeeAccount" account
    JOIN (
      SELECT lower(coalesce(
               nullif(trim(registration."contactSnapshot"->>'email'), ''),
               person."normalizedEmail",
               ''
             )) AS email
      FROM "Registration" registration
      JOIN "Person" person ON person."id" = registration."accountHolderPersonId"
      WHERE registration."status" <> 'DRAFT'
    ) contact ON contact.email = lower(btrim(account."email"))
    GROUP BY account."id"
  `);
  return new Map(rows.map((row) => [row.accountId, Number(row.count)]));
}

/**
 * Pairs (same normalised email) whose display names differ ignoring case,
 * spacing, punctuation and accents. Computed in SQL so no name leaves the
 * database. Needs a UTF8 database (the application already does).
 */
async function pairsWithDifferentNames(tx: ReadOnlyTransaction): Promise<Set<string>> {
  const rows = await tx.$queryRaw<Array<{ staffUserId: string; attendeeAccountId: string }>>(Prisma.sql`
    SELECT u."id" AS "staffUserId", a."id" AS "attendeeAccountId"
    FROM "User" u
    JOIN "AttendeeAccount" a ON lower(btrim(a."email")) = lower(btrim(u."email"))
    WHERE regexp_replace(lower(regexp_replace(normalize(u."displayName", NFKD), '[\u0300-\u036f]', '', 'g')), '[^a-z0-9]+', '', 'g')
       <> regexp_replace(lower(regexp_replace(normalize(a."displayName", NFKD), '[\u0300-\u036f]', '', 'g')), '[^a-z0-9]+', '', 'g')
  `);
  return new Set(rows.map((row) => pairKey(row.staffUserId, row.attendeeAccountId)));
}

type CountSelect = Record<string, true>;

/**
 * Every list relation of a model that records rows the account AUTHORED
 * (actor, creator, reviewer and similar), derived from the schema so a column
 * added later is counted without editing this file. `excluded` names the
 * relations that are owned sign-in material, role grants or recipient rows.
 */
function authoredRelations(model: "User" | "AttendeeAccount", excluded: readonly string[]): CountSelect {
  const definition = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === model);
  if (!definition) throw new Error(`Model ${model} missing from the schema`);
  const select: CountSelect = {};
  for (const field of definition.fields) {
    if (field.kind === "object" && field.isList && !excluded.includes(field.name)) select[field.name] = true;
  }
  return select;
}

const STAFF_AUTHORED = authoredRelations("User", [
  "memberships", "sessions", "resetTokens", "mfaChallenges", "passkeys", "staffActAs",
  "auditLogs", "accountMessages",
]);
const ATTENDEE_AUTHORED = authoredRelations("AttendeeAccount", [
  "sessions", "tokens", "passkeys", "stepUpCodes", "identities", "messages",
  "communityParticipations", "communityNotifications", "clubDirectorGrants",
  "coordinatedLocations", "acceptedClubInvites",
]);

function sumCounts(count: unknown, select: CountSelect): number {
  const values = count as Record<string, number>;
  return Object.keys(select).reduce((total, key) => total + (values[key] ?? 0), 0);
}

export async function loadStaffRows(tx: ReadOnlyTransaction): Promise<StaffAccountRow[]> {
  const now = new Date();
  const users = await tx.user.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      email: true,
      accountStatus: true,
      globalRole: true,
      credential: { select: { disabledAt: true, lockedUntil: true } },
      mfaEnrollment: { select: { status: true, lockedUntil: true } },
      personLink: { select: { personId: true } },
      _count: {
        select: {
          ...(STAFF_AUTHORED as Record<string, never>),
          memberships: true,
          auditLogs: true,
          passkeys: { where: { revokedAt: null } },
          sessions: { where: { revokedAt: null, expiresAt: { gt: now } } },
        },
      },
    },
  });
  const activeMemberships = await tx.eventMembership.groupBy({
    by: ["userId"],
    where: { status: "ACTIVE" },
    _count: { _all: true },
  });
  const activeByUser = new Map(activeMemberships.map((row) => [row.userId, row._count._all]));

  return users.map((user) => ({
    id: user.id,
    email: user.email,
    accountStatus: user.accountStatus,
    globalRole: user.globalRole,
    credential: user.credential,
    mfa: mfaState(user.mfaEnrollment),
    mfaLockedUntil: user.mfaEnrollment?.lockedUntil ?? null,
    personLinkPersonId: user.personLink?.personId ?? null,
    counts: {
      memberships: user._count.memberships,
      activeMemberships: activeByUser.get(user.id) ?? 0,
      passkeys: user._count.passkeys,
      sessions: user._count.sessions,
      auditRows: user._count.auditLogs,
      actorRows: sumCounts(user._count, STAFF_AUTHORED),
    },
  }));
}

export async function loadAttendeeRows(tx: ReadOnlyTransaction): Promise<AttendeeAccountRow[]> {
  const now = new Date();
  const registrationsByAccount = await registrationCountsByAccount(tx);
  const accounts = await tx.attendeeAccount.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      email: true,
      status: true,
      emailVerifiedAt: true,
      disabledAt: true,
      credential: { select: { disabledAt: true, lockedUntil: true } },
      identities: { select: { provider: true } },
      mfaEnrollment: { select: { status: true, lockedUntil: true } },
      personLink: { select: { personId: true } },
      areaCoordinatorGrant: { select: { revokedAt: true, expiresAt: true } },
      _count: {
        select: {
          passkeys: { where: { revokedAt: null } },
          sessions: { where: { revokedAt: null, expiresAt: { gt: now } } },
          clubDirectorGrants: {
            where: {
              revokedAt: null,
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            },
          },
          ...(ATTENDEE_AUTHORED as Record<string, never>),
        },
      },
    },
  });

  return accounts.map((account) => {
    const grant = account.areaCoordinatorGrant;
    const coordinatorActive = grant !== null
      && grant.revokedAt === null
      && (grant.expiresAt === null || grant.expiresAt > now);
    const counts = account._count;
    return {
      id: account.id,
      email: account.email,
      status: account.status,
      emailVerifiedAt: account.emailVerifiedAt,
      disabledAt: account.disabledAt,
      credential: account.credential,
      hasGoogleIdentity: account.identities.some((identity) => identity.provider === "GOOGLE"),
      mfa: mfaState(account.mfaEnrollment),
      mfaLockedUntil: account.mfaEnrollment?.lockedUntil ?? null,
      personLinkPersonId: account.personLink?.personId ?? null,
      counts: {
        registrations: registrationsByAccount.get(account.id) ?? 0,
        clubRoles: counts.clubDirectorGrants,
        areaCoordinator: coordinatorActive ? 1 : 0,
        passkeys: counts.passkeys,
        sessions: counts.sessions,
        actorRows: sumCounts(account._count, ATTENDEE_AUTHORED),
      },
    };
  });
}

export async function runSingleAccountDryRun(
  prisma: Pick<PrismaClient, "$transaction">,
  options: { showEmails: boolean; now?: Date },
): Promise<DryRunReport> {
  const now = options.now ?? new Date();
  return withReadOnlyTransaction(prisma, async (tx) => {
    const staff = await loadStaffRows(tx);
    const attendees = await loadAttendeeRows(tx);
    const nameDiffers = await pairsWithDifferentNames(tx);
    return buildReport(staff, attendees, { showEmails: options.showEmails, now, nameDiffers });
  });
}
