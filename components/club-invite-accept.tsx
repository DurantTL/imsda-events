"use client";

import { useState } from "react";
import { Check, Mail } from "lucide-react";
import { clubDirectorRoleLabels, type ClubRole } from "@/modules/organizations/director-grants-domain";

type Invite = { id: string; role: ClubRole; clubId: string; clubName: string };

/** Club invites waiting on this account (#376), each with an Accept button. */
export function ClubInviteAccept({ invites }: { invites: Invite[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function accept(invite: Invite) {
    setBusy(invite.id);
    setError("");
    try {
      const response = await fetch(`/api/attendee/club-invites/${encodeURIComponent(invite.id)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json().catch(() => ({})) as { clubUrl?: string; message?: string };
      if (!response.ok || !result.clubUrl) throw new Error(result.message ?? "The invite could not be accepted.");
      window.location.assign(result.clubUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invite could not be accepted.");
      setBusy(null);
    }
  }

  return (
    <section className="public-manage-card club-invite-card" aria-labelledby="club-invite-heading">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow"><Mail size={15} aria-hidden="true" /> Club invite</p>
        <h2 id="club-invite-heading">{invites.length === 1 ? "You're invited to manage a club" : "You're invited to manage clubs"}</h2>
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <ul className="public-manage-club-list">
        {invites.map((invite) => (
          <li key={invite.id}>
            <span>
              <strong translate="no">{invite.clubName}</strong>
              <small>As {clubDirectorRoleLabels[invite.role].toLocaleLowerCase("en-US")}, from the Iowa-Missouri Conference</small>
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
