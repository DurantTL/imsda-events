"use client";

import { useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";
import {
  clubAssignableRoles,
  clubDirectorRoleLabels,
  clubRoleDescriptions,
} from "@/modules/organizations/director-grants-domain";
import type { ClubTeamMember } from "@/modules/organizations/director-grants-repository";

type TeamResponse = { team?: ClubTeamMember[]; message?: string; issues?: Array<{ message?: string }> };

export function ClubTeamWorkspace({
  initialTeam,
  organizationId,
  viewerAccountId,
}: {
  initialTeam: ClubTeamMember[];
  organizationId: string;
  viewerAccountId: string;
}) {
  const [team, setTeam] = useState(initialTeam);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/team`;

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
      if (!response.ok || !result.team) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The team could not be updated.");
      }
      setTeam(result.team);
      setNotice(success);
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
    if (ok) formElement.reset();
  }

  async function remove(member: ClubTeamMember) {
    if (!window.confirm(`Remove ${member.displayName} as ${clubDirectorRoleLabels[member.role]}? They lose access to this club right away.`)) return;
    await call(`${base}/${encodeURIComponent(member.id)}`, "DELETE", undefined, "Removed.");
  }

  return (
    <div className="club-roster-stack">
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="public-manage-card" aria-labelledby="club-team-heading">
        <div className="public-manage-card-heading club-roster-heading">
          <div>
            <p className="public-registration-eyebrow">Who can help run the club</p>
            <h2 id="club-team-heading">Team</h2>
          </div>
          <span className="count-badge">{team.length}</span>
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

      <form className="public-manage-card form-stack" onSubmit={add}>
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Add someone</p>
          <h2>Give a role</h2>
        </div>
        <div className="form-grid two-column">
          <label>
            Their account email
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
          They need their own verified account first. If they don&apos;t have one, ask them to create it at
          /account/sign-up with this email. Registrars also set up two-step sign-in before they can open the roster.
        </p>
        <div>
          <button className="primary-button" disabled={saving} type="submit">
            <UserPlus aria-hidden="true" size={16} /> Add to team
          </button>
        </div>
      </form>
    </div>
  );
}
