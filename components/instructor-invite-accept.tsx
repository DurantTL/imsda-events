"use client";

import { useState } from "react";
import { Check, Mail } from "lucide-react";

type Invite = { id: string; eventName: string; classNames: string[] };

/** Instructor invites waiting on this account (#833), each with an Accept button. */
export function InstructorInviteAccept({ invites }: { invites: Invite[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function accept(invite: Invite) {
    setBusy(invite.id);
    setError("");
    try {
      const response = await fetch(`/api/attendee/honor-instructor/invites/${encodeURIComponent(invite.id)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json().catch(() => ({})) as { classesUrl?: string; message?: string };
      if (!response.ok || !result.classesUrl) throw new Error(result.message ?? "The invite could not be accepted.");
      window.location.assign(result.classesUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invite could not be accepted.");
      setBusy(null);
    }
  }

  return (
    <section className="public-manage-card club-invite-card" aria-labelledby="instructor-invite-heading">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow"><Mail size={15} aria-hidden="true" /> Instructor invite</p>
        <h2 id="instructor-invite-heading">{invites.length === 1 ? "You're invited to teach" : "You're invited to teach at these events"}</h2>
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <ul className="public-manage-club-list">
        {invites.map((invite) => (
          <li key={invite.id}>
            <span>
              <strong translate="no">{invite.eventName}</strong>
              <small translate="no">{invite.classNames.join(", ")}</small>
            </span>
            <button className="primary-button" disabled={busy !== null} onClick={() => accept(invite)} type="button">
              <Check aria-hidden="true" size={14} /> {busy === invite.id ? "Accepting…" : "Accept"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
