import { ShieldCheck } from "lucide-react";
import { PasskeyUnlockButton } from "@/components/passkey-unlock-button";
import { RosterUnlockForm } from "@/components/roster-unlock-form";

/**
 * Shown to an Area Coordinator whose second sign-in step is too old to open a
 * health record (#611). It is the roster's own unlock (the same code form and
 * passkey button the roster's "Confirm it's you" state uses), because
 * /account/two-step does not refresh a step that was verified long ago.
 */
export function HealthStepUp({ methods }: { methods: { code: boolean; passkey: boolean } }) {
  return (
    <section className="public-manage-card">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Protected health information</p>
        <h2>Confirm it&apos;s you</h2>
      </div>
      <div className="public-manage-security-note">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <p>
            {methods.passkey && methods.code
              ? "Use your passkey, or enter the six-digit code from your authenticator app, to open health records for this session."
              : methods.passkey
                ? "Use your passkey to open health records for this session."
                : "Enter the six-digit code from your authenticator app to open health records for this session."}
          </p>
          {methods.passkey && <PasskeyUnlockButton label="Open with a passkey" />}
          {methods.code && <RosterUnlockForm label="Open health records" />}
        </div>
      </div>
    </section>
  );
}
