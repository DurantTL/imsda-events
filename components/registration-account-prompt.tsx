import { ExternalLink, UserRoundPlus } from "lucide-react";

function accountSignUpPath(email: string) {
  const normalized = email.trim();
  return normalized
    // A fragment reaches the new tab without putting the address in server,
    // proxy, analytics, or referrer logs.
    ? `/account/sign-up#email=${encodeURIComponent(normalized)}`
    : "/account/sign-up";
}

export function RegistrationAccountPrompt({
  email,
  embedded,
}: {
  email: string;
  embedded: boolean;
}) {
  return (
    <section className="public-registration-account-prompt">
      <span><UserRoundPlus size={22} aria-hidden="true" /></span>
      <div>
        <p className="public-registration-eyebrow">Optional next step</p>
        <h2>Keep every registration in one account</h2>
        <p>
          Create an attendee account with the same email used here. This
          registration—and future ones using that address—will appear together.
        </p>
        <a
          href={accountSignUpPath(email)}
          {...(embedded
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
        >
          Create attendee account <ExternalLink size={15} aria-hidden="true" />
        </a>
        <small>
          Your registration and private management link work without an account.
        </small>
      </div>
    </section>
  );
}
