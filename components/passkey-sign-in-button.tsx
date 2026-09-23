"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";
import { passkeyPromptMessage, postPasskeyJson } from "@/components/passkey-unlock-button";
import { takeAttendeeAuthReturnPath } from "@/modules/attendee-accounts/sign-up-prefill";

/**
 * Sign in with a passkey (#374): the device shows its own fingerprint, face,
 * or PIN prompt and offers this site's passkeys. No email or password.
 */
export function PasskeySignInButton() {
  const router = useRouter();
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Only known in the browser; assumed until then so server and client markup match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(browserSupportsWebAuthn());
  }, []);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const { options } = await postPasskeyJson("/api/attendee/passkeys/sign-in/options");
      const response = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
      await postPasskeyJson("/api/attendee/passkeys/sign-in", { response });
      // Back to where sign-in was asked for, as the password form does.
      router.replace(takeAttendeeAuthReturnPath() ?? "/account");
      router.refresh();
    } catch (caught) {
      setError(passkeyPromptMessage(caught, "That passkey didn't sign you in."));
      setBusy(false);
    }
  }

  if (!supported) return null;
  return (
    <div className="passkey-sign-in">
      <button className="secondary-button passkey-sign-in-button" disabled={busy} onClick={signIn} type="button">
        <Fingerprint aria-hidden="true" size={17} /> {busy ? "Waiting for your passkey…" : "Sign in with a passkey"}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
