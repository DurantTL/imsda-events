import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { AttendeeSignInForm } from "@/components/attendee-sign-in-form";
import {
  AttendeeGoogleButton,
  attendeeSignInErrorMessage,
} from "@/components/attendee-google-button";
import { isGoogleSignInConfigured } from "@/integrations/oauth/google";
import { PasskeySignInButton } from "@/components/passkey-sign-in-button";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { passkeysConfigured } from "@/modules/attendee-accounts/passkeys";
import { attendeeReturnDestination } from "@/modules/attendee-accounts/return-destination";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in to your registrations",
  description: "Sign in to see every IMSDA event registration made with your email address.",
  robots: { index: false, follow: false },
};

export default async function AttendeeSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string | string[] }>;
}) {
  const { error, next: rawNext } = await searchParams;
  // A repeated `?next=` arrives as an array; only a single value is used. It is
  // validated again wherever it is followed (#568).
  const next = typeof rawNext === "string" ? rawNext : undefined;
  if ((await getCurrentAttendee()).account) redirect(attendeeReturnDestination(next, "/account"));


  const errorMessage = attendeeSignInErrorMessage(error);
  const googleAvailable = isGoogleSignInConfigured();
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
          <p className="eyebrow">Your registrations</p>
          <h1>Welcome back</h1>
          <p>Sign in to see every registration made with your email address.</p>
        </div>
        {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
        {(googleAvailable || passkeysAvailable) && (
          <>
            {passkeysAvailable && <PasskeySignInButton next={next} />}
            {googleAvailable && <AttendeeGoogleButton label="Sign in with Google" />}
            <p className="auth-divider"><span>or</span></p>
          </>
        )}
        <AttendeeSignInForm next={next} />
      </section>
    </main>
  );
}
