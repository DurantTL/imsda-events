import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { getCurrentSession } from "@/modules/access/current-session";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in to edit your profile",
  robots: { index: false, follow: false },
};

/**
 * Where a signed-out visitor to `/profile` lands (#543). Staff and attendee
 * sign-ins are separate (ADR 0003), so this only offers both entry points; it
 * says nothing about whether any account exists.
 */
export default async function ProfileSignInPage() {
  const [{ user }, { account }] = await Promise.all([getCurrentSession(), getCurrentAttendee()]);
  if (user || account) redirect("/profile");

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">Edit profile</p>
          <h1>Sign in first</h1>
          <p>Choose how you usually sign in to IMSDA Events.</p>
        </div>
        <Link className="primary-button" href="/account/sign-in">Sign in to my registrations</Link>
        <p className="auth-divider"><span>or</span></p>
        <Link className="secondary-button" href={`/login?next=${encodeURIComponent("/profile")}`}>Staff sign in</Link>
      </section>
    </main>
  );
}
