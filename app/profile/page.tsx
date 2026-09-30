import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountAnnouncementBanner } from "@/components/account-announcement-banner";
import { AttendeeAccountSettings } from "@/components/attendee-account-settings";
import { AttendeeSignOutButton } from "@/components/attendee-sign-out-button";
import { BrandMark } from "@/components/brand-mark";
import { MfaManager, type MfaStatus } from "@/components/mfa-manager";
import { SignOutButton } from "@/components/sign-out-button";
import { StaffPasskeyManager } from "@/components/staff-passkey-manager";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getCurrentSession } from "@/modules/access/current-session";
import { twoStepRedirectPath } from "@/modules/attendee-accounts/return-redirect";
import { getPasskeySettings as getAttendeePasskeySettings } from "@/modules/attendee-accounts/passkeys";
import { getAttendeeMfaStatus } from "@/modules/attendee-accounts/mfa-service";
import { getMfaStatus } from "@/modules/access/mfa-service";
import { getPasskeySettings } from "@/modules/access/passkeys";
import {
  otherWorkspaceContextsForStaff,
} from "@/modules/access/workspace-contexts";
import { listAccountBannerAnnouncements } from "@/modules/communications/account-banner";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { attendeeSecondStepPending } from "@/modules/attendee-accounts/portal-second-step";
import { listDirectedClubs } from "@/modules/organizations/director-access";

export const dynamic = "force-dynamic";

/**
 * The one Edit profile page (#543): profile, two-step verification and
 * passkeys for whichever account this browser is signed in with. Staff and
 * attendee sessions stay separate (ADR 0003), so each is read on its own and
 * shown as its own labelled section; nothing here joins them or adds auth
 * logic. No event is needed, and nothing redirects for the lack of one.
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ twoStep?: string | string[] }>;
}) {
  const { twoStep } = await searchParams;
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
  if (!staff && secondStepPending) redirect(await twoStepRedirectPath());

  const [mfaStatus, passkeySettings] = staff
    ? await Promise.all([getMfaStatus(staff.id) as Promise<MfaStatus>, getPasskeySettings(staff)])
    : [null, null];
  // The confirmation banner is only true when a second step really is on: an
  // active authenticator or a registered passkey (#568).
  let showTwoStepOn = false;
  if (twoStep === "on" && attendeeAccount && !secondStepPending) {
    const [authenticator, passkeys] = await Promise.all([
      getAttendeeMfaStatus(attendeeAccount.id),
      getAttendeePasskeySettings(attendeeAccount.id, sessionId),
    ]);
    showTwoStepOn = authenticator.status === "ACTIVE" || passkeys.passkeys.length > 0;
  }
  const clubs = attendeeAccount && !secondStepPending ? await listDirectedClubs(attendeeAccount.id) : [];
  // The same announcement banner as the account portal, for an attendee
  // session past its second step only; a staff session gets none.
  const bannerAnnouncements = !staff && attendeeAccount && !secondStepPending
    ? await listAccountBannerAnnouncements(attendeeAccount, clubs)
    : [];

  const systemAdmin = staff
    ? otherWorkspaceContextsForStaff({
      isSystemAdmin: staff.globalRole === "SYSTEM_ADMIN",
      attendeeAccountAvailable: false,
    }).find((context) => context.kind === "system_admin")
    : undefined;

  // Any browser with a staff session gets the profile inside the staff
  // workspace shell (sidebar, header) like every other staff page (#623), and
  // reaches it even with no events. A registration account, when this browser
  // has one too, is a card on the same page. Attendee-only sessions keep the
  // public-style page below.
  if (staff && mfaStatus && passkeySettings) {
    return (
      <WorkspaceShell anyStaffWithoutEvents>
        <section className="page-stack">
          <div className="page-intro">
            <div>
              <p className="eyebrow">Your account</p>
              <h2>Edit profile</h2>
              <p>Your details, two-step verification and passkeys.</p>
            </div>
            <div className="page-intro-actions">
              <SignOutButton className="secondary-button" label="Sign out of staff account" />
            </div>
          </div>
          <section aria-labelledby="profile-staff-heading" className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Profile</p>
                <h2 id="profile-staff-heading">{staff.displayName}</h2>
              </div>
            </div>
            <div className="profile-identity">
              <span>{staff.email}</span>
              <small>Your name and email are managed by a system administrator.</small>
            </div>
          </section>
          <MfaManager initialStatus={mfaStatus} />
          <StaffPasskeyManager
            available={passkeySettings.available}
            initialPasskeys={passkeySettings.passkeys}
            verification={passkeySettings.verification}
          />
          {attendeeAccount && (
            <section aria-labelledby="profile-registration-heading" className="panel profile-shell-attendee">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Registration account</p>
                  <h2 id="profile-registration-heading">Registration account</h2>
                </div>
                <AttendeeSignOutButton className="secondary-button" label="Sign out of registration account" />
              </div>
              {showTwoStepOn && <p className="auth-success" role="status">Two-step verification is on.</p>}
              {!secondStepPending && (
                <p className="field-help">
                  Signed in as <strong>{attendeeAccount.verifiedEmail}</strong>. Saved details fill in new registration forms for you.
                </p>
              )}
              <nav aria-label="Registration account links" className="profile-back-links">
                <Link className="secondary-button" href="/account">My registrations</Link>
                {clubs.length === 1 && (
                  <Link className="secondary-button" href={`/account/clubs/${encodeURIComponent(clubs[0].organizationId)}`}>
                    {clubs[0].name}
                  </Link>
                )}
                {clubs.length > 1 && <Link className="secondary-button" href="/account/clubs">My clubs</Link>}
                {systemAdmin && <Link className="secondary-button" href={systemAdmin.href}>{systemAdmin.label}</Link>}
              </nav>
              {secondStepPending
                ? (
                  <p className="public-manage-empty">
                    Confirm your second step to see your registration account.{" "}
                    <Link href="/account/two-step">Continue</Link>
                  </p>
                )
                : <AttendeeAccountSettings account={attendeeAccount} sessionId={sessionId} />}
            </section>
          )}
        </section>
      </WorkspaceShell>
    );
  }

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
      {attendeeAccount && !secondStepPending && (
        <AccountAnnouncementBanner accountId={attendeeAccount.id} announcements={bannerAnnouncements} />
      )}

      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Your account</p>
          <h1>Edit profile</h1>
          <p>Your details, two-step verification and passkeys.</p>
        </div>
      </section>

      <div className="account-page-body">
        <nav aria-label="Back" className="profile-back-links">
          <Link className="secondary-button" href="/account">My registrations</Link>
          {clubs.length === 1 && (
            <Link className="secondary-button" href={`/account/clubs/${encodeURIComponent(clubs[0].organizationId)}`}>
              {clubs[0].name}
            </Link>
          )}
          {clubs.length > 1 && <Link className="secondary-button" href="/account/clubs">My clubs</Link>}
        </nav>
      </div>

      {attendeeAccount && (
        <section aria-labelledby="profile-registration-heading" className="profile-account-section">
          <div className="account-page-body">
            <h2 className="profile-account-heading" id="profile-registration-heading">Registration account</h2>
            {showTwoStepOn && (
              <p className="auth-success" role="status">Two-step verification is on.</p>
            )}
            {!secondStepPending && (
              <p className="field-help">
                Signed in as <strong>{attendeeAccount.verifiedEmail}</strong>. Saved details fill in new registration forms for you.
              </p>
            )}
            <AttendeeSignOutButton className="secondary-button" label="Sign out of registration account" />
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
