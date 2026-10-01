"use client";

import { useState } from "react";
import { LogOut, MonitorSmartphone } from "lucide-react";

type SignedInSession = {
  id: string;
  isCurrent: boolean;
  startedAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

function when(value: string) {
  return new Date(value).toLocaleString();
}

export function SessionManager({
  initialSessions,
  idleTimeoutSeconds,
}: {
  initialSessions: SignedInSession[];
  idleTimeoutSeconds: number;
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const others = sessions.filter((session) => !session.isCurrent);

  async function revokeOthers() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/auth/sessions", { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to sign out the other devices.");
      setSessions(result.sessions);
      setMessage(
        result.revoked === 0
          ? "There were no other signed-in devices."
          : `Signed out ${result.revoked} other device${result.revoked === 1 ? "" : "s"}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign out the other devices.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Your account</p>
          <h2>Signed-in devices</h2>
        </div>
        <span className="count-badge">
          <MonitorSmartphone aria-hidden="true" size={16} /> {sessions.length} active
        </span>
      </div>
      <p className="quiet-copy">
        A session ends after {Math.round(idleTimeoutSeconds / 60)} minutes of inactivity, and
        after 8 hours in any case. Sign out the others if you have left one open on a shared
        check-in tablet.
      </p>
      <div className="activity-list">
        {sessions.map((session) => (
          <article className="activity-row" key={session.id}>
            <span className="activity-icon">
              <MonitorSmartphone aria-hidden="true" size={16} />
            </span>
            <span>
              <strong>{session.isCurrent ? "This device" : "Another device"}</strong>
              <small>
                Last active {when(session.lastSeenAt)} · signed in {when(session.startedAt)}
              </small>
            </span>
            {session.isCurrent && <code>current</code>}
          </article>
        ))}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="quiet-copy" role="status">{message}</p>}
      <button
        className="secondary-button"
        type="button"
        onClick={revokeOthers}
        disabled={busy || others.length === 0}
      >
        <LogOut aria-hidden="true" size={16} />
        {busy ? "Signing out…" : ` Sign out ${others.length} other device${others.length === 1 ? "" : "s"}`}
      </button>
    </section>
  );
}
