"use client";

import Link from "next/link";
import { useState } from "react";
import { MailCheck } from "lucide-react";

export function PublicRegistrationRecoveryForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requested, setRequested] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/public/registration-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmationCode: form.get("confirmationCode"),
          email: form.get("email"),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.message ?? "The recovery request could not be submitted.");
      }
      setRequested(true);
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : "The recovery request could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  if (requested) {
    return (
      <div className="auth-form">
        <div className="auth-success" role="status">
          <strong>Check the registration contact inbox</strong>
          <p>
            If those details match an active registration, a new private link is
            on its way. For privacy, this page cannot confirm whether a match was
            found.
          </p>
        </div>
        <Link className="auth-back-link" href="/recover-registration">
          Recover another registration
        </Link>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label>
        Confirmation code
        <input
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={80}
          name="confirmationCode"
          required
        />
      </label>
      <label>
        Registration contact email
        <input
          autoComplete="email"
          maxLength={160}
          name="email"
          required
          type="email"
        />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button full-button" disabled={busy} type="submit">
        <MailCheck aria-hidden="true" size={17} />
        {busy ? "Requesting…" : "Email a new private link"}
      </button>
      <p className="field-help">
        Have an attendee account? <Link href="/account/sign-in">Sign in</Link>.
      </p>
    </form>
  );
}
