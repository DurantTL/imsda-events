"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { PasskeyUnlockButton, passkeyPromptMessage, postPasskeyJson } from "@/components/passkey-unlock-button";
import { RosterUnlockForm } from "@/components/roster-unlock-form";
import type { PasskeySummary } from "@/modules/attendee-accounts/passkeys";

function friendlyDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Passkeys on the Security page: a second step that uses the phone or
 * computer's own unlock (fingerprint, face, or PIN) instead of typing a code.
 */
export function PasskeyManager({
  initialPasskeys,
  available,
  needsConfirmation,
  hasAuthenticator,
  onAdded,
}: {
  initialPasskeys: PasskeySummary[];
  /** Whether an administrator has switched passkeys on for this site. */
  available: boolean;
  /** Whether this session must confirm with an existing second step before changes. */
  needsConfirmation: boolean;
  hasAuthenticator: boolean;
  /** Called once a new passkey is added. */
  onAdded?: () => void;
}) {
  const [passkeys, setPasskeys] = useState(initialPasskeys);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function add() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { options } = await postPasskeyJson("/api/attendee/passkeys/registration/options");
      const response = await startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"] });
      const result = await postPasskeyJson("/api/attendee/passkeys/registration", { response, name });
      setPasskeys(result.passkeys as PasskeySummary[]);
      setName("");
      setNotice("Passkey added. You can use it to open your club next time.");
      onAdded?.();
    } catch (caught) {
      setError(passkeyPromptMessage(caught, "That passkey couldn't be added."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(passkey: PasskeySummary) {
    if (!window.confirm(`Remove "${passkey.name}"? It will stop working on this account.`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/attendee/passkeys/${encodeURIComponent(passkey.id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({})) as { passkeys?: PasskeySummary[]; message?: string };
      if (!response.ok || !result.passkeys) throw new Error(result.message ?? "That passkey couldn't be removed.");
      setPasskeys(result.passkeys);
      setNotice("Passkey removed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That passkey couldn't be removed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="public-manage-card passkey-manager" aria-labelledby="passkeys-heading">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Sign-in and second step</p>
        <h2 id="passkeys-heading"><Fingerprint size={20} aria-hidden="true" /> Passkeys</h2>
      </div>
      <p>
        Use your phone or computer&apos;s fingerprint, face, or PIN instead of typing a code. It works
        anywhere your authenticator code does, and you can keep both. You can also sign in with a passkey
        instead of your password; that counts as the second step too.
      </p>

      {!available ? (
        <p className="public-manage-empty">Passkeys aren&apos;t turned on for this site yet. Your authenticator app works as before.</p>
      ) : (
        <>
          {notice && <div className="inline-notice success" role="status">{notice}</div>}
          {error && <div className="inline-notice error" role="alert">{error}</div>}

          {passkeys.length > 0 && (
            <ul className="passkey-list">
              {passkeys.map((passkey) => (
                <li key={passkey.id}>
                  <Fingerprint size={18} aria-hidden="true" />
                  <span>
                    <strong>{passkey.name}</strong>
                    <small>
                      Added {friendlyDate(passkey.createdAt)}
                      {passkey.lastUsedAt ? ` · last used ${friendlyDate(passkey.lastUsedAt)}` : " · not used yet"}
                      {passkey.backedUp ? " · synced to your other devices" : ""}
                    </small>
                  </span>
                  <button
                    aria-label={`Remove ${passkey.name}`}
                    className="secondary-button"
                    disabled={busy || needsConfirmation}
                    onClick={() => remove(passkey)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {needsConfirmation ? (
            <div className="public-manage-security-note">
              <ShieldCheck size={20} aria-hidden="true" />
              <div>
                <strong>Confirm it&apos;s you to add or remove a passkey</strong>
                <p>This keeps someone who only knows your password from adding their own device.</p>
                {passkeys.length > 0 && <PasskeyUnlockButton label="Confirm with a passkey" />}
                {hasAuthenticator && <RosterUnlockForm label="Confirm with a code" />}
              </div>
            </div>
          ) : (
            <div className="passkey-add">
              <label>
                Name (optional)
                <input maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="e.g. My iPhone" value={name} />
              </label>
              <button className="primary-button" disabled={busy} onClick={add} type="button">
                <Plus aria-hidden="true" size={16} /> {busy ? "Waiting for your device…" : "Add a passkey"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
