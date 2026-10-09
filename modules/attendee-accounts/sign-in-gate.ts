import "server-only";

import { getPrisma } from "@/lib/prisma";
import { passkeysConfigured } from "@/modules/attendee-accounts/passkeys";
import { listDirectedClubs } from "@/modules/organizations/director-access";

/**
 * Who must pass a second step before any account page (decision 2026-09-23):
 * anyone holding a club role, Area Coordinators (#387), and accepted Honors Weekend
 * instructors (#833).
 * Ordinary attendees keep password-only sign-in; they hold the least personal
 * information and edits already need an emailed code.
 *
 * - OK: nothing to do, or this session already passed the second step.
 * - VERIFY: has an authenticator app or usable passkey; must use it now.
 * - SETUP: has neither; must add one before going further.
 */
export type SignInGate = "OK" | "VERIFY" | "SETUP";

/**
 * Whether the account holds anything the second step protects at all: a
 * current club role, or Area Coordinator status (#387). `listDirectedClubs`
 * alone never answers this — an Area Coordinator directs no club, so a
 * caller that gated on it alone would refuse an Area Coordinator's own
 * second step (#464). Every caller that needs to know whether the gate
 * applies to this account (rather than what club role it has) uses this,
 * not `listDirectedClubs` on its own.
 */
export async function accountHasSecondStepAccess(accountId: string, now = new Date()): Promise<boolean> {
  const prisma = getPrisma();
  const [clubs, areaGrant, instructorRoles] = await Promise.all([
    listDirectedClubs(accountId, now),
    prisma.areaCoordinatorGrant.findUnique({ where: { attendeeAccountId: accountId }, select: { revokedAt: true, expiresAt: true } }),
    // An accepted Honors Weekend instructor (#833) reaches young people's rosters, so the same second step applies.
    prisma.honorInstructor.count({ where: { attendeeAccountId: accountId, acceptedAt: { not: null }, revokedAt: null, classes: { some: {} } } }),
  ]);
  const areaCoordinator = Boolean(areaGrant && !areaGrant.revokedAt && (!areaGrant.expiresAt || areaGrant.expiresAt > now));
  return clubs.length > 0 || areaCoordinator || instructorRoles > 0;
}

export async function accountNeedsSecondStep(accountId: string, sessionId: string | null, now = new Date()): Promise<SignInGate> {
  if (!sessionId) return "OK";
  if (!(await accountHasSecondStepAccess(accountId, now))) return "OK";
  const prisma = getPrisma();
  const [session, enrollment, passkeyCount, passkeysOn] = await Promise.all([
    prisma.attendeeSession.findUnique({ where: { id: sessionId }, select: { secondFactorVerifiedAt: true } }),
    prisma.attendeeMfaEnrollment.findUnique({ where: { accountId }, select: { status: true } }),
    prisma.attendeePasskey.count({ where: { accountId, revokedAt: null } }),
    passkeysConfigured(),
  ]);
  if (session?.secondFactorVerifiedAt) return "OK";
  const canVerify = enrollment?.status === "ACTIVE" || (passkeysOn && passkeyCount > 0);
  return canVerify ? "VERIFY" : "SETUP";
}
