"use client";

import { useState } from "react";
import { Ban, Save, Send, UserPlus } from "lucide-react";
import { INSTRUCTOR_EDIT_GRACE_DAYS } from "@/modules/honors/instructor-domain";

type ClassOption = { id: string; label: string };
type Instructor = {
  id: string;
  name: string;
  email: string;
  status: "INVITED" | "ACCEPTED" | "REMOVED";
  sentAt: string | null;
  sterlingCurrent: boolean;
  sterlingState: string;
  offeringIds: string[];
};
type ListResponse = { instructors?: Instructor[]; classes?: ClassOption[]; emailQueued?: boolean; message?: string };

const statusLabels = { INVITED: "Invited", ACCEPTED: "Accepted", REMOVED: "Removed" } as const;
const statusTone = { INVITED: "gold", ACCEPTED: "green", REMOVED: "coral" } as const;

/**
 * Honors Weekend instructors (#833). Staff choose who teaches which class and
 * invite them by email. An instructor sees only their own classes' rosters
 * (name and club), and only with a current Sterling Volunteers check.
 */
export function HonorsInstructorsWorkspace({
  eventId,
  eventName,
  classes,
  initialInstructors,
  emailConfigured,
}: {
  eventId: string;
  eventName: string;
  classes: ClassOption[];
  initialInstructors: Instructor[];
  emailConfigured: boolean;
}) {
  const [instructors, setInstructors] = useState(initialInstructors);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({ firstName: "", lastName: "", email: "", offeringIds: [] as string[] });
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const base = `/api/events/${encodeURIComponent(eventId)}/honors/instructors`;

  async function refresh() {
    const response = await fetch(base, { cache: "no-store" });
    const result = await response.json().catch(() => ({})) as ListResponse;
    if (response.ok && result.instructors) {
      setInstructors(result.instructors);
      setEdits({});
    }
  }

  async function call(url: string, method: string, body: unknown, success: (result: ListResponse) => string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as ListResponse;
      if (!response.ok) throw new Error(result.message ?? "That could not be saved.");
      setNotice(success(result));
      await refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function toggle(list: string[], id: string) {
    return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    const ok = await call(base, "POST", draft, (result) => (result.emailQueued ? "Invite emailed." : "Instructor added. Account email isn't set up, so no email was sent yet."));
    if (ok) setDraft({ firstName: "", lastName: "", email: "", offeringIds: [] });
  }

  const current = (instructor: Instructor) => edits[instructor.id] ?? instructor.offeringIds;

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Honors Weekend</p>
          <h2>Instructors for {eventName}</h2>
          <p>
            Choose who teaches each class and invite them by email. After accepting from their own account, an instructor sees
            only their own classes: each person&apos;s name and club, nothing else. They can mark attendance and completion
            until {INSTRUCTOR_EDIT_GRACE_DAYS} days after the event ends, and they need a current Sterling Volunteers check on file to see a roster.
            Completed honors go into members&apos; honor records; staff can void one from the honor record if it was a mistake.
          </p>
        </div>
      </div>

      {!emailConfigured && <div className="inline-notice error" role="status">Account email isn&apos;t set up on this server, so invites can&apos;t be emailed yet.</div>}
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="panel">
        <div className="section-heading"><div><h2>Invite an instructor</h2></div></div>
        <form className="form-grid" onSubmit={invite}>
          <label>First name<input autoComplete="off" maxLength={100} onChange={(event) => setDraft({ ...draft, firstName: event.target.value })} required value={draft.firstName} /></label>
          <label>Last name<input autoComplete="off" maxLength={100} onChange={(event) => setDraft({ ...draft, lastName: event.target.value })} required value={draft.lastName} /></label>
          <label>Email<input autoComplete="off" maxLength={254} onChange={(event) => setDraft({ ...draft, email: event.target.value })} required type="email" value={draft.email} /></label>
          <fieldset>
            <legend>Classes they teach</legend>
            {classes.length === 0 && <p className="field-help">Add classes on the classes page first.</p>}
            {classes.map((option) => (
              <label className="checkbox-row" key={option.id}>
                <input checked={draft.offeringIds.includes(option.id)} onChange={() => setDraft({ ...draft, offeringIds: toggle(draft.offeringIds, option.id) })} type="checkbox" />
                {option.label}
              </label>
            ))}
          </fieldset>
          <button className="primary-button" disabled={busy || draft.offeringIds.length === 0} type="submit">
            <UserPlus aria-hidden="true" size={15} /> Invite
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="section-heading"><div><h2>Instructors ({instructors.length})</h2></div></div>
        {instructors.length === 0 && <p className="report-empty">No instructors yet.</p>}
        <ul className="club-invite-list">
          {instructors.map((instructor) => {
            const selected = current(instructor);
            const changed = selected.length !== instructor.offeringIds.length || selected.some((id) => !instructor.offeringIds.includes(id));
            return (
              <li key={instructor.id}>
                <span>
                  <strong translate="no">{instructor.name}</strong>
                  <small translate="no">{instructor.email}</small>
                </span>
                <span className={`status-chip ${statusTone[instructor.status]}`}>{statusLabels[instructor.status]}</span>
                <span className={`status-chip ${instructor.sterlingCurrent ? "green" : "gold"}`}>
                  {instructor.sterlingCurrent
                    ? "Sterling Volunteers check current"
                    : instructor.sterlingState === "FLAGGED"
                      ? "Sterling Volunteers check flagged \"!\" (expiring soon; not current for rosters)"
                      : "No current Sterling Volunteers check"}
                </span>
                <fieldset>
                  <legend className="sr-only">Classes for {instructor.name}</legend>
                  {classes.map((option) => (
                    <label className="checkbox-row" key={option.id}>
                      <input checked={selected.includes(option.id)} onChange={() => setEdits({ ...edits, [instructor.id]: toggle(selected, option.id) })} type="checkbox" />
                      {option.label}
                    </label>
                  ))}
                </fieldset>
                <span className="club-invite-actions">
                  <button className="secondary-button" disabled={busy || !changed || selected.length === 0} onClick={() => void call(`${base}/${encodeURIComponent(instructor.id)}`, "PATCH", { offeringIds: selected }, () => "Classes saved.")} type="button">
                    <Save aria-hidden="true" size={13} /> Save classes
                  </button>
                  {instructor.status === "INVITED" && (
                    <button className="secondary-button" disabled={busy || !emailConfigured} onClick={() => void call(`${base}/${encodeURIComponent(instructor.id)}/resend`, "POST", undefined, () => "Invite resent.")} type="button">
                      <Send aria-hidden="true" size={13} /> Resend
                    </button>
                  )}
                  <button
                    aria-label={`Remove ${instructor.name}`}
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove ${instructor.name}? They will no longer see any class roster.`)) void call(`${base}/${encodeURIComponent(instructor.id)}`, "DELETE", undefined, () => "Instructor removed.");
                    }}
                    type="button"
                  >
                    <Ban aria-hidden="true" size={13} /> Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
