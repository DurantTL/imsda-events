import "server-only";

import { getPrisma } from "@/lib/prisma";
import { passkeysConfigured } from "@/modules/attendee-accounts/passkeys";
import { listDirectedClubs } from "@/modules/organizations/director-access";

/**
 * Who must pass a second step before any account page (decision 2026-09-23):
 * anyone holding a club role, and Area Coordinators (#387).
 * Ordinary attendees keep password-only sign-in; they hold the least personal
 * information and edits already need an emailed code.
 *
 * - OK: nothing to do, or this session already passed the second step.
 * - VERIFY: has an authenticator app or usable passkey; must use it now.
 * - SETUP: has neither; must add one before going further.
 */
export type SignInGate = "OK" | "VERIFY" | "SETUP";

export async function accountNeedsSecondStep(accountId: string, sessionId: string | null, now = new Date()): Promise<SignInGate> {
  if (!sessionId) return "OK";
  const prisma = getPrisma();
  const [clubs, areaGrant] = await Promise.all([
    listDirectedClubs(accountId, now),
    prisma.areaCoordinatorGrant.findUnique({ where: { attendeeAccountId: accountId }, select: { revokedAt: true } }),
  ]);
  const areaCoordinator = Boolean(areaGrant && !areaGrant.revokedAt);
  if (clubs.length === 0 && !areaCoordinator) return "OK";
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
