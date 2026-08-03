"use client";

import Link from "next/link";
import { useState } from "react";
import { LockKeyhole, MailCheck } from "lucide-react";

export function PublicRegistrationRecoveryForm() {
  const [busy, setBusy] = useState<"access" | "email" | null>(null);
  const [error, setError] = useState("");
  const [requested, setRequested] = useState(false);

  async function submit(
    event: React.FormEvent<HTMLFormElement>,
    action: "access" | "email",
  ) {
    event.preventDefault();
    setBusy(action);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/public/registration-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          clientRequestId: crypto.randomUUID(),
          ...(action === "access"
            ? { confirmationCode: form.get("confirmationCode") }
            : {}),
          email: form.get("email"),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.message ?? "The recovery request could not be submitted.");
      }
      if (action === "access") {
        window.location.assign(result.managePath);
      } else {
        setRequested(true);
      }
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : "The recovery request could not be submitted.");
    } finally {
      setBusy(null);
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
    <div>
      <form className="auth-form" onSubmit={(event) => submit(event, "access")}>
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
        <button className="primary-button full-button" disabled={busy !== null} type="submit">
          <LockKeyhole aria-hidden="true" size={17} />
          {busy === "access" ? "Checking…" : "Manage my registration"}
        </button>
      </form>

      <form className="auth-form" onSubmit={(event) => submit(event, "email")}>
        <p className="field-help">
          Lost the code? Request a private link using only the registration contact email.
        </p>
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
        <button className="secondary-button full-button" disabled={busy !== null} type="submit">
          <MailCheck aria-hidden="true" size={17} />
          {busy === "email" ? "Requesting…" : "Email a private link"}
        </button>
        <p className="field-help">
          No account is required. If you have one, you can also <Link href="/account/sign-in">sign in</Link>.
        </p>
      </form>
    </div>
  );
}
