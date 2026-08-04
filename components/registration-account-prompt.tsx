import { ExternalLink, UserRoundPlus } from "lucide-react";

function accountPath(
  path: "/account/sign-up" | "/account/sign-in",
  email: string,
  returnTo?: string,
) {
  const parameters = new URLSearchParams();
  const normalized = email.trim();
  if (normalized) parameters.set("email", normalized);
  if (returnTo) parameters.set("returnTo", returnTo);
  const fragment = parameters.toString();
  // The fragment keeps the address and private management path out of server,
  // proxy, analytics, and referrer logs.
  return fragment ? `${path}#${fragment}` : path;
}

export function RegistrationAccountPrompt({
  email,
  embedded,
  returnTo,
  intended = false,
}: {
  email: string;
  embedded: boolean;
  returnTo?: string;
  intended?: boolean;
}) {
  const externalNavigation = embedded
    ? { target: "_blank" as const, rel: "noopener noreferrer" }
    : {};
  return (
    <section className="public-registration-account-prompt">
      <span><UserRoundPlus size={22} aria-hidden="true" /></span>
      <div>
        <p className="public-registration-eyebrow">
          {intended ? "Your optional next step" : "Optional account"}
        </p>
        <h2>Create an optional account to manage future registrations</h2>
        <p>
          View registrations across events, see the attendees registered with
          this contact email, and return without requesting another private link.
        </p>
        <p>
          The registration holder is the contact person, attendees are the people
          registered, and an account is a separate sign-in verified through email.
        </p>
        <div className="public-registration-account-actions">
          <a {...externalNavigation} href={accountPath("/account/sign-up", email, returnTo)}>
            Create account <ExternalLink size={15} aria-hidden="true" />
          </a>
          <a {...externalNavigation} href={accountPath("/account/sign-in", email, returnTo)}>
            Sign in to an existing account <ExternalLink size={15} aria-hidden="true" />
          </a>
          <a {...externalNavigation} href="/recover-registration">
            Email me a private registration link <ExternalLink size={15} aria-hidden="true" />
          </a>
        </div>
        <small>
          No account is required. Your confirmation code and private link still
          manage this registration. We verify the account email before matching
          registrations, and setup does not change the registration holder,
          attendees, or payment history. If an account already uses this email,
          no duplicate account is created.
        </small>
      </div>
    </section>
  );
}
