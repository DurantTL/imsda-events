import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { MfaManager } from "@/components/mfa-manager";
import { PasskeyManager } from "@/components/passkey-manager";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { requireAttendeeSecondStep } from "@/modules/attendee-accounts/portal-second-step";
import { getAttendeeMfaStatus } from "@/modules/attendee-accounts/mfa-service";
import { getPasskeySettings } from "@/modules/attendee-accounts/passkeys";
import { listDirectedClubs } from "@/modules/organizations/director-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign-in and security",
  robots: { index: false, follow: false, nocache: true },
};

export default async function AttendeeSecurityPage() {
  await requireAttendeeSecondStep();
  const { account, via, sessionId } = await getCurrentAttendee();
  if (!account) redirect("/account/sign-in");
  const [mfaStatus, clubs, passkeySettings] = await Promise.all([
    getAttendeeMfaStatus(account.id),
    listDirectedClubs(account.id),
    getPasskeySettings(account.id, via === "attendee" ? sessionId : null),
  ]);

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Your account</p>
          <h1>Sign-in &amp; security</h1>
          <p>Signed in as <strong>{account.verifiedEmail}</strong></p>
        </div>
      </section>
      <div className="account-page-body account-security-grid">
        <div className="account-security-main">
          <MfaManager
            initialStatus={mfaStatus}
            endpoint="/api/attendee/mfa"
            attendee
            otherMethodAvailable={passkeySettings.available && passkeySettings.passkeys.length > 0}
          />
          {/* Passkeys are a second step for opening club rosters, so only club directors manage them. */}
          {clubs.length > 0 && via === "attendee" && (
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
