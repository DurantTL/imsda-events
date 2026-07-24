import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { PasswordResetRequestForm } from "@/components/password-reset-request-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  // Email delivery for account recovery is not wired yet. Say so plainly
  // rather than promising a link that production will never show or send.
  //
  // Read NODE_ENV directly rather than through getServerEnv(): this page is
  // prerendered, and a build has no deployment secrets to validate against.
  const linkShownOnPage = process.env.NODE_ENV !== "production";

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
              ? "Enter your staff email. In this local build, the reset link appears on this page instead of being emailed."
              : "Enter your staff email. Recovery email is not yet enabled, so ask an event administrator to send you a new one-time link."}
          </p>
        </div>
        <PasswordResetRequestForm />
      </section>
    </main>
  );
}
