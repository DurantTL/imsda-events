"use client";

import { useCallback, useState } from "react";
import { Mail, RefreshCw, UserMinus, UserPlus, X, XCircle } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { ClubTeamInvite } from "@/modules/club-imports/invites";
import {
  clubAssignableRoles,
  clubDirectorRoleLabels,
  clubRoleDescriptions,
} from "@/modules/organizations/director-grants-domain";
import type { ClubTeamMember } from "@/modules/organizations/director-grants-repository";

type TeamResponse = {
  team?: ClubTeamMember[];
  invites?: ClubTeamInvite[];
  invited?: boolean;
  message?: string;
  issues?: Array<{ message?: string }>;
};

function formatSentDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ClubTeamWorkspace({
  initialTeam,
  initialInvites,
  organizationId,
  viewerAccountId,
}: {
  initialTeam: ClubTeamMember[];
  initialInvites: ClubTeamInvite[];
  organizationId: string;
  /** Null for a staff "act as" director (#442): no attendee account to mark "(you)". */
  viewerAccountId: string | null;
}) {
  const [team, setTeam] = useState(initialTeam);
  const [invites, setInvites] = useState(initialInvites);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/team`;
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const dialogRef = useAccessibleDialog<HTMLElement>(dialogOpen, closeDialog);

  /** Adding a club admin happens in a pop-up (#435), like the roster and honor catalog. */
  function openDialog() {
    setNotice("");
    setError("");
    setDialogOpen(true);
  }

  async function call(url: string, method: string, body: unknown, success: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as TeamResponse;
      if (!response.ok || (!result.team && !result.invites)) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The team could not be updated.");
      }
      if (result.team) setTeam(result.team);
      if (result.invites) setInvites(result.invites);
      setNotice(result.invited ? "Invite sent. They'll get access once they sign up and accept it." : success);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The team could not be updated.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const role = String(form.get("role") ?? "REGISTRAR");
    const ok = await call(base, "POST", { email: String(form.get("email") ?? ""), role },
      `Added. They'll see this club under My club when they sign in.`);
    if (ok) {
      formElement.reset();
      closeDialog();
    }
  }

  async function remove(member: ClubTeamMember) {
    if (!window.confirm(`Remove ${member.displayName} as ${clubDirectorRoleLabels[member.role]}? They lose access to this club right away.`)) return;
    await call(`${base}/${encodeURIComponent(member.id)}`, "DELETE", undefined, "Removed.");
  }

  async function resendInvite(invite: ClubTeamInvite) {
    await call(`${base}/invites/${encodeURIComponent(invite.id)}/resend`, "POST", undefined, "Invite resent.");
  }

  async function cancelInvite(invite: ClubTeamInvite) {
    if (!window.confirm(`Cancel the invite to ${invite.email}?`)) return;
    await call(`${base}/invites/${encodeURIComponent(invite.id)}`, "DELETE", undefined, "Invite cancelled.");
  }

  return (
    <div className="club-roster-stack">
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {/* While the popup is open, its own alert shows the error; one announcement, not two. */}
      {error && !dialogOpen && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="public-manage-card" aria-labelledby="club-team-heading">
        <div className="public-manage-card-heading club-roster-heading">
          <div>
            <p className="public-registration-eyebrow">Who can help run the club</p>
            <h2 id="club-team-heading">Club admins</h2>
          </div>
          <div className="club-roster-heading-actions">
            <span className="count-badge">{team.length}</span>
            <button className="primary-button" disabled={saving} onClick={openDialog} type="button">
              <UserPlus aria-hidden="true" size={16} /> Add club admin
            </button>
          </div>
        </div>
        <ul className="public-manage-club-list club-team-list">
          {team.map((member) => (
            <li key={member.id}>
              <span>
                <strong translate="no">{member.displayName}{member.accountId === viewerAccountId ? " (you)" : ""}</strong>
                <small translate="no">{member.email}</small>
              </span>
              <span className="status-chip purple">{clubDirectorRoleLabels[member.role]}</span>
              {member.removableByClub ? (
                <button
                  aria-label={`Remove ${member.displayName}`}
                  className="secondary-button club-event-action"
                  disabled={saving}
                  onClick={() => remove(member)}
                  type="button"
                >
                  <UserMinus aria-hidden="true" size={14} /> Remove
                </button>
              ) : (
                <small className="club-team-note">Changed by conference staff</small>
              )}
            </li>
          ))}
        </ul>
      </section>

      {invites.length > 0 && (
        <section className="public-manage-card" aria-labelledby="club-team-invites-heading">
          <div className="public-manage-card-heading club-roster-heading">
            <div>
              <p className="public-registration-eyebrow">Waiting to sign up</p>
              <h2 id="club-team-invites-heading">Pending invites</h2>
            </div>
            <span className="count-badge">{invites.length}</span>
          </div>
          <ul className="public-manage-club-list club-team-list">
            {invites.map((invite) => (
              <li key={invite.id}>
                <span>
                  <strong translate="no">{invite.email}</strong>
                  <small>
                    Sent {formatSentDate(invite.sentAt)}
                    {invite.expiresAt ? `${invite.expired ? " · expired " : " · expires "}${formatSentDate(invite.expiresAt)}` : ""}
                  </small>
                </span>
                <span className="status-chip purple">{clubDirectorRoleLabels[invite.role]}</span>
                <span className="club-team-invite-actions">
                  <button
                    aria-label={`Resend invite to ${invite.email}`}
                    className="secondary-button club-event-action"
                    disabled={saving}
                    onClick={() => resendInvite(invite)}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" size={14} /> Resend
                  </button>
                  <button
                    aria-label={`Cancel invite to ${invite.email}`}
                    className="secondary-button club-event-action"
                    disabled={saving}
                    onClick={() => cancelInvite(invite)}
                    type="button"
                  >
                    <XCircle aria-hidden="true" size={14} /> Cancel
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialogOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeDialog(); }} role="presentation">
          <section aria-labelledby="club-team-dialog-title" aria-modal="true" className="modal-card" ref={dialogRef} role="dialog" tabIndex={-1}>
            <form className="form-stack" onSubmit={add}>
              <div className="modal-head">
                <div>
                  <p className="public-registration-eyebrow">Add someone</p>
                  <h2 id="club-team-dialog-title">Give a role</h2>
                </div>
                <button aria-label="Close" className="icon-button modal-close-button" onClick={closeDialog} type="button">
                  <X aria-hidden="true" size={18} />
                </button>
              </div>
              {error && <div className="inline-notice error" role="alert">{error}</div>}
              <div className="form-grid two-column">
                <label>
                  Their email
                  <input autoComplete="off" maxLength={254} name="email" required type="email" />
                </label>
                <label>
                  Role
                  <select defaultValue="REGISTRAR" name="role">
                    {clubAssignableRoles.map((role) => (
                      <option key={role} value={role}>{clubDirectorRoleLabels[role]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <ul className="field-help club-role-help">
                {clubAssignableRoles.map((role) => (
                  <li key={role}><strong>{clubDirectorRoleLabels[role]}:</strong> {clubRoleDescriptions[role]}</li>
                ))}
              </ul>
              <p className="field-help">
                <Mail aria-hidden="true" size={14} /> If they already have a verified account, they get the role right
                away. Otherwise we&apos;ll email them an invite to sign up and accept it.
              </p>
              <div className="form-actions">
                <button className="secondary-button" disabled={saving} onClick={closeDialog} type="button">Cancel</button>
                <button className="primary-button" disabled={saving} type="submit">
                  <UserPlus aria-hidden="true" size={16} /> Add club admin
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
