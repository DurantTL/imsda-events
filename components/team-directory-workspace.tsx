"use client";

import { useState } from "react";
import {
  Pencil,
  ShieldCheck,
  ShieldAlert,
  UserX,
  UsersRound,
  X,
} from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
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
  const [profileMember, setProfileMember] = useState<
    TeamDirectory["members"][number] | null
  >(null);
  const dialogRef = useAccessibleDialog<HTMLElement>(
    Boolean(profileMember),
    closeProfile,
  );

  function closeProfile() {
    if (!busyUserId) setProfileMember(null);
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileMember) return;
    const form = new FormData(event.currentTarget);
    setBusyUserId(profileMember.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/users/${profileMember.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: form.get("displayName"),
          jobTitle: form.get("jobTitle"),
          phone: form.get("phone"),
          bio: form.get("bio"),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.directory) {
        throw new Error(result.message ?? "That team profile could not be updated.");
      }
      setDirectory(result.directory);
      setProfileMember(null);
      setNotice(`Updated the team profile for ${form.get("displayName")}.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "That team profile could not be updated.",
      );
    } finally {
      setBusyUserId("");
    }
  }

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
                    {member.jobTitle && <small>{member.jobTitle}</small>}
                  </td>
                  <td>
                    {member.email}
                    {member.phone && <small>{member.phone}</small>}
                  </td>
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
                    <div className="team-account-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busyUserId === member.id}
                        onClick={() => setProfileMember(member)}
                      >
                        <Pencil size={14} aria-hidden="true" /> Edit profile
                      </button>
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {profileMember && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeProfile();
          }}
        >
          <section
            className="modal-card"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-profile-title"
            tabIndex={-1}
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">Global team profile</p>
                <h2 id="team-profile-title">Edit {profileMember.displayName}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={closeProfile}
                aria-label="Close team profile"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <p className="quiet-copy">
              These details identify this account everywhere it appears. Email and
              event permissions are managed separately.
            </p>
            <form className="form-stack" onSubmit={saveProfile}>
              <label>
                Display name
                <input
                  name="displayName"
                  defaultValue={profileMember.displayName}
                  minLength={2}
                  maxLength={100}
                  autoComplete="name"
                  required
                />
              </label>
              <label>
                Title or responsibility
                <input
                  name="jobTitle"
                  defaultValue={profileMember.jobTitle}
                  maxLength={120}
                  placeholder="Registration coordinator"
                />
              </label>
              <label>
                Phone
                <input
                  name="phone"
                  defaultValue={profileMember.phone}
                  maxLength={40}
                  autoComplete="tel"
                />
              </label>
              <label>
                Profile notes
                <textarea
                  name="bio"
                  defaultValue={profileMember.bio}
                  maxLength={1000}
                  rows={4}
                  placeholder="Responsibilities, availability, or internal context."
                />
              </label>
              <div className="form-actions">
                <button className="secondary-button" type="button" onClick={closeProfile}>
                  Cancel
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busyUserId === profileMember.id}
                >
                  {busyUserId === profileMember.id ? "Saving…" : "Save profile"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
