"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Eye, EyeOff, LogIn, ShieldCheck } from "lucide-react";

export const LOCAL_DEMO_EMAIL = "admin@imsda-events.test";
export const LOCAL_DEMO_PASSWORD = "IMSDA-Local-2026!";

type MfaStep = {
  gate: "challenge" | "enrol";
  challengeToken: string;
  /** Present while enrolling: the secret to scan, shown once. */
  offer?: { secret: string; otpauthUri: string };
};

/**
 * `demoCredentials` is passed only by a non-production render. A production
 * sign-in page must never prefill or display a shared credential.
 */
export function LoginForm({ demoCredentials = false }: { demoCredentials?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [mfa, setMfa] = useState<MfaStep | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  async function callChallenge(body: Record<string, unknown>) {
    const response = await fetch("/api/auth/mfa/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "That step could not be completed.");
    return result;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to sign in.");

      if (result.mfa?.required) {
        // A correct password has not signed anyone in yet.
        const step: MfaStep = { gate: result.mfa.gate, challengeToken: result.mfa.challengeToken };
        if (step.gate === "enrol") {
          step.offer = await callChallenge({
            challengeToken: step.challengeToken,
            action: "begin-enrollment",
          });
        }
        setMfa(step);
        setBusy(false);
        return;
      }

      router.replace("/overview");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in.");
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mfa) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await callChallenge({
        challengeToken: mfa.challengeToken,
        action: "verify",
        code: form.get("code"),
      });
      if (result.recoveryCodes?.length) {
        // Shown once. Signing straight through would lose them.
        setRecoveryCodes(result.recoveryCodes);
        setBusy(false);
        return;
      }
      router.replace("/overview");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code could not be checked.");
      setBusy(false);
    }
  }

  if (recoveryCodes) {
    return (
      <div className="auth-success">
        <strong>Save your recovery codes</strong>
        <p>
          Each of these signs you in once if you lose your authenticator. Store them somewhere
          other than the device holding the authenticator. They are shown only now.
        </p>
        <ul className="recovery-code-list">
          {recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}
        </ul>
        <button
          className="primary-button full-button"
          type="button"
          onClick={() => { router.replace("/overview"); router.refresh(); }}
        >
          I have saved them — continue
        </button>
      </div>
    );
  }

  if (mfa) {
    return (
      <form className="auth-form" onSubmit={submitCode}>
        {mfa.offer && (
          <div className="auth-success">
            <strong>Set up two-factor authentication</strong>
            <p>
              This account administers events, so it needs a second factor. Add this key to an
              authenticator app, then enter the six-digit code it shows.
            </p>
            <input
              className="copy-field"
              readOnly
              value={mfa.offer.secret}
              onFocus={(event) => event.currentTarget.select()}
            />
            <p className="field-help">
              Most apps can also take the setup link directly: <code>{mfa.offer.otpauthUri}</code>
            </p>
          </div>
        )}
        <label>
          {mfa.offer ? "Code from your authenticator" : "Six-digit code"}
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={32}
            placeholder="123456"
          />
        </label>
        {!mfa.offer && (
          <p className="field-help">
            Lost your authenticator? Enter one of your recovery codes instead.
          </p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button full-button" type="submit" disabled={busy}>
          <ShieldCheck aria-hidden="true" size={17} /> {busy ? "Checking…" : "Verify and sign in"}
        </button>
        <button
          className="auth-back-link"
          type="button"
          onClick={() => { setMfa(null); setError(""); }}
        >
          Start over
        </button>
      </form>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label>Email address<input name="email" type="email" autoComplete="username" required defaultValue={demoCredentials ? LOCAL_DEMO_EMAIL : undefined} /></label>
      <label>Password<span className="password-field"><input name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required defaultValue={demoCredentials ? LOCAL_DEMO_PASSWORD : undefined} /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
      <div className="auth-form-row"><label className="checkbox-label"><input type="checkbox" name="remember" /> Keep email on this device</label><Link href="/forgot-password">Forgot password?</Link></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button full-button" type="submit" disabled={busy}><LogIn aria-hidden="true" size={17} /> {busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
