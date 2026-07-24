import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { LOCAL_DEMO_EMAIL, LOCAL_DEMO_PASSWORD, LoginForm } from "@/components/login-form";
import { getCurrentSession } from "@/modules/access/current-session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if ((await getCurrentSession()).user) redirect("/overview");

  // The seeded account exists only in a local database (`prisma/seed.ts`
  // refuses to run anywhere else). A production sign-in page shows no
  // credential at all.
  const showLocalCredentials = process.env.NODE_ENV !== "production";

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
        <LoginForm demoCredentials={showLocalCredentials} />
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
