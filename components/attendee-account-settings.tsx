import { ShieldCheck } from "lucide-react";
import { AttendeeProfileForm } from "@/components/attendee-profile-form";
import { MfaManager } from "@/components/mfa-manager";
import { PasskeyManager } from "@/components/passkey-manager";
import { getAttendeeMfaStatus } from "@/modules/attendee-accounts/mfa-service";
import { getPasskeySettings } from "@/modules/attendee-accounts/passkeys";
import { getAttendeeProfile } from "@/modules/attendee-accounts/profile-service";
import { listDirectedClubs } from "@/modules/organizations/director-access";

/**
 * The registration (attendee) account's profile and sign-in security, as the
 * `/profile` page's "Registration account" section (#543). It is what the
 * portal's Profile and Security pages showed, loaded the same way; only the
 * account this browser's own attendee session resolved may be passed in.
 */
export async function AttendeeAccountSettings({
  account,
  sessionId,
}: {
  account: { id: string };
  sessionId: string | null;
}) {
  const [profile, mfaStatus, clubs, passkeySettings] = await Promise.all([
    getAttendeeProfile(account.id),
    getAttendeeMfaStatus(account.id),
    listDirectedClubs(account.id),
    getPasskeySettings(account.id, sessionId),
  ]);

  return (
    <>
      <div className="account-page-body">
        <AttendeeProfileForm initialProfile={profile} />
      </div>
      <div className="account-page-body account-security-grid">
        <div className="account-security-main">
          <MfaManager
            initialStatus={mfaStatus}
            endpoint="/api/attendee/mfa"
            attendee
            otherMethodAvailable={passkeySettings.available && passkeySettings.passkeys.length > 0}
          />
          {/* Passkeys are a second step for opening club rosters, so only club directors manage them. */}
          {clubs.length > 0 && (
            <PasskeyManager
              available={passkeySettings.available}
              hasAuthenticator={passkeySettings.hasAuthenticator}
              initialPasskeys={passkeySettings.passkeys}
              needsConfirmation={passkeySettings.needsConfirmation}
            />
          )}
        </div>
        {clubs.length > 0 && (
          <section className="public-manage-security-note">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <strong>Why club directors need this</strong>
              <p>
                Club rosters hold young people&apos;s birth dates. Once per sign-in you&apos;ll confirm
                it&apos;s you with your authenticator code or a passkey before your club opens.
              </p>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
