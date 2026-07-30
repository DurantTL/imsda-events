import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { AttendeeSignUpForm } from "@/components/attendee-sign-up-form";
import {
  AttendeeGoogleButton,
  attendeeSignInErrorMessage,
} from "@/components/attendee-google-button";
import { isGoogleSignInConfigured } from "@/integrations/oauth/google";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Create your account",
  description: "Create an IMSDA Events account to see every registration made with your email address.",
  robots: { index: false, follow: false },
};

export default async function AttendeeSignUpPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
  }>;
}) {
  if ((await getCurrentAttendee()).account) redirect("/account");

  const parameters = await searchParams;
  const error = typeof parameters.error === "string"
    ? parameters.error
    : undefined;
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
          <h1>Create your account</h1>
          <p>
            One place for every registration you have made, across every event, instead of hunting
            through your inbox for the right link.
          </p>
        </div>
        {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
        {googleAvailable && (
          <>
            {/* Above the form on purpose: it is the shorter path, and it needs
              * no password and no emailed code at all. */}
            <AttendeeGoogleButton label="Continue with Google" />
            <p className="auth-divider"><span>or sign up with a password</span></p>
          </>
        )}
        <AttendeeSignUpForm />
      </section>
    </main>
  );
}
