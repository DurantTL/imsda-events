import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { AttendeeSignInForm } from "@/components/attendee-sign-in-form";
import {
  AttendeeGoogleButton,
  attendeeSignInErrorMessage,
} from "@/components/attendee-google-button";
import { isGoogleSignInConfigured } from "@/integrations/oauth/google";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in to your registrations",
  description: "Sign in to see every IMSDA event registration made with your email address.",
  robots: { index: false, follow: false },
};

export default async function AttendeeSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if ((await getCurrentAttendee()).account) redirect("/account");

  const { error } = await searchParams;
  const errorMessage = attendeeSignInErrorMessage(error);
  const googleAvailable = isGoogleSignInConfigured();

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">Your registrations</p>
          <h1>Welcome back</h1>
          <p>Sign in to see every registration made with your email address.</p>
        </div>
        {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
        {googleAvailable && (
          <>
            <AttendeeGoogleButton label="Sign in with Google" />
            <p className="auth-divider"><span>or</span></p>
          </>
        )}
        <AttendeeSignInForm />
      </section>
    </main>
  );
}
