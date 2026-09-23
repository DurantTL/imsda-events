"use client";

import { useState } from "react";
import { Ban, UserCog, UserPlus } from "lucide-react";
import {
  clubDirectorRoleLabels,
  directorGrantStatusLabels,
  type DirectorGrantStatus,
} from "@/modules/organizations/director-grants-domain";
import type { DirectorGrantRecord } from "@/modules/organizations/director-grants-repository";

type GrantResponse = {
  grants?: DirectorGrantRecord[];
  message?: string;
  issues?: Array<{ message?: string }>;
};

const statusTone: Record<DirectorGrantStatus, string> = {
  ACTIVE: "green",
  SCHEDULED: "purple",
  ENDED: "gold",
  REVOKED: "coral",
};

function formatDate(value: string | null) {
  if (!value) return "No end date";
  return new Date(value).toLocaleDateString("en-US", { dateStyle: "medium" });
}

/** `<input type="date">` gives a calendar day; grants start and end at local midnight. */
function dateInputToIso(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return new Date(`${text}T00:00:00`).toISOString();
}

export function ClubDirectorsWorkspace({
  club,
  initialGrants,
}: {
  club: { id: string; name: string; isActive: boolean };
  initialGrants: DirectorGrantRecord[];
}) {
  const [grants, setGrants] = useState(initialGrants);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/admin/organizations/${encodeURIComponent(club.id)}/director-grants`;

  async function readResponse(response: Response) {
    const result = await response.json().catch(() => ({})) as GrantResponse;
    if (!response.ok || !result.grants) {
      throw new Error(
        result.message ?? result.issues?.[0]?.message ?? "Club directors could not be updated.",
      );
    }
    setGrants(result.grants);
  }

  async function addDirector(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(form.get("email") ?? ""),
          role: String(form.get("role") ?? "DIRECTOR"),
          effectiveFrom: dateInputToIso(form.get("effectiveFrom")),
          effectiveTo: dateInputToIso(form.get("effectiveTo")) ?? null,
          reason: String(form.get("reason") ?? ""),
        }),
      });
      await readResponse(response);
      formElement.reset();
      setNotice("Role given. They will see this club under My club on their account.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The director could not be assigned.");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(grant: DirectorGrantRecord) {
    const reason = window.prompt(`Why is ${grant.account.displayName} losing access to ${club.name}?`);
    if (reason === null) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${base}/${encodeURIComponent(grant.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      await readResponse(response);
      setNotice("Club access revoked.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The grant could not be revoked.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Club admins</p>
          <h2 translate="no">{club.name}</h2>
          <p>
            Directors, deputies, registrars, and reporters sign in with their own
            attendee account. Directors and deputies can also give and remove the
            Registrar and Reporter roles themselves. Every grant and revocation is
            recorded in the audit log.
          </p>
        </div>
      </div>

      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      {club.isActive ? (
        <form className="panel form-stack" onSubmit={addDirector}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">New grant</p>
              <h2>Give a club role</h2>
            </div>
          </div>
          <div className="form-grid two-column">
            <label>
              Account email
              <input autoComplete="off" name="email" required type="email" />
            </label>
            <label>
              Role
              <select defaultValue="DIRECTOR" name="role">
                {Object.entries(clubDirectorRoleLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              Starts (optional, defaults to today)
              <input name="effectiveFrom" type="date" />
            </label>
            <label>
              Ends (optional)
              <input name="effectiveTo" type="date" />
            </label>
          </div>
          <label>
            Reason
            <input maxLength={500} minLength={3} name="reason" placeholder="e.g. 2026–27 Pathfinder director per church board" required />
          </label>
          <p className="field-help">
            The person needs a verified account first. If they don&apos;t have one,
            ask them to create one at /account/sign-up.
          </p>
          <div>
            <button className="primary-button" disabled={saving} type="submit">
              <UserPlus aria-hidden="true" size={16} /> Give role
            </button>
          </div>
        </form>
      ) : (
        <div className="inline-notice error" role="status">
          This club is inactive. Reactivate it before assigning a director.
        </div>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Access history</p>
            <h2>Grants</h2>
          </div>
          <span className="count-badge">{grants.length} total</span>
        </div>
        {grants.length === 0 ? (
          <div className="empty-state">
            <UserCog aria-hidden="true" size={27} />
            <h3>No directors yet</h3>
            <p>Assign the club director so they can manage the roster.</p>
          </div>
        ) : (
          <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Dates</th>
                <th>Status</th>
                <th>Reason</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr key={grant.id}>
                  <td>
                    <strong translate="no">{grant.account.displayName}</strong>
                    <br />
                    <small translate="no">{grant.account.email}</small>
                  </td>
                  <td>{clubDirectorRoleLabels[grant.role]}</td>
                  <td>{formatDate(grant.effectiveFrom)} – {formatDate(grant.effectiveTo)}</td>
                  <td>
                    <span className={`status-chip ${statusTone[grant.status]}`}>
                      {directorGrantStatusLabels[grant.status]}
                    </span>
                  </td>
                  <td>
                    {grant.reason}
                    {grant.revokeReason && (
                      <>
                        <br />
                        <small>Revoked: {grant.revokeReason}</small>
                      </>
                    )}
                  </td>
                  <td>
                    {grant.status !== "REVOKED" && (
                      <button
                        aria-label={`Revoke ${grant.account.displayName}`}
                        className="secondary-button"
                        disabled={saving}
                        onClick={() => revoke(grant)}
                        type="button"
                      >
                        <Ban aria-hidden="true" size={14} /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </section>
  );
}
