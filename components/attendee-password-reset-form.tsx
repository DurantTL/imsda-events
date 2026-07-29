"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Eye, EyeOff, KeyRound, MailCheck } from "lucide-react";
import { OneTimeCodeInput } from "@/components/one-time-code-input";

/**
 * Resetting an attendee password: the address, then the code and the new
 * password together.
 *
 * A code rather than a link, for the reason ADR 0003 gives — a link works for
 * whoever opens it — and with a practical benefit here too. Someone who asks on
 * a laptop and reads mail on a phone can type six digits back into the laptop;
 * a link opened on the phone would have signed them in on the wrong device.
 *
 * The waiting copy has to be true whether or not the address has an account,
 * whether or not it has a password, and whether or not it uses Google, because
 * the server tells this component none of those things.
 */
export function AttendeePasswordResetForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** Only ever set by a development server with no account email configured. */
  const [developmentCode, setDevelopmentCode] = useState<string | null>(null);

  async function requestCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    try {
      const response = await fetch("/api/attendee/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to send a code.");
      setDevelopmentCode(result.developmentCode ?? null);
      setSentTo(email);
      setBusy(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to send a code.");
      setBusy(false);
    }
  }

  async function completeReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/attendee/password-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: form.get("code"), password: form.get("password") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "That code could not be checked.");
      router.replace("/account");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code could not be checked.");
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <form className="auth-form" onSubmit={completeReset}>
        <div className="auth-success">
          <strong>Check {sentTo}</strong>
          <p>
            If that address has an account with a password, a six-digit code is on its way. Enter
            it here with your new password — the code only works in this browser, and it expires in
            twenty minutes.
          </p>
        </div>
        {developmentCode && (
          <div className="local-credentials">
            <strong>Development code</strong>
            <span>{developmentCode}</span>
            <small>Shown only because this server cannot send email</small>
          </div>
        )}
        {/* Not auto-submitting: the new password is still to come, and posting
          * an empty one would spend the code on a request that cannot succeed. */}
        <OneTimeCodeInput label="Six-digit code" autoFocus disabled={busy} autoSubmit={false} />
        <label>
          New password
          <span className="password-field">
            <input
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              maxLength={128}
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </span>
        </label>
        <p className="field-help">
          Setting a new password signs you out everywhere else.
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button full-button" type="submit" disabled={busy}>
          <KeyRound aria-hidden="true" size={17} /> {busy ? "Saving…" : "Set new password"}
        </button>
        <button
          className="auth-back-link"
          type="button"
          onClick={() => { setSentTo(null); setDevelopmentCode(null); setError(""); }}
        >
          Use a different address
        </button>
      </form>
    );
  }

  return (
    <form className="auth-form" onSubmit={requestCode}>
      <label>
        Email address
        <input name="email" type="email" autoComplete="username" required maxLength={254} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button full-button" type="submit" disabled={busy}>
        <MailCheck aria-hidden="true" size={17} /> {busy ? "Sending…" : "Send me a code"}
      </button>
      <p className="field-help">
        Remembered it? <Link href="/account/sign-in">Sign in</Link>.
      </p>
    </form>
  );
}
