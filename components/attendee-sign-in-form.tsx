"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import {
  attendeeAuthReturnPathFromHash,
  attendeeSignUpEmailPrefill,
  takeAttendeeAuthReturnPath,
} from "@/modules/attendee-accounts/sign-up-prefill";

/** Password sign-in for a registrant. Staff sign in at `/login` instead. */
export function AttendeeSignInForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!window.location.hash) return;
    attendeeAuthReturnPathFromHash(window.location.hash);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const email = attendeeSignUpEmailPrefill(fragment.get("email") ?? undefined);
    if (email && emailRef.current) emailRef.current.value = email;
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/attendee/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to sign in.");
      router.replace(takeAttendeeAuthReturnPath() ?? "/account");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in.");
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label>
        Email address
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          ref={emailRef}
        />
      </label>
      <label>
        Password
        <span className="password-field">
          <input
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
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
      <div className="auth-form-row">
        <span />
        <Link href="/account/forgot-password">Forgot password?</Link>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button full-button" type="submit" disabled={busy}>
        <LogIn aria-hidden="true" size={17} /> {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="field-help">
        No account yet? <Link href="/account/sign-up">Create one</Link>.
        {" "}<Link href="/recover-registration">Manage my registration without an account</Link>.
      </p>
    </form>
  );
}

export function AttendeeAuthReturn() {
  const router = useRouter();

  useEffect(() => {
    attendeeAuthReturnPathFromHash(window.location.hash);
    const returnTo = takeAttendeeAuthReturnPath();
    if (returnTo) router.replace(returnTo);
  }, [router]);

  return null;
}
