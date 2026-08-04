import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { PublicRegistrationRecoveryForm } from "@/components/public-registration-recovery-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Manage your registration",
  description: "Open or recover access to an IMSDA event registration.",
  robots: { index: false, follow: false, nocache: true },
};

export default async function RecoverRegistrationPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const requestedReturnTo = (await searchParams).returnTo;
  const returnTo = typeof requestedReturnTo === "string"
    ? requestedReturnTo
    : undefined;
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">Private registration access</p>
          <h1>Manage my registration</h1>
          <p>
            Enter the confirmation code and contact email to open your registration.
            An account is not required, and you can request a private link if you
            no longer have the code.
          </p>
        </div>
        <PublicRegistrationRecoveryForm returnTo={returnTo} />
      </section>
    </main>
  );
}
