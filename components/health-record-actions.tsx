"use client";

import { useState } from "react";

type LinkRow = { id: string; recipientEmail: string; state: "OPEN" | "USED" | "REVOKED" | "EXPIRED"; expiresAt: string };

const stateLabel = { OPEN: "Waiting", USED: "Submitted", REVOKED: "Withdrawn", EXPIRED: "Expired" } as const;

/** Confirm-for-the-year, send a parent link, and withdraw one (#611). No health value passes through here. */
export function HealthRecordActions({
  organizationId,
  memberId,
  canConfirm,
  links,
}: {
  organizationId: string;
  memberId: string;
  canConfirm: boolean;
  links: LinkRow[];
}) {
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/health/${encodeURIComponent(memberId)}`;
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function call(url: string, method: string, body?: unknown, success = "Done.") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) {
        setError(result.message ?? "That didn't work. Please try again.");
        return;
      }
      setMessage(success);
      window.location.reload();
    } catch {
      setError("That didn't work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="public-manage-card form-stack">
      <h3>Keep this record current</h3>
      {canConfirm && (
        <button className="secondary-button" disabled={busy} onClick={() => void call(`${base}/confirm`, "POST", undefined, "Confirmed for this club year.")} type="button">
          Confirm this record is still correct for this club year
        </button>
      )}
      <form
        className="club-form-send"
        onSubmit={(event) => {
          event.preventDefault();
          void call(`${base}/links`, "POST", { recipientEmail: email }, "The private link was sent.");
        }}
      >
        <label>Send the parent a private link (works once, then expires)
          <input autoComplete="off" onChange={(event) => setEmail(event.target.value)} placeholder="parent@example.org" required type="email" value={email} />
        </label>
        <button className="primary-button" disabled={busy} type="submit">Send link</button>
      </form>
      {links.length > 0 && (
        <ul>
          {links.map((link) => (
            <li key={link.id}>
              {link.recipientEmail}: {stateLabel[link.state]}
              {link.state === "OPEN" && (
                <button className="secondary-button" disabled={busy} onClick={() => void call(`${base}/links/${encodeURIComponent(link.id)}`, "DELETE", undefined, "Withdrawn.")} type="button">
                  Withdraw
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && <div className="inline-notice success" role="status">{message}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
    </section>
  );
}
