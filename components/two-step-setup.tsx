"use client";

import Link from "next/link";
import { useState } from "react";
import { PartyPopper } from "lucide-react";
import { MfaManager, type MfaStatus } from "@/components/mfa-manager";
import { PasskeyManager } from "@/components/passkey-manager";
import type { PasskeySummary } from "@/modules/attendee-accounts/passkeys";

/** The "You're all set" state; continues to a validated `next`, otherwise the security page. */
export function TwoStepFinished({ next }: { next?: string }) {
  return (
    <section className="public-manage-card two-step-card auth-success">
      <PartyPopper aria-hidden="true" size={22} />
      <strong>Two-step verification is on.</strong>
      <p>You&apos;re all set. Your account now has a second step for signing in. You can add a backup method any time from Sign-in &amp; security.</p>
      <div className="two-step-finish-actions">
        <Link className="primary-button" href={next ?? "/account/profile?twoStep=on"}>
          {next ? "Continue" : "Continue to Sign-in & security"}
        </Link>
        <a className="secondary-button" href="https://imsda.org/">Go home</a>
      </div>
    </section>
  );
}

/**
 * The setup half of the two-step page: pick either an authenticator app or a
 * passkey (a second method stays optional). Once either one is confirmed —
 * for an authenticator, once the one-time recovery codes are saved — this
 * swaps to an explicit finish step instead of leaving the person to guess.
 */
export function TwoStepSetup({
  mfaStatus,
  passkeySettings,
  next,
}: {
  /** A validated page to continue to; without one, setup ends on the security page. */
  next?: string;
  mfaStatus: MfaStatus;
  passkeySettings: {
    available: boolean;
    hasAuthenticator: boolean;
    passkeys: PasskeySummary[];
  };
}) {
  const [done, setDone] = useState(false);

  if (done) return <TwoStepFinished next={next} />;

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
      <p className="field-help two-step-setup-hint">
        Either an authenticator app or a passkey is enough to continue — you don&apos;t need both.
      </p>
    </>
  );
}
