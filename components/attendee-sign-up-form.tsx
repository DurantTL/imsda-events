"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, MailCheck, UserPlus } from "lucide-react";
import { OneTimeCodeInput } from "@/components/one-time-code-input";
import { attendeeSignUpEmailPrefill } from "@/modules/attendee-accounts/sign-up-prefill";

/**
 * Creating an attendee account: details, then the code that arrives by email.
 *
 * The second step is a code rather than a link on purpose. A link in an inbox is
 * spendable by whoever opens it — including the address's real owner clicking to
 * see what an unexpected email was, which would verify somebody else's sign-up
 * onto their registrations. A code has to be typed back into this page.
 *
 * That also shapes what this component says while waiting. It cannot tell the
 * person whether the address already had an account, because the server does not
 * tell it either, so the waiting copy has to be true in both cases.
 */
export function AttendeeSignUpForm({
  initialEmail = "",
}: {
  initialEmail?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  /** Only ever set by a development server with no account email configured. */
  const [developmentCode, setDevelopmentCode] = useState<string | null>(null);

  useEffect(() => {
    if (initialEmail || !window.location.hash) return;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const prefill = attendeeSignUpEmailPrefill(fragment.get("email") ?? undefined);
    if (prefill && emailRef.current) emailRef.current.value = prefill;
  }, [initialEmail]);

  async function submitDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    try {
      const response = await fetch("/api/attendee/sign-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          displayName: form.get("displayName"),
          password: form.get("password"),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to create an account.");
      setDevelopmentCode(result.developmentCode ?? null);
      setSentTo(email);
      setBusy(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create an account.");
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/attendee/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: form.get("code") }),
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
      <form className="auth-form" onSubmit={submitCode}>
        <div className="auth-success">
          <strong>Check {sentTo}</strong>
          <p>
            If an account can be created for that address, a six-digit code is on its way. Enter it
            here — it only works in this browser, and it expires in twenty minutes.
          </p>
        </div>
        {developmentCode && (
          <div className="local-credentials">
            <strong>Development code</strong>
            <span>{developmentCode}</span>
            <small>Shown only because this server cannot send email</small>
          </div>
        )}
        <OneTimeCodeInput label="Six-digit code" autoFocus disabled={busy} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button full-button" type="submit" disabled={busy}>
          <MailCheck aria-hidden="true" size={17} /> {busy ? "Checking…" : "Verify and continue"}
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
    <form className="auth-form" onSubmit={submitDetails}>
      <label>
        Your name
        <input name="displayName" type="text" autoComplete="name" required maxLength={120} />
      </label>
      <label>
        Email address
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          defaultValue={initialEmail}
          ref={emailRef}
        />
      </label>
      <p className="field-help">
        Use the address your registrations were made with. That is what connects them to your
        account — nothing else does.
      </p>
      <label>
        Password
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
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button full-button" type="submit" disabled={busy}>
        <UserPlus aria-hidden="true" size={17} /> {busy ? "Creating…" : "Create account"}
      </button>
      <p className="field-help">
        Already have one? <Link href="/account/sign-in">Sign in</Link>.
      </p>
    </form>
  );
}
