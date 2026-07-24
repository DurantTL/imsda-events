import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { PasswordResetRequestForm } from "@/components/password-reset-request-form";
import { isAccountEmailConfigured } from "@/modules/communications/account-email";

export const metadata: Metadata = { title: "Reset password" };

// This page describes what the deployment will actually do with the request, so
// it cannot be decided at build time — a build has no sender address set.
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  const linkShownOnPage = !isAccountEmailConfigured();

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">Account recovery</p>
          <h1>Reset your password</h1>
          <p>
            {linkShownOnPage
              ? "Enter your staff email. This build has no account email configured, so the reset link appears on this page instead of being sent."
              : "Enter your staff email. If an account exists, a one-time link is on its way — it expires thirty minutes after it is sent."}
          </p>
        </div>
        <PasswordResetRequestForm />
      </section>
    </main>
  );
}
