import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { AttendeeSignOutButton } from "@/components/attendee-sign-out-button";
import { BrandMark } from "@/components/brand-mark";
import { MfaManager } from "@/components/mfa-manager";
import { PasskeyManager } from "@/components/passkey-manager";
import { PasskeyUnlockButton } from "@/components/passkey-unlock-button";
import { RosterUnlockForm } from "@/components/roster-unlock-form";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { getAttendeeMfaStatus } from "@/modules/attendee-accounts/mfa-service";
import { getPasskeySettings } from "@/modules/attendee-accounts/passkeys";
import { accountNeedsSecondStep } from "@/modules/attendee-accounts/sign-in-gate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm it's you",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The second step after a password, for anyone with a club role (decision
 * 2026-09-23). They confirm with a code or passkey, or set one up first.
 * Nothing else in the account opens until this session has passed it.
 */
export default async function TwoStepPage() {
  const { account, via, sessionId } = await getCurrentAttendee();
  if (!account) redirect("/account/sign-in");
  if (via !== "attendee") redirect("/account");
  const gate = await accountNeedsSecondStep(account.id, sessionId);
  if (gate === "OK") redirect("/account");
  const [mfaStatus, passkeySettings] = await Promise.all([
    getAttendeeMfaStatus(account.id),
    getPasskeySettings(account.id, sessionId),
  ]);
  const hasPasskey = passkeySettings.available && passkeySettings.passkeys.length > 0;

  return (
    <main className="public-registration-page public-manage-page account-portal">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <a className="public-registration-brand public-event-brand-link" href="https://imsda.org/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </a>
          <AttendeeSignOutButton />
        </div>
      </header>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Two-step sign-in</p>
          <h1>{gate === "VERIFY" ? "Confirm it's you" : "Set up two-step sign-in"}</h1>
          <p>Signed in as <strong>{account.verifiedEmail}</strong></p>
        </div>
      </section>
      <div className="account-page-body two-step-body">
        <section className="public-manage-security-note">
          <ShieldCheck size={20} aria-hidden="true" />
          <div>
            <strong>Why this is needed</strong>
            <p>
              Your account can open club information about young people, so every sign-in needs a second step:
              a code from an authenticator app, or a passkey (your phone or computer&apos;s fingerprint, face, or PIN).
            </p>
          </div>
        </section>
        {gate === "VERIFY" ? (
          <section className="public-manage-card two-step-card">
            {hasPasskey && <PasskeyUnlockButton label="Continue with a passkey" />}
            {mfaStatus.status === "ACTIVE" && (
              <>
                <p className="field-help">{hasPasskey ? "Or enter" : "Enter"} the six-digit code from your authenticator app, or a recovery code.</p>
                <RosterUnlockForm label="Continue" />
              </>
            )}
          </section>
        ) : (
          <>
            <MfaManager attendee endpoint="/api/attendee/mfa" initialStatus={mfaStatus} />
            {passkeySettings.available && (
              <PasskeyManager
                available={passkeySettings.available}
                hasAuthenticator={passkeySettings.hasAuthenticator}
                initialPasskeys={passkeySettings.passkeys}
                needsConfirmation={false}
              />
            )}
            <p className="field-help">
              When it&apos;s set up (and you&apos;ve saved your recovery codes), <Link href="/account">continue to your account</Link>.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
