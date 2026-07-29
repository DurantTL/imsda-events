/**
 * The Google sign-in button.
 *
 * A plain link, not a fetch: the flow is a top-level navigation to Google and
 * back, so there is nothing for client-side JavaScript to do here, and a link
 * works before hydration and with scripting off.
 *
 * The mark is inlined rather than fetched. Google's brand guidelines want their
 * own glyph, and pulling it from a CDN would tell Google that this page was
 * loaded before anyone chose to sign in with them.
 */
export function AttendeeGoogleButton({ label }: { label: string }) {
  return (
    <a className="google-button" href="/api/attendee/oauth/google/start">
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
        />
        <path
          fill="#34A853"
          d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
        />
        <path
          fill="#FBBC05"
          d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
        />
        <path
          fill="#EA4335"
          d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
        />
      </svg>
      {label}
    </a>
  );
}

/**
 * What went wrong, in the registrant's terms. The callback can only hand back a
 * code in a query string, so this is where those become sentences.
 *
 * `google-unverified-email` is the one worth reading twice: Google will hand
 * over an address the account merely typed in, and an account here claims
 * registrations by address — so an unverified one has to be refused, and the
 * person has to be told why rather than left staring at a failed sign-in.
 */
export function attendeeSignInErrorMessage(code: string | undefined): string | null {
  switch (code) {
    case undefined:
    case "":
      return null;
    case "google-cancelled":
      return "Google sign-in was cancelled. You can try again, or use a password.";
    case "google-expired":
      return "That sign-in took too long, or was started in another browser. Please try again.";
    case "google-unverified-email":
      return "Google has not verified the email address on that account, so it cannot be used to reach your registrations. Verify the address with Google, or create an account with a password instead.";
    case "google-account-disabled":
      return "That account is not available. Contact the event team if you think this is wrong.";
    case "google-identity-conflict":
      return "This address is already linked to a different Google account. Sign in with your password, or contact the event team.";
    case "google-unavailable":
      return "Google sign-in is not available on this site. Use a password instead.";
    case "rate-limited":
      return "Too many attempts. Wait a few minutes and try again.";
    default:
      return "That sign-in could not be completed. Please try again, or use a password.";
  }
}
