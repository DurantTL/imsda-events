"use client";

import { useState } from "react";
import { ShieldCheck, ShieldAlert, UserX, UsersRound } from "lucide-react";
import type { TeamDirectory } from "@/modules/system-admin/team-directory";

function friendly(value: string) {
  return value.split("_").map((part) => (
    part.charAt(0) + part.slice(1).toLowerCase()
  )).join(" ");
}

function whenever(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : "—";
}

export function TeamDirectoryWorkspace({
  initialDirectory,
  currentUserId,
}: {
  initialDirectory: TeamDirectory;
  currentUserId: string;
}) {
  const [directory, setDirectory] = useState(initialDirectory);
  const [busyUserId, setBusyUserId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function setDisabled(userId: string, displayName: string, disabled: boolean) {
    if (disabled && !window.confirm(
      `Disable sign-in for ${displayName}? Their sessions end immediately and they cannot sign in until this is undone.`,
    )) return;
    setBusyUserId(userId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.directory) {
        throw new Error(result.message ?? "That account could not be updated.");
      }
      setDirectory(result.directory);
      setNotice(disabled
        ? `${displayName} can no longer sign in, and their sessions were ended.`
        : `${displayName} can sign in again.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That account could not be updated.");
    } finally {
      setBusyUserId("");
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">System administration</p>
          <h2>Team</h2>
          <p>
            Everyone who can sign in to IMSDA Events, and the events they work on. Event access is
            still granted on each event’s own team page; what is decided here is whether an account
            can sign in at all.
          </p>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="inline-notice" role="status">{notice}</p>}

      <div className="reminder-summary" aria-label="Team summary">
        <article>
          <span className="message-stat-icon green"><UsersRound size={18} aria-hidden="true" /></span>
          <small>Active accounts</small>
          <strong>{directory.activeCount}</strong>
        </article>
        <article>
          <span className="message-stat-icon purple"><ShieldCheck size={18} aria-hidden="true" /></span>
          <small>System administrators</small>
          <strong>{directory.systemAdminCount}</strong>
        </article>
        <article>
          <span className="message-stat-icon gold"><UserX size={18} aria-hidden="true" /></span>
          <small>Can sign in, reach nothing</small>
          <strong>{directory.withoutAccessCount}</strong>
        </article>
      </div>

      <section className="panel">
        <div className="reminder-recipient-table-wrap">
          <table className="reminder-recipient-table">
            <caption>{directory.totalCount} account{directory.totalCount === 1 ? "" : "s"}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Sign-in</th>
                <th scope="col">Two-factor</th>
                <th scope="col">Last signed in</th>
                <th scope="col">Events</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {directory.members.map((member) => (
                <tr key={member.id}>
                  <td>
                    {member.displayName}
                    {member.globalRole === "SYSTEM_ADMIN" && <small>System administrator</small>}
                  </td>
                  <td>{member.email}</td>
                  <td>
                    {member.signInDisabled
                      ? "Disabled"
                      : friendly(member.accountStatus)}
                  </td>
                  <td>
                    {member.mfaStatus === "ACTIVE"
                      ? <><ShieldCheck aria-hidden="true" size={13} /> On</>
                      : member.mfaStatus === "PENDING"
                        ? <><ShieldAlert aria-hidden="true" size={13} /> Started</>
                        : <><ShieldAlert aria-hidden="true" size={13} /> Off</>}
                  </td>
                  <td>{whenever(member.lastSignedInAt)}</td>
                  <td>
                    {member.memberships.length === 0
                      ? "No events"
                      : `${member.memberships.length} event${member.memberships.length === 1 ? "" : "s"}`}
                    {member.memberships.length > 0 && (
                      <small>
                        {member.memberships
                          .map((membership) => `${membership.eventName} — ${friendly(membership.role)}`)
                          .join("; ")}
                      </small>
                    )}
                  </td>
                  <td>
                    {member.id === currentUserId ? (
                      // The refusal is enforced server-side too; showing it
                      // here saves someone finding out by being refused.
                      <small>This is you</small>
                    ) : (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busyUserId === member.id}
                        onClick={() => setDisabled(member.id, member.displayName, !member.signInDisabled)}
                      >
                        {member.signInDisabled ? "Allow sign-in" : "Disable sign-in"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
