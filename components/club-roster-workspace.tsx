"use client";

import { useState } from "react";
import { Eye, Pencil, Plus, Power, Save, Trash2, UsersRound, X } from "lucide-react";
import {
  clubRosterAttendeeTypeLabels,
  clubRosterGenderLabels,
  clubRosterStatusLabels,
} from "@/modules/club-rosters/domain";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

type RosterResponse = {
  members?: RosterMemberRecord[];
  birthDates?: Record<string, string>;
  message?: string;
  issues?: Array<{ message?: string }>;
};

export function ClubRosterWorkspace({
  clubYear,
  initialMembers,
  organizationId,
}: {
  clubYear: string;
  initialMembers: RosterMemberRecord[];
  organizationId: string;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [editing, setEditing] = useState<RosterMemberRecord | null>(null);
  const [birthDates, setBirthDates] = useState<Record<string, string> | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/roster`;

  const active = members.filter((member) => member.status === "ACTIVE");
  const visible = showInactive ? members : active;

  async function call(url: string, method: string, body: unknown, success: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as RosterResponse;
      if (!response.ok) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The roster could not be updated.");
      }
      if (result.members) setMembers(result.members);
      if (success) setNotice(success);
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The roster could not be updated.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const birthDate = String(form.get("birthDate") ?? "");
    const details = {
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      attendeeType: String(form.get("attendeeType") ?? "YOUTH"),
      role: String(form.get("role") ?? ""),
      gender: String(form.get("gender") ?? "") || null,
    };
    const result = editing
      ? await call(`${base}/${encodeURIComponent(editing.id)}`, "PATCH", {
        ...details,
        ...(birthDate ? { birthDate } : {}),
      }, "Saved.")
      : await call(base, "POST", { ...details, birthDate }, "Added to the roster.");
    if (result) {
      setEditing(null);
      setBirthDates(null);
      formElement.reset();
    }
  }

  async function setStatus(member: RosterMemberRecord, status: "ACTIVE" | "INACTIVE") {
    await call(`${base}/${encodeURIComponent(member.id)}`, "PATCH", { status },
      status === "INACTIVE" ? "Marked inactive. They stay on file." : "Marked active.");
  }

  async function remove(member: RosterMemberRecord) {
    const confirmed = window.confirm(
      `Remove ${member.firstName} ${member.lastName} from the roster? Their birth date and details are erased. This can't be undone. To keep them on file, mark them inactive instead.`,
    );
    if (!confirmed) return;
    await call(`${base}/${encodeURIComponent(member.id)}`, "DELETE", { confirm: true }, "Removed and erased.");
  }

  async function revealBirthDates() {
    const result = await call(`${base}/birth-dates`, "POST", {}, "");
    if (result?.birthDates) setBirthDates(result.birthDates);
  }

  return (
    <div className="club-roster-stack">
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="public-manage-card">
        <div className="public-manage-card-heading club-roster-heading">
          <div>
            <p className="public-registration-eyebrow">Club year {clubYear}</p>
            <h2>Roster</h2>
          </div>
          <span className="count-badge">{active.length} active</span>
        </div>
        <div className="club-roster-tools">
          <label className="checkbox-label">
            <input checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} type="checkbox" />
            Show inactive people
          </label>
          {birthDates ? (
            <button className="text-button" onClick={() => setBirthDates(null)} type="button">
              <Eye aria-hidden="true" size={14} /> Hide birth dates
            </button>
          ) : (
            <button className="text-button" disabled={saving || members.length === 0} onClick={revealBirthDates} type="button">
              <Eye aria-hidden="true" size={14} /> Show birth dates
            </button>
          )}
        </div>
        {visible.length === 0 ? (
          <p className="public-manage-empty">
            <UsersRound size={17} aria-hidden="true" /> No one is on the roster yet. Add people below, or they&apos;ll be
            added when you register your club for an event.
          </p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Role</th>
                  <th>Age</th>
                  {birthDates && <th>Birth date</th>}
                  <th>Status</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((member) => (
                  <tr key={member.id}>
                    <td translate="no"><strong>{member.lastName}, {member.firstName}</strong></td>
                    <td>{clubRosterAttendeeTypeLabels[member.attendeeType]}</td>
                    <td>{member.role || "—"}</td>
                    <td translate="no">{member.age ?? "—"}</td>
                    {birthDates && <td translate="no">{birthDates[member.id] ?? "—"}</td>}
                    <td>
                      <span className={`status-chip ${member.status === "ACTIVE" ? "green" : "gold"}`}>
                        {clubRosterStatusLabels[member.status]}
                      </span>
                    </td>
                    <td className="honor-row-actions">
                      <button aria-label={`Edit ${member.firstName} ${member.lastName}`} className="secondary-button" disabled={saving} onClick={() => { setEditing(member); setNotice(""); setError(""); }} type="button">
                        <Pencil aria-hidden="true" size={13} />
                      </button>
                      <button
                        aria-label={`${member.status === "ACTIVE" ? "Mark inactive" : "Mark active"}: ${member.firstName} ${member.lastName}`}
                        className="secondary-button"
                        disabled={saving}
                        onClick={() => setStatus(member, member.status === "ACTIVE" ? "INACTIVE" : "ACTIVE")}
                        type="button"
                      >
                        <Power aria-hidden="true" size={13} />
                      </button>
                      <button aria-label={`Remove ${member.firstName} ${member.lastName}`} className="secondary-button" disabled={saving} onClick={() => remove(member)} type="button">
                        <Trash2 aria-hidden="true" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="public-manage-card form-stack" key={editing?.id ?? "new"} onSubmit={save}>
        <div className="public-manage-card-heading club-roster-heading">
          <div>
            <p className="public-registration-eyebrow">{editing ? "Edit" : "Add someone"}</p>
            <h2 translate={editing ? "no" : undefined}>{editing ? `${editing.firstName} ${editing.lastName}` : "Add to the roster"}</h2>
          </div>
          {editing && (
            <button className="secondary-button" onClick={() => setEditing(null)} type="button">
              <X aria-hidden="true" size={14} /> Cancel
            </button>
          )}
        </div>
        <div className="form-grid two-column">
          <label>
            First name
            <input autoComplete="off" defaultValue={editing?.firstName ?? ""} maxLength={80} name="firstName" required />
          </label>
          <label>
            Last name
            <input autoComplete="off" defaultValue={editing?.lastName ?? ""} maxLength={80} name="lastName" required />
          </label>
          <label>
            Birth date{editing ? " (leave blank to keep)" : ""}
            <input
              defaultValue={editing && birthDates ? birthDates[editing.id] ?? "" : ""}
              name="birthDate"
              required={!editing}
              type="date"
            />
          </label>
          <label>
            Type
            <select defaultValue={editing?.attendeeType ?? "YOUTH"} name="attendeeType">
              {Object.entries(clubRosterAttendeeTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Role (optional)
            <input defaultValue={editing?.role ?? ""} maxLength={60} name="role" placeholder="e.g. Pathfinder, Counselor, TLT" />
          </label>
          <label>
            Gender (optional)
            <select defaultValue={editing?.gender ?? ""} name="gender">
              <option value="">Not given</option>
              {Object.entries(clubRosterGenderLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="field-help">
          Birth dates are encrypted and shown only to your club&apos;s directors. Event staff see age only.
          Don&apos;t enter medical or insurance information here.
        </p>
        <div>
          <button className="primary-button" disabled={saving} type="submit">
            {editing ? <Save aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
            {editing ? " Save" : " Add to roster"}
          </button>
        </div>
      </form>
    </div>
  );
}
