"use client";

import Link from "next/link";
import { useState } from "react";
import { PartyPopper } from "lucide-react";
import { MfaManager, type MfaStatus } from "@/components/mfa-manager";
import { PasskeyManager } from "@/components/passkey-manager";
import type { PasskeySummary } from "@/modules/attendee-accounts/passkeys";

/**
 * The setup half of the two-step page: pick either an authenticator app or a
 * passkey (a second method stays optional). Once either one is confirmed —
 * for an authenticator, once the one-time recovery codes are saved — this
 * swaps to an explicit finish step instead of leaving the person to guess.
 */
export function TwoStepSetup({
  mfaStatus,
  passkeySettings,
}: {
  mfaStatus: MfaStatus;
  passkeySettings: {
    available: boolean;
    hasAuthenticator: boolean;
    passkeys: PasskeySummary[];
  };
}) {
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <section className="public-manage-card two-step-card auth-success">
        <PartyPopper aria-hidden="true" size={22} />
        <strong>You&apos;re all set</strong>
        <p>Your account now has a second step for signing in. You can add a backup method any time from Sign-in &amp; security.</p>
        <div className="two-step-finish-actions">
          <Link className="primary-button" href="/account">Continue to your account</Link>
          <a className="secondary-button" href="https://imsda.org/">Go home</a>
        </div>
      </section>
    );
  }

  return (
    <>
      <MfaManager
        attendee
        endpoint="/api/attendee/mfa"
        initialStatus={mfaStatus}
        otherMethodAvailable={passkeySettings.available && passkeySettings.passkeys.length > 0}
        onEnrolled={() => setDone(true)}
      />
      {passkeySettings.available && (
        <PasskeyManager
          available={passkeySettings.available}
          hasAuthenticator={passkeySettings.hasAuthenticator}
          initialPasskeys={passkeySettings.passkeys}
          needsConfirmation={false}
          onAdded={() => setDone(true)}
        />
      )}
      <p className="field-help">
        Either an authenticator app or a passkey is enough to continue — you don&apos;t need both.
      </p>
    </>
  );
}
