import Link from "next/link";
import { AccountAnnouncementBanner } from "@/components/account-announcement-banner";
import { AttendeeAccountSettings } from "@/components/attendee-account-settings";
import { AttendeeSignOutButton } from "@/components/attendee-sign-out-button";
import { MfaManager } from "@/components/mfa-manager";
import { SignOutButton } from "@/components/sign-out-button";
import { StaffPasskeyManager } from "@/components/staff-passkey-manager";
import type { ProfileData } from "@/modules/account-profile/load-profile";

/**
 * The one shared Edit profile view (#543, #646). `/profile` renders it inside
 * the staff workspace shell and `/account/profile` inside the attendee portal,
 * so opening Profile is a navigation within a layout, never a full-page change.
 * Sections follow the sessions that exist (staff, registration account, or
 * both); the two sessions stay separate (ADR 0003) and nothing here joins them.
 */
export function ProfileView({ data, variant }: { data: ProfileData; variant: "shell" | "portal" }) {
  const { staff, attendeeAccount, secondStepPending, mfaStatus, passkeySettings, clubs } = data;
  const inShell = variant === "shell";

  const staffSections = staff && mfaStatus && passkeySettings
    ? (
      <>
        <section aria-labelledby="profile-staff-heading" className="panel profile-staff-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Staff account</p>
              <h2 id="profile-staff-heading">{staff.displayName}</h2>
            </div>
            <SignOutButton className="secondary-button" label="Sign out of staff account" />
          </div>
          <dl className="profile-readonly-fields">
            <div>
              <dt>Name</dt>
              <dd>{staff.displayName}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{staff.email}</dd>
            </div>
          </dl>
          <p className="field-help profile-readonly-note">Your name and email are managed by a system administrator, so they cannot be edited here.</p>
        </section>
        <MfaManager initialStatus={mfaStatus} />
        <StaffPasskeyManager
          available={passkeySettings.available}
          initialPasskeys={passkeySettings.passkeys}
          verification={passkeySettings.verification}
        />
      </>
    )
    : null;

  const backLinks = attendeeAccount
    ? (
      <nav aria-label="Registration account links" className="profile-back-links">
        <Link className="secondary-button" href="/account">My registrations</Link>
        {clubs.length === 1 && (
          <Link className="secondary-button" href={`/account/clubs/${encodeURIComponent(clubs[0].organizationId)}`}>
            {clubs[0].name}
          </Link>
        )}
        {clubs.length > 1 && <Link className="secondary-button" href="/account/clubs">My clubs</Link>}
      </nav>
    )
    : null;

  const secondStepNotice = (
    <p className="public-manage-empty">
      Confirm your second step to see your registration account.{" "}
      <Link href="/account/two-step">Continue</Link>
    </p>
  );

  if (inShell) {
    return (
      <section className="page-stack profile-page">
        <div className="page-intro">
          <div>
            <p className="eyebrow">Your account</p>
            <h2>Edit profile</h2>
            <p>Your details, two-step verification and passkeys.</p>
          </div>
        </div>
        {staffSections}
        {attendeeAccount && (
          <section aria-labelledby="profile-registration-heading" className="panel profile-shell-attendee">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Registration account</p>
                <h2 id="profile-registration-heading">Registration account</h2>
              </div>
              <AttendeeSignOutButton className="secondary-button" label="Sign out of registration account" />
            </div>
            {!secondStepPending && (
              <AccountAnnouncementBanner accountId={attendeeAccount.id} announcements={data.bannerAnnouncements} />
            )}
            {data.showTwoStepOn && <p className="auth-success" role="status">Two-step verification is on.</p>}
            {!secondStepPending && (
              <p className="field-help">
                Signed in as <strong>{attendeeAccount.verifiedEmail}</strong>. Saved details fill in new registration forms for you.
              </p>
            )}
            {backLinks}
            {secondStepPending
              ? secondStepNotice
              : <AttendeeAccountSettings account={attendeeAccount} sessionId={data.sessionId} />}
          </section>
        )}
      </section>
    );
  }

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Your account</p>
          <h1>Edit profile</h1>
          <p>Your details, two-step verification and passkeys.</p>
        </div>
      </section>

      {staffSections && <div className="account-page-body profile-portal-staff">{staffSections}</div>}

      {attendeeAccount && (
        <section aria-labelledby="profile-registration-heading" className="profile-account-section">
          <div className="account-page-body">
            <section className="public-manage-card profile-account-card">
              <div className="profile-account-heading-row">
                <h2 className="profile-account-heading" id="profile-registration-heading">Registration account</h2>
                <div className="profile-account-actions">
                  {backLinks}
                  <AttendeeSignOutButton className="secondary-button" label="Sign out of registration account" />
                </div>
              </div>
              {data.showTwoStepOn && <p className="auth-success" role="status">Two-step verification is on.</p>}
              {!secondStepPending && (
                <p className="field-help">
                  Signed in as <strong>{attendeeAccount.verifiedEmail}</strong>. Saved details fill in new registration forms for you.
                </p>
              )}
            </section>
          </div>
          {secondStepPending
            ? (
              <div className="account-page-body">
                <section className="public-manage-card">{secondStepNotice}</section>
              </div>
            )
            : <AttendeeAccountSettings account={attendeeAccount} sessionId={data.sessionId} />}
        </section>
      )}
    </>
  );
}
