import "server-only";

import { getMfaStatus } from "@/modules/access/mfa-service";
import { getPasskeySettings } from "@/modules/access/passkeys";
import { getCurrentSession } from "@/modules/access/current-session";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { getAttendeeMfaStatus } from "@/modules/attendee-accounts/mfa-service";
import { getPasskeySettings as getAttendeePasskeySettings } from "@/modules/attendee-accounts/passkeys";
import { attendeeSecondStepPending } from "@/modules/attendee-accounts/portal-second-step";
import { listAccountBannerAnnouncements } from "@/modules/communications/account-banner";
import { listDirectedClubs } from "@/modules/organizations/director-access";
import type { MfaStatus } from "@/components/mfa-manager";

/**
 * Data for the one shared profile view (#543, #646). The staff and attendee
 * sessions stay separate (ADR 0003): each is read on its own, and nothing here
 * joins them. Which sections exist depends only on which sessions exist.
 */

/** Which sessions this browser carries. Cheap; pages decide their redirects from it. */
export async function resolveProfileSessions() {
  const [{ user: staff }, { account, via, sessionId }] = await Promise.all([
    getCurrentSession(),
    getCurrentAttendee(),
  ]);
  // Only this browser's own attendee session counts as a registration
  // account; a staff session that merely matches an attendee email does not.
  const attendeeAccount = via === "attendee" ? account : null;
  return { staff, attendeeAccount, sessionId };
}

export type ProfileSessions = Awaited<ReturnType<typeof resolveProfileSessions>>;

function twoStepIsOn(twoStep: string | string[] | undefined): boolean {
  return twoStep === "on" || (Array.isArray(twoStep) && twoStep.includes("on"));
}

/** `?twoStep=on` when the flag is present, so a redirect keeps the confirmation. */
export function twoStepQuery(twoStep: string | string[] | undefined): string {
  return twoStepIsOn(twoStep) ? "?twoStep=on" : "";
}

/**
 * Where a session mix belongs (#646): `/profile` for anyone with a staff
 * session (inside the staff shell), else `/account/profile` for an attendee
 * (inside the portal), else the sign-in chooser.
 */
export function profileHomeFor(
  sessions: Pick<ProfileSessions, "staff" | "attendeeAccount">,
  query = "",
): string {
  if (sessions.staff) return `/profile${query}`;
  if (sessions.attendeeAccount) return `/account/profile${query}`;
  return "/profile/sign-in";
}

export async function loadProfileData(sessions: ProfileSessions, twoStep: string | string[] | undefined) {
  const { staff, attendeeAccount, sessionId } = sessions;
  // A club role that hasn't passed its second step sees nothing of its
  // registration account yet.
  const secondStepPending = attendeeAccount ? await attendeeSecondStepPending() : false;
  const [mfaStatus, passkeySettings] = staff
    ? await Promise.all([getMfaStatus(staff.id) as Promise<MfaStatus>, getPasskeySettings(staff)])
    : [null, null];
  // The confirmation banner is only true when a second step really is on: an
  // active authenticator or a registered passkey (#568).
  let showTwoStepOn = false;
  if (twoStepIsOn(twoStep) && attendeeAccount && !secondStepPending) {
    const [authenticator, passkeys] = await Promise.all([
      getAttendeeMfaStatus(attendeeAccount.id),
      getAttendeePasskeySettings(attendeeAccount.id, sessionId),
    ]);
    showTwoStepOn = authenticator.status === "ACTIVE" || passkeys.passkeys.length > 0;
  }
  const clubs = attendeeAccount && !secondStepPending ? await listDirectedClubs(attendeeAccount.id) : [];
  const bannerAnnouncements = attendeeAccount && !secondStepPending
    ? await listAccountBannerAnnouncements(attendeeAccount, clubs)
    : [];
  return { staff, attendeeAccount, sessionId, secondStepPending, mfaStatus, passkeySettings, showTwoStepOn, clubs, bannerAnnouncements };
}

export type ProfileData = Awaited<ReturnType<typeof loadProfileData>>;
