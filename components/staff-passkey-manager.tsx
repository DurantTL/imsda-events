"use client";

import { useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, Pencil, Plus, Trash2 } from "lucide-react";
import { passkeyPromptMessage, postPasskeyJson } from "@/components/passkey-unlock-button";
import type { ChangeVerificationMethods, StaffPasskeySummary } from "@/modules/access/passkeys";

function friendlyDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Passkeys on the staff account settings panel (#429): sign in with a
 * fingerprint, face, or PIN instead of a password and a code — a passkey is
 * phishing-resistant multi-factor on its own.
 *
 * Adding or removing one needs a fresh proof sent with the request itself:
 * an authenticator or recovery code, an existing passkey, or — only when the
 * account has no authenticator — the current password. Renaming doesn't.
 */
type ChangeProof = { code?: string; password?: string; passkey?: unknown };
type PendingChange = { kind: "add" } | { kind: "remove"; passkey: StaffPasskeySummary };

export function StaffPasskeyManager({
  initialPasskeys,
  available,
  verification,
}: {
  initialPasskeys: StaffPasskeySummary[];
  /** Whether an administrator has switched passkeys on for this site. */
  available: boolean;
  /** Which proofs this account could give when the page loaded. */
  verification: ChangeVerificationMethods;
}) {
  const [passkeys, setPasskeys] = useState(initialPasskeys);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Mirrors the server's rule, kept current as passkeys come and go.
  const canUseCode = verification.code;
  const canUsePasskey = passkeys.length > 0;
  const canUsePassword = !canUseCode;

  function startChange(change: PendingChange) {
    setPending(change);
    setSecret("");
    setError("");
    setNotice("");
  }

  function cancelChange() {
    setPending(null);
    setSecret("");
  }

  async function existingPasskeyProof(): Promise<ChangeProof> {
    const { options } = await postPasskeyJson("/api/auth/passkeys/verification/options");
    const response = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
    return { passkey: response };
  }

  async function add(proof: ChangeProof) {
    const { options } = await postPasskeyJson("/api/auth/passkeys/registration/options", { proof });
    const response = await startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"] });
    const result = await postPasskeyJson("/api/auth/passkeys/registration", { response, name });
    setPasskeys(result.passkeys as StaffPasskeySummary[]);
    setName("");
    setNotice("Passkey added. You can sign in with it next time.");
  }

  async function remove(passkey: StaffPasskeySummary, proof: ChangeProof) {
    const response = await fetch(`/api/auth/passkeys/${encodeURIComponent(passkey.id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proof }),
    });
    const result = await response.json().catch(() => ({})) as { passkeys?: StaffPasskeySummary[]; message?: string };
    if (!response.ok || !result.passkeys) throw new Error(result.message ?? "That passkey couldn't be removed.");
    setPasskeys(result.passkeys);
    setNotice("Passkey removed.");
  }

  async function confirmChange(useExistingPasskey: boolean) {
    if (!pending) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const proof: ChangeProof = useExistingPasskey
        ? await existingPasskeyProof()
        : canUseCode ? { code: secret } : { password: secret };
      if (pending.kind === "add") await add(proof);
      else await remove(pending.passkey, proof);
      setPending(null);
    } catch (caught) {
      setError(passkeyPromptMessage(caught, pending.kind === "add" ? "That passkey couldn't be added." : "That passkey couldn't be removed."));
    } finally {
      setSecret("");
      setBusy(false);
    }
  }

  async function rename(passkey: StaffPasskeySummary) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/auth/passkeys/${encodeURIComponent(passkey.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameValue }),
      });
      const result = await response.json().catch(() => ({})) as { passkeys?: StaffPasskeySummary[]; message?: string };
      if (!response.ok || !result.passkeys) throw new Error(result.message ?? "That passkey couldn't be renamed.");
      setPasskeys(result.passkeys);
      setRenamingId(null);
      setNotice("Passkey renamed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That passkey couldn't be renamed.");
    } finally {
      setBusy(false);
    }
  }

  const confirmPanel = pending && (
    <form
      aria-labelledby="staff-passkey-confirm-heading"
      className="passkey-confirm"
      onSubmit={(event) => { event.preventDefault(); void confirmChange(false); }}
    >
      <p id="staff-passkey-confirm-heading">
        <strong>
          {pending.kind === "add" ? "Confirm it's you to add a passkey." : `Confirm it's you to remove "${pending.passkey.name}".`}
        </strong>
      </p>
      {(canUseCode || canUsePassword) && (
        <label>
          {canUseCode ? "Authenticator code or recovery code" : "Current password"}
          <input
            autoComplete={canUseCode ? "one-time-code" : "current-password"}
            inputMode={canUseCode ? "numeric" : undefined}
            maxLength={canUseCode ? 32 : 128}
            onChange={(event) => setSecret(event.target.value)}
            type={canUseCode ? "text" : "password"}
            value={secret}
          />
        </label>
      )}
      <span className="passkey-actions">
        {(canUseCode || canUsePassword) && (
          <button className="primary-button" disabled={busy || !secret} type="submit">
            {busy ? "Checking…" : pending.kind === "add" ? "Continue" : "Remove passkey"}
          </button>
        )}
        {canUsePasskey && (
          <button className="secondary-button" disabled={busy} onClick={() => void confirmChange(true)} type="button">
            <Fingerprint aria-hidden="true" size={15} /> Use an existing passkey
          </button>
        )}
        <button className="secondary-button" disabled={busy} onClick={cancelChange} type="button">Cancel</button>
      </span>
    </form>
  );

  return (
    <section className="panel passkey-manager" aria-labelledby="staff-passkeys-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Sign-in</p>
          <h2 id="staff-passkeys-heading"><Fingerprint size={20} aria-hidden="true" /> Passkeys</h2>
        </div>
      </div>
      <p>
        Sign in with your phone or computer&apos;s fingerprint, face, or PIN instead of your password —
        no separate code needed, since a passkey already proves it&apos;s you.
      </p>

      {!available ? (
        <p className="quiet-copy">Passkeys aren&apos;t turned on for this site yet. Your password (and authenticator, if required) works as before.</p>
      ) : (
        <>
          {notice && <div className="inline-notice success" role="status">{notice}</div>}
          {error && <div className="inline-notice error" role="alert">{error}</div>}

          {passkeys.length > 0 && (
            <ul className="passkey-list">
              {passkeys.map((passkey) => (
                <li key={passkey.id}>
                  <Fingerprint size={18} aria-hidden="true" />
                  {renamingId === passkey.id ? (
                    <span className="passkey-rename">
                      <input
                        aria-label={`Rename ${passkey.name}`}
                        maxLength={60}
                        onChange={(event) => setRenameValue(event.target.value)}
                        value={renameValue}
                      />
                      <button className="secondary-button" disabled={busy} onClick={() => rename(passkey)} type="button">Save</button>
                      <button className="secondary-button" disabled={busy} onClick={() => setRenamingId(null)} type="button">Cancel</button>
                    </span>
                  ) : (
                    <span>
                      <strong>{passkey.name}</strong>
                      <small>
                        Added {friendlyDate(passkey.createdAt)}
                        {passkey.lastUsedAt ? ` · last used ${friendlyDate(passkey.lastUsedAt)}` : " · not used yet"}
                        {passkey.backedUp ? " · synced to your other devices" : ""}
                      </small>
                    </span>
                  )}
                  {renamingId !== passkey.id && (
                    <span className="passkey-actions">
                      <button
                        aria-label={`Rename ${passkey.name}`}
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => { setRenamingId(passkey.id); setRenameValue(passkey.name); }}
                        type="button"
                      >
                        <Pencil aria-hidden="true" size={15} />
                      </button>
                      <button
                        aria-label={`Remove ${passkey.name}`}
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => startChange({ kind: "remove", passkey })}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={15} />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="passkey-add">
            <label>
              Name (optional)
              <input maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="e.g. My laptop" value={name} />
            </label>
            <button className="primary-button" disabled={busy || pending !== null} onClick={() => startChange({ kind: "add" })} type="button">
              <Plus aria-hidden="true" size={16} /> Add a passkey
            </button>
          </div>
          {confirmPanel}
        </>
      )}
    </section>
  );
}
