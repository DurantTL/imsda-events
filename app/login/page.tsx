import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { LOCAL_DEMO_EMAIL, LOCAL_DEMO_PASSWORD, LoginForm } from "@/components/login-form";
import { StaffPasskeySignInButton } from "@/components/staff-passkey-sign-in-button";
import { getCurrentSession } from "@/modules/access/current-session";
import { passkeysConfigured } from "@/modules/access/passkeys";
import { resolvePostLoginDestination } from "@/modules/access/post-login-destination";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  // A repeated `?next=` arrives as an array; only a single value is passed on.
  const next = typeof params.next === "string" ? params.next : undefined;
  const session = await getCurrentSession();
  // Already signed in: send them where sign-in itself would have sent them
  // (#108 queue 1), honoring a deep link's `next` target first.
  if (session.user) redirect(await resolvePostLoginDestination(session.user, { returnTo: next }));

  // The seeded account exists only in a local database (`prisma/seed.ts`
  // refuses to run anywhere else). A production sign-in page shows no
  // credential at all.
  const showLocalCredentials = process.env.NODE_ENV !== "production";
  // Hidden until the passkey domain is set in Platform settings.
  const passkeysAvailable = await passkeysConfigured();

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">Staff workspace</p>
          <h1>Welcome back</h1>
          <p>Sign in to manage the events assigned to your account.</p>
        </div>
        {passkeysAvailable && (
          <>
            <StaffPasskeySignInButton next={next} />
            <p className="auth-divider"><span>or</span></p>
          </>
        )}
        <LoginForm demoCredentials={showLocalCredentials} next={next} />
        {showLocalCredentials && (
          <div className="local-credentials">
            <strong>Local test account</strong>
            <span>{LOCAL_DEMO_EMAIL}</span>
            <span>{LOCAL_DEMO_PASSWORD}</span>
            <small>Fictitious local data only</small>
          </div>
        )}
      </section>
    </main>
  );
}
