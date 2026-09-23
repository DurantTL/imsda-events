import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { RosterUnlockForm } from "@/components/roster-unlock-form";
import type { RosterAccessState } from "@/modules/club-rosters/access";

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="public-manage-card">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Protected club information</p>
        <h2>{title}</h2>
      </div>
      <div className="public-manage-security-note">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>{children}</div>
      </div>
    </section>
  );
}

/** The step a director still needs before club rosters and registration open, or nothing. */
export function ClubAccessGate({ access }: { access: RosterAccessState }) {
  if (access.state === "OWN_SESSION_REQUIRED") {
    return (
      <Gate title="Sign in with your own account">
        <p>Club rosters open only in your own attendee sign-in, not from the staff workspace.</p>
      </Gate>
    );
  }
  if (access.state === "MFA_SETUP") {
    return (
      <Gate title="Set up an authenticator first">
        <p>
          Rosters hold birth dates for young people, so they need two-step sign-in.{" "}
          <Link href="/account">Set up an authenticator on your account</Link>, then come back.
        </p>
      </Gate>
    );
  }
  if (access.state === "MFA_UNLOCK") {
    return (
      <Gate title="Enter your authenticator code">
        <p>Enter the six-digit code from your authenticator app to open your club for this session.</p>
        <RosterUnlockForm />
      </Gate>
    );
  }
  return null;
}
