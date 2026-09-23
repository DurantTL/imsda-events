"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";

export function passkeyPromptMessage(error: unknown, fallback: string) {
  if (error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError")) {
    return "The passkey prompt was closed. Try again when you're ready.";
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown> & { message?: string };
  if (!response.ok) throw new Error(result.message ?? "That didn't work. Please try again.");
  return result;
}

/** Answers the second step with a passkey (the device's own fingerprint, face, or PIN prompt). */
export function PasskeyUnlockButton({ label = "Use a passkey", onVerified }: { label?: string; onVerified?: () => void }) {
  const router = useRouter();
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Only known in the browser; assumed until then so server and client markup match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(browserSupportsWebAuthn());
  }, []);

  async function verify() {
    setBusy(true);
    setError("");
    try {
      const { options } = await postJson("/api/attendee/passkeys/verification/options");
      const response = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
      await postJson("/api/attendee/passkeys/verification", { response });
      onVerified?.();
      router.refresh();
    } catch (caught) {
      setError(passkeyPromptMessage(caught, "That passkey didn't work."));
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return <p className="field-help">This browser can&apos;t use passkeys. Use your authenticator code instead.</p>;
  return (
    <div className="passkey-unlock">
      <button className="primary-button" disabled={busy} onClick={verify} type="button">
        <Fingerprint aria-hidden="true" size={16} /> {busy ? "Waiting for your passkey…" : label}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export { postJson as postPasskeyJson };
