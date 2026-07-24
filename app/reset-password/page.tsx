import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { PasswordResetForm } from "@/components/password-reset-form";
import { describeAccountToken } from "@/modules/access/auth-service";

export const metadata: Metadata = { title: "Choose a password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const described = token ? await describeAccountToken(token) : null;
  const activating = described?.purpose === "ACCOUNT_ACTIVATION";

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">{activating ? "Account activation" : "Account recovery"}</p>
          <h1>{activating ? "Activate your account" : "Choose a new password"}</h1>
          <p>
            {activating
              ? "Choose the password for your new staff account. This single-use link expires seven days after it was created."
              : "This single-use link expires 30 minutes after it is created."}
          </p>
        </div>
        <PasswordResetForm token={token} />
      </section>
    </main>
  );
}
