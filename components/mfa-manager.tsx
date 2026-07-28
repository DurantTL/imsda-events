"use client";

import { useState } from "react";
import { KeyRound, ShieldCheck, ShieldAlert } from "lucide-react";
import { OneTimeCodeInput } from "@/components/one-time-code-input";

export type MfaStatus = {
  required: boolean;
  status: "NONE" | "PENDING" | "ACTIVE";
  confirmedAt: string | null;
  lastVerifiedAt: string | null;
  unusedRecoveryCodes: number;
};

/**
 * Managing the second factor from account settings.
 *
 * An account whose role requires MFA is enrolled during sign-in instead — it
 * never reaches a session without one — so what this panel adds is enrolling
 * *before* that role is granted, and replacing recovery codes after using them.
 */
export function MfaManager({ initialStatus }: { initialStatus: MfaStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [offer, setOffer] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "That could not be completed.");
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be completed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function begin() {
    const result = await call({ action: "begin" });
    if (result) {
      setRecoveryCodes(null);
      setOffer(result);
    }
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await call({ action: "confirm", code: form.get("code") });
    if (result) {
      setOffer(null);
      setStatus(result.status);
      setRecoveryCodes(result.recoveryCodes);
    }
  }

  async function regenerate() {
    const result = await call({ action: "regenerate-recovery-codes" });
    if (result) {
      setRecoveryCodes(result.recoveryCodes);
      setStatus({ ...status, unusedRecoveryCodes: result.recoveryCodes.length });
    }
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await call({ action: "disable", code: form.get("code") });
    if (result) {
      setStatus(result.status);
      setRecoveryCodes(null);
    }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Account security</p>
          <h2>Two-factor authentication</h2>
        </div>
        <span className="count-badge">
          {status.status === "ACTIVE"
            ? <><ShieldCheck aria-hidden="true" size={16} /> On</>
            : <><ShieldAlert aria-hidden="true" size={16} /> Off</>}
        </span>
      </div>

      {status.status === "ACTIVE" ? (
        <p className="quiet-copy">
          An authenticator is protecting this account
          {status.confirmedAt ? ` since ${new Date(status.confirmedAt).toLocaleDateString()}` : ""}.
          {" "}{status.unusedRecoveryCodes} recovery code{status.unusedRecoveryCodes === 1 ? "" : "s"} remain unused.
        </p>
      ) : (
        <p className="quiet-copy">
          {status.required
            ? "This account administers events, so a second factor is required. You will be asked to set one up the next time you sign in."
            : "Add a second factor so a leaked password is not enough to sign in as you. Accounts that administer events are required to have one."}
        </p>
      )}

      {recoveryCodes && (
        <div className="auth-success">
          <strong>Save your recovery codes</strong>
          <p>Each signs you in once if you lose your authenticator. They are shown only now.</p>
          <ul className="recovery-code-list">
            {recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}
          </ul>
        </div>
      )}

      {offer && (
        <form className="form-stack" onSubmit={confirm}>
          <p className="field-help">
            Add this key to an authenticator app, then enter the code it shows. Nothing changes
            until a code is confirmed.
          </p>
          <input
            className="copy-field"
            readOnly
            value={offer.secret}
            onFocus={(event) => event.currentTarget.select()}
          />
          <OneTimeCodeInput label="Code from your authenticator" />
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={() => setOffer(null)}>Cancel</button>
            <button className="primary-button" type="submit" disabled={busy}>
              <ShieldCheck size={16} /> {busy ? "Confirming…" : "Confirm and turn on"}
            </button>
          </div>
        </form>
      )}

      {!offer && status.status !== "ACTIVE" && (
        <>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" type="button" disabled={busy} onClick={begin}>
            <ShieldCheck size={16} /> {busy ? "Preparing…" : "Set up an authenticator"}
          </button>
        </>
      )}

      {!offer && status.status === "ACTIVE" && (
        <>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="secondary-button" type="button" disabled={busy} onClick={regenerate}>
            <KeyRound size={16} /> Issue new recovery codes
          </button>
          {!status.required && (
            <form className="form-stack" onSubmit={disable}>
              <OneTimeCodeInput label="Remove the authenticator — enter a current code to confirm" />
              <div className="form-actions">
                <button className="secondary-button" type="submit" disabled={busy}>Turn off two-factor</button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
