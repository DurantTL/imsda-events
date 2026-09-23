"use client";

import { useState } from "react";
import { Ban, Pencil, Send } from "lucide-react";
import type { ClubInviteRecord } from "@/modules/club-imports/invites";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

type InvitesResponse = { invites?: ClubInviteRecord[]; sent?: number; message?: string; issues?: Array<{ message?: string }> };

const statusLabels = { PENDING: "Not sent", SENT: "Sent", ACCEPTED: "Accepted", CANCELLED: "Cancelled" } as const;
const statusTone = { PENDING: "gold", SENT: "purple", ACCEPTED: "green", CANCELLED: "coral" } as const;

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-US", { dateStyle: "medium" }) : "";
}

/**
 * Club invites (#376). Nothing here sends on its own: each Send button is the
 * administrator's decision to email those people.
 */
export function ClubInvitesWorkspace({ initialInvites, emailConfigured }: { initialInvites: ClubInviteRecord[]; emailConfigured: boolean }) {
  const [invites, setInvites] = useState(initialInvites);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function call(url: string, method: string, body: unknown, success: (result: InvitesResponse) => string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as InvitesResponse;
      if (!response.ok || !result.invites) throw new Error(result.message ?? result.issues?.[0]?.message ?? "The invites could not be updated.");
      setInvites(result.invites);
      setNotice(success(result));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invites could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  const sentMessage = (result: InvitesResponse) => `Sent ${result.sent ?? 0} invite${result.sent === 1 ? "" : "s"}.`;

  function send(selection: { organizationId?: string; inviteIds?: string[] }, count: number, label: string) {
    if (!window.confirm(`Email ${count} invite${count === 1 ? "" : "s"} ${label}?`)) return;
    void call("/api/admin/club-invites/send", "POST", selection, sentMessage);
  }

  function changeEmail(invite: ClubInviteRecord) {
    const email = window.prompt(`New email for ${invite.name || "this invite"} (${invite.club.name}):`, invite.email);
    if (!email || email.trim().toLowerCase() === invite.email) return;
    void call(`/api/admin/club-invites/${encodeURIComponent(invite.id)}`, "PATCH", { email }, () => "Email changed. The invite is waiting to be sent.");
  }

  function cancel(invite: ClubInviteRecord) {
    if (!window.confirm(`Cancel the invite for ${invite.name || invite.email}?`)) return;
    void call(`/api/admin/club-invites/${encodeURIComponent(invite.id)}`, "PATCH", { cancel: true }, () => "Invite cancelled.");
  }

  const pending = invites.filter((invite) => invite.status === "PENDING");
  const clubs = [...new Map(invites.map((invite) => [invite.club.id, invite.club])).values()];

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Clubs</p>
          <h2>Club invites</h2>
          <p>
            Invites for club directors and deputies, mostly from the club import. Nothing is emailed until you press Send.
            The person accepts from their account page after signing in or creating an account with the invited email.
          </p>
        </div>
        <div className="intro-actions">
          <button
            className="primary-button"
            disabled={busy || pending.length === 0 || !emailConfigured}
            onClick={() => send({}, pending.length, "to every club with an unsent invite")}
            type="button"
          >
            <Send aria-hidden="true" size={16} /> Send all unsent ({pending.length})
          </button>
        </div>
      </div>

      {!emailConfigured && (
        <div className="inline-notice error" role="status">Account email isn&apos;t set up on this server, so invites can&apos;t be sent yet.</div>
      )}
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      {clubs.length === 0 && (
        <div className="panel"><p className="report-empty">No invites yet. <a href="/admin/clubs/import">Import clubs</a> to create them.</p></div>
      )}

      {clubs.map((club) => {
        const clubInvites = invites.filter((invite) => invite.club.id === club.id);
        const clubPending = clubInvites.filter((invite) => invite.status === "PENDING");
        return (
          <section className="panel" key={club.id}>
            <div className="section-heading">
              <div><h2 translate="no">{club.name}</h2>{!club.isActive && <p>Inactive club: invites can&apos;t be sent.</p>}</div>
              <button
                className="secondary-button"
                disabled={busy || clubPending.length === 0 || !emailConfigured || !club.isActive}
                onClick={() => send({ organizationId: club.id }, clubPending.length, `for ${club.name}`)}
                type="button"
              >
                <Send aria-hidden="true" size={14} /> Send ({clubPending.length})
              </button>
            </div>
            <ul className="club-invite-list">
              {clubInvites.map((invite) => (
                <li key={invite.id}>
                  <span>
                    <strong translate="no">{invite.name || invite.email}</strong>
                    <small translate="no">{invite.email}</small>
                  </span>
                  <span className="status-chip purple">{clubDirectorRoleLabels[invite.role]}</span>
                  <span className={`status-chip ${statusTone[invite.status]}`}>
                    {statusLabels[invite.status]}
                    {invite.status === "SENT" && invite.sentAt ? ` ${formatDate(invite.sentAt)}` : ""}
                    {invite.status === "ACCEPTED" && invite.acceptedAt ? ` ${formatDate(invite.acceptedAt)}` : ""}
                  </span>
                  {(invite.status === "PENDING" || invite.status === "SENT") && (
                    <span className="club-invite-actions">
                      {invite.status === "SENT" && (
                        <button className="secondary-button" disabled={busy || !emailConfigured} onClick={() => send({ inviteIds: [invite.id] }, 1, `again to ${invite.email}`)} type="button">
                          <Send aria-hidden="true" size={13} /> Resend
                        </button>
                      )}
                      <button aria-label={`Change email for ${invite.name || invite.email}`} className="secondary-button" disabled={busy} onClick={() => changeEmail(invite)} type="button">
                        <Pencil aria-hidden="true" size={13} />
                      </button>
                      <button aria-label={`Cancel invite for ${invite.name || invite.email}`} className="secondary-button" disabled={busy} onClick={() => cancel(invite)} type="button">
                        <Ban aria-hidden="true" size={13} />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
