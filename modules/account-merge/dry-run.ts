import { Prisma, type PrismaClient } from "@prisma/client";
import {
  buildReport,
  normalizeEmail,
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
 * It selects counts and ids, never names, phones, hashes or secrets. Display
 * names are read only to compare them and are not placed in the report.
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
 * Registrations reachable by verified email, per address. This is the same
 * rule `registrations-repository.ts` uses to decide what an account may see:
 * the contact email in the snapshot, falling back to the account holder's
 * Person, never a DRAFT.
 */
async function registrationCountsByEmail(tx: ReadOnlyTransaction): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<Array<{ email: string; count: bigint }>>(Prisma.sql`
    SELECT lower(coalesce(
             nullif(trim(registration."contactSnapshot"->>'email'), ''),
             person."normalizedEmail",
             ''
           )) AS email,
           COUNT(*)::bigint AS count
    FROM "Registration" registration
    JOIN "Person" person ON person."id" = registration."accountHolderPersonId"
    WHERE registration."status" <> 'DRAFT'
    GROUP BY 1
  `);
  return new Map(rows.filter((row) => row.email !== "").map((row) => [row.email, Number(row.count)]));
}

export async function loadStaffRows(tx: ReadOnlyTransaction): Promise<StaffAccountRow[]> {
  const now = new Date();
  const users = await tx.user.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      email: true,
      displayName: true,
      accountStatus: true,
      globalRole: true,
      credential: { select: { disabledAt: true, lockedUntil: true } },
      mfaEnrollment: { select: { status: true } },
      personLink: { select: { personId: true } },
      _count: {
        select: {
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
    displayName: user.displayName,
    accountStatus: user.accountStatus,
    globalRole: user.globalRole,
    credential: user.credential,
    mfa: mfaState(user.mfaEnrollment),
    personLinkPersonId: user.personLink?.personId ?? null,
    counts: {
      memberships: user._count.memberships,
      activeMemberships: activeByUser.get(user.id) ?? 0,
      passkeys: user._count.passkeys,
      sessions: user._count.sessions,
      auditRows: user._count.auditLogs,
    },
  }));
}

export async function loadAttendeeRows(tx: ReadOnlyTransaction): Promise<AttendeeAccountRow[]> {
  const now = new Date();
  const registrationsByEmail = await registrationCountsByEmail(tx);
  const accounts = await tx.attendeeAccount.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      email: true,
      displayName: true,
      status: true,
      emailVerifiedAt: true,
      disabledAt: true,
      credential: { select: { disabledAt: true, lockedUntil: true } },
      identities: { select: { provider: true } },
      mfaEnrollment: { select: { status: true } },
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
          // Rows this account authored elsewhere. Attendee actions have no
          // AuditLog column (it carries `actorUserId` only), so these are the
          // attendee-side equivalents of "audit rows".
          grantedClubRoles: true,
          revokedClubRoles: true,
          amendedRegistrationOperations: true,
          memberTransferEvents: true,
          initiatedMemberTransfers: true,
          resolvedMemberTransfers: true,
          submittedClubRegistrations: true,
          enteredClubFormSubmissions: true,
          createdClubFormLinks: true,
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
      displayName: account.displayName,
      status: account.status,
      emailVerifiedAt: account.emailVerifiedAt,
      disabledAt: account.disabledAt,
      credential: account.credential,
      hasGoogleIdentity: account.identities.some((identity) => identity.provider === "GOOGLE"),
      mfa: mfaState(account.mfaEnrollment),
      personLinkPersonId: account.personLink?.personId ?? null,
      counts: {
        registrations: registrationsByEmail.get(normalizeEmail(account.email)) ?? 0,
        clubRoles: counts.clubDirectorGrants,
        areaCoordinator: coordinatorActive ? 1 : 0,
        passkeys: counts.passkeys,
        sessions: counts.sessions,
        actorRows:
          counts.grantedClubRoles
          + counts.revokedClubRoles
          + counts.amendedRegistrationOperations
          + counts.memberTransferEvents
          + counts.initiatedMemberTransfers
          + counts.resolvedMemberTransfers
          + counts.submittedClubRegistrations
          + counts.enteredClubFormSubmissions
          + counts.createdClubFormLinks,
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
    return buildReport(staff, attendees, { showEmails: options.showEmails, now });
  });
}
