import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AttendeeAccountSettings } from "@/components/attendee-account-settings";
import { ActAsBanner } from "@/components/act-as-banner";
import { AttendeeSignOutButton } from "@/components/attendee-sign-out-button";
import { BrandMark } from "@/components/brand-mark";
import { MfaManager, type MfaStatus } from "@/components/mfa-manager";
import { SignOutButton } from "@/components/sign-out-button";
import { StaffPasskeyManager } from "@/components/staff-passkey-manager";
import { getCurrentSession } from "@/modules/access/current-session";
import { getMfaStatus } from "@/modules/access/mfa-service";
import { getPasskeySettings } from "@/modules/access/passkeys";
import {
  otherWorkspaceContextsForAttendee,
  otherWorkspaceContextsForStaff,
} from "@/modules/access/workspace-contexts";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { attendeeSecondStepPending } from "@/modules/attendee-accounts/portal-second-step";
import { listDirectedClubs } from "@/modules/organizations/director-access";
import { currentStaffActingContext } from "@/modules/organizations/staff-act-as";

export const dynamic = "force-dynamic";

/**
 * The one Edit profile page (#543): profile, two-step verification and
 * passkeys for whichever account this browser is signed in with. Staff and
 * attendee sessions stay separate (ADR 0003), so each is read on its own and
 * shown as its own labelled section; nothing here joins them or adds auth
 * logic. No event is needed, and nothing redirects for the lack of one.
 */
export default async function ProfilePage() {
  const [{ user: staff }, { account, via, sessionId }] = await Promise.all([
    getCurrentSession(),
    getCurrentAttendee(),
  ]);
  // Only this browser's own attendee session counts as a registration
  // account; a staff session that merely matches an attendee email does not.
  const attendeeAccount = via === "attendee" ? account : null;
  if (!staff && !attendeeAccount) redirect("/profile/sign-in");

  // A club role that hasn't passed its second step sees nothing of its
  // registration account yet. Attendee-only visitors go to finish it.
  const secondStepPending = attendeeAccount ? await attendeeSecondStepPending() : false;
  if (!staff && secondStepPending) redirect("/account/two-step");

  const [mfaStatus, passkeySettings] = staff
    ? await Promise.all([getMfaStatus(staff.id) as Promise<MfaStatus>, getPasskeySettings(staff)])
    : [null, null];
  const clubs = attendeeAccount && !secondStepPending ? await listDirectedClubs(attendeeAccount.id) : [];

  // The same banner the workspace and portal layouts show while a system
  // administrator is acting as a club role (#442); staff sessions only.
  const acting = staff ? await currentStaffActingContext() : null;

  const staffWorkspace = staff ? otherWorkspaceContextsForAttendee({ hasStaffSession: true })[0] : undefined;
  const systemAdmin = staff
    ? otherWorkspaceContextsForStaff({
      isSystemAdmin: staff.globalRole === "SYSTEM_ADMIN",
      attendeeAccountAvailable: false,
    }).find((context) => context.kind === "system_admin")
    : undefined;

  return (
    <main className="public-registration-page public-manage-page account-portal">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
        </div>
      </header>
      <ActAsBanner acting={acting} />

      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Your account</p>
          <h1>Edit profile</h1>
          <p>Your details, two-step verification and passkeys.</p>
        </div>
      </section>

      <div className="account-page-body">
        <nav aria-label="Back" className="profile-back-links">
          {staffWorkspace && (
            <Link className="text-button" href={staffWorkspace.href}>
              <ArrowLeft aria-hidden="true" size={15} /> Back to staff workspace
            </Link>
          )}
          {systemAdmin && <Link className="text-button" href={systemAdmin.href}>{systemAdmin.label}</Link>}
          {attendeeAccount && <Link className="text-button" href="/account">My registrations</Link>}
          {clubs.length === 1 && (
            <Link className="text-button" href={`/account/clubs/${encodeURIComponent(clubs[0].organizationId)}`}>
              {clubs[0].name}
            </Link>
          )}
          {clubs.length > 1 && <Link className="text-button" href="/account/clubs">My clubs</Link>}
        </nav>
      </div>

      {staff && mfaStatus && passkeySettings && (
        <section aria-labelledby="profile-staff-heading" className="profile-account-section">
          <div className="account-page-body">
            <h2 className="profile-account-heading" id="profile-staff-heading">Staff account</h2>
            <section className="public-manage-card">
              <p className="public-registration-eyebrow">Profile</p>
              <div className="profile-identity">
                <strong>{staff.displayName}</strong>
                <span>{staff.email}</span>
                <small>Your name and email are managed by a system administrator.</small>
              </div>
              <SignOutButton label="Sign out of staff account" />
            </section>
          </div>
          <div className="account-page-body">
            <MfaManager initialStatus={mfaStatus} />
            <StaffPasskeyManager
              available={passkeySettings.available}
              initialPasskeys={passkeySettings.passkeys}
              verification={passkeySettings.verification}
            />
          </div>
        </section>
      )}

      {attendeeAccount && (
        <section aria-labelledby="profile-registration-heading" className="profile-account-section">
          <div className="account-page-body">
            <h2 className="profile-account-heading" id="profile-registration-heading">Registration account</h2>
            {!secondStepPending && (
              <p className="field-help">
                Signed in as <strong>{attendeeAccount.verifiedEmail}</strong>. Saved details fill in new registration forms for you.
              </p>
            )}
            <AttendeeSignOutButton label="Sign out of registration account" />
          </div>
          {secondStepPending
            ? (
              <div className="account-page-body">
                <section className="public-manage-card">
                  <p className="public-manage-empty">
                    Confirm your second step to see your registration account.{" "}
                    <Link href="/account/two-step">Continue</Link>
                  </p>
                </section>
              </div>
            )
            : <AttendeeAccountSettings account={attendeeAccount} sessionId={sessionId} />}
        </section>
      )}
    </main>
  );
}
