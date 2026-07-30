import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { PublicRegistrationRecoveryForm } from "@/components/public-registration-recovery-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recover your registration",
  description: "Request a new private link for an IMSDA event registration.",
  robots: { index: false, follow: false, nocache: true },
};

export default function RecoverRegistrationPage() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">Private registration access</p>
          <h1>Recover your registration</h1>
          <p>
            Enter the confirmation code and contact email from your registration.
            We will email a fresh, expiring private management link when they match.
          </p>
        </div>
        <PublicRegistrationRecoveryForm />
      </section>
    </main>
  );
}
