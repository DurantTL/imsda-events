"use client";

import Link from "next/link";
import { useState } from "react";
import { KeyRound } from "lucide-react";

export function PasswordResetForm({ token }: { token: string }) {
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/password-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: form.get("password"), confirmation: form.get("confirmation") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to reset the password.");
      setComplete(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reset the password.");
    } finally {
      setBusy(false);
    }
  }

  if (complete) return <div className="auth-success"><strong>Password changed</strong><p>All previous sessions were signed out. Sign in again with the new password.</p><Link className="primary-button" href="/login">Continue to sign in</Link></div>;
  if (!token) return <div className="auth-success warning"><strong>Reset link missing</strong><p>Request a new local reset link to continue.</p><Link className="primary-button" href="/forgot-password">Request a reset link</Link></div>;

  return <form className="auth-form" onSubmit={submit}><label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label><p className="field-help">Use 12–128 characters. Spaces and symbols are allowed.</p><label>Confirm new password<input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full-button" type="submit" disabled={busy}><KeyRound size={17} /> {busy ? "Changing password…" : "Change password"}</button></form>;
}
