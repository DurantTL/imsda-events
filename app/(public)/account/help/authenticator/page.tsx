import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

export const metadata: Metadata = {
  title: "Setting up an authenticator app",
  description: "How to install and use an authenticator app for IMSDA Events two-step sign-in.",
  robots: { index: false, follow: false },
};

/**
 * A short, static help page for the authenticator option in two-step
 * sign-in. Linked from the sign-up and account-security screens; it needs no
 * account and no server data, so it is a plain page.
 */
export default function AuthenticatorHelpPage() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">Two-step sign-in</p>
          <h1>Setting up an authenticator app</h1>
          <p>
            An authenticator app shows a fresh six-digit code every thirty seconds. You enter that
            code, along with your password, when this account needs a second step. It works without
            a network connection once it is set up.
          </p>
        </div>
        <div className="auth-form">
          <p>
            <strong>1. Install an app.</strong> Any of these work — pick whichever you already have,
            or one that matches your phone:
          </p>
          <ul className="password-requirements" aria-label="Authenticator apps">
            <li data-met="true"><span>Google Authenticator (iOS and Android)</span></li>
            <li data-met="true"><span>Microsoft Authenticator (iOS and Android)</span></li>
            <li data-met="true"><span>Apple Passwords (built in to iPhone and iPad)</span></li>
            <li data-met="true"><span>1Password (if you already use it for other passwords)</span></li>
          </ul>
          <p>
            <strong>2. Add this account.</strong> On the account&apos;s security page, choose
            &quot;Set up an authenticator.&quot; A QR code (or a text key you can type in) appears —
            scan it, or add it, from inside the app you installed.
          </p>
          <p>
            <strong>3. Confirm with a code.</strong> The app now shows a six-digit code for this
            account. Type that code back into IMSDA Events to turn the authenticator on.
          </p>
          <p className="field-help">
            Prefer not to use an app? A passkey — your phone or computer&apos;s own fingerprint, face,
            or screen lock — works just as well and is set up the same way. Only one of the two is
            required.
          </p>
          <p className="field-help">
            <Link href="/account">Back to your account</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
