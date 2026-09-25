"use client";

import { Fragment, useCallback, useState } from "react";
import { Eye, Pencil, Plus, Power, Save, Trash2, UsersRound, X } from "lucide-react";
import { BirthDateField } from "@/components/birth-date-field";
import { RosterCsvImport } from "@/components/roster-csv-import";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import {
  clubClassLevelLabels,
  clubRosterAttendeeTypeLabels,
  clubRosterGenderLabels,
  clubRosterStatusLabels,
  defaultRosterRole,
  missingRosterFields,
  rosterSectionOf,
} from "@/modules/club-rosters/domain";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

type RosterResponse = {
  members?: RosterMemberRecord[];
  birthDates?: Record<string, string>;
  message?: string;
  issues?: Array<{ message?: string }>;
};

/** A background check's mark on a club page (#427): status only, or status and note for staff. */
export type RosterComplianceInfo = { state: "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | "NO_RECORD"; note: string | null };

/** "!" on the roster import is `FLAGGED`: expiring soon. Staff, who get the note, are pointed to it. */
function complianceLabel({ state, note }: RosterComplianceInfo) {
  if (state === "FLAGGED") return note ? "Expiring soon (see note)" : "Expiring soon";
  return { CLEAR: "Clear", NOT_COMPLIANT: "Not in compliance", NO_RECORD: "No record" }[state];
}
const complianceTone = { CLEAR: "green", FLAGGED: "gold", NOT_COMPLIANT: "coral", NO_RECORD: "gold" } as const;

export function ClubRosterWorkspace({
  canSeeBirthDates,
  clubYear,
  initialMembers,
  organizationId,
  readOnly = false,
  birthDatesEndpoint,
  complianceStatuses,
}: {
  /** Directors and deputies only; a registrar enters birth dates but sees ages (#375). */
  canSeeBirthDates: boolean;
  clubYear: string;
  initialMembers: RosterMemberRecord[];
  organizationId: string;
  /** Staff "Open club" view (#386): see the roster the director sees, change nothing. */
  readOnly?: boolean;
  /** Where "Show birth dates" asks; staff use their own audited route. */
  birthDatesEndpoint?: string;
  /**
   * Background check status per roster member id (#427). Omitted entirely
   * where no one is allowed to see it; `note` is already blank unless the
   * caller is allowed to see it (club directors never get a note).
   */
  complianceStatuses?: Record<string, RosterComplianceInfo>;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [editing, setEditing] = useState<RosterMemberRecord | null>(null);
  /** The type picked in the dialog, so the Role placeholder shows the blank-role default (#424). */
  const [formType, setFormType] = useState<string>("YOUTH");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [birthDates, setBirthDates] = useState<Record<string, string> | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/roster`;
  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditing(null);
  }, []);
  const dialogRef = useAccessibleDialog<HTMLElement>(dialogOpen, closeDialog);

  /** Add and edit happen in a pop-up (#383), so the list never scrolls away. */
  function openDialog(member: RosterMemberRecord | null) {
    setEditing(member);
    setFormType(member?.attendeeType ?? "YOUTH");
    setNotice("");
    setError("");
    setDialogOpen(true);
  }

  const active = members.filter((member) => member.status === "ACTIVE");
  const needBirthDates = active.filter((member) => member.birthDateNeeded).length;
  const notInCompliance = complianceStatuses
    ? active.filter((member) => complianceStatuses[member.id]?.state === "NOT_COMPLIANT").length
    : 0;
  const expiringSoon = complianceStatuses
    ? active.filter((member) => complianceStatuses[member.id]?.state === "FLAGGED").length
    : 0;
  const visible = showInactive ? members : active;
  const sections = [
    { key: "STAFF", title: "Staff", empty: "No staff on the roster yet.", people: visible.filter((member) => rosterSectionOf(member.attendeeType) === "STAFF") },
    { key: "MEMBERS", title: "Members", empty: "No Pathfinders on the roster yet.", people: visible.filter((member) => rosterSectionOf(member.attendeeType) === "MEMBERS") },
  ] as const;
  /** Name, Age, Type, Current class, Role, Gender, Flags — plus every optional column, for the section-title row's colSpan. */
  const rosterColumnCount = 7 + (birthDates ? 1 : 0) + (complianceStatuses ? 1 : 0) + (readOnly ? 0 : 1);

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
      classLevel: String(form.get("classLevel") ?? "") || null,
      gender: String(form.get("gender") ?? "") || null,
    };
    const result = editing
      ? await call(`${base}/${encodeURIComponent(editing.id)}`, "PATCH", {
        ...details,
        ...(birthDate ? { birthDate } : {}),
      }, "Saved.")
      : await call(base, "POST", { ...details, birthDate }, "Added to the roster.");
    if (result) {
      setBirthDates(null);
      formElement.reset();
      closeDialog();
    }
  }

  async function setStatus(member: RosterMemberRecord, status: "ACTIVE" | "INACTIVE") {
    return call(`${base}/${encodeURIComponent(member.id)}`, "PATCH", { status },
      status === "INACTIVE" ? "Marked inactive. They stay on file." : "Marked active.");
  }

  /** Deactivate/reactivate lives in the edit dialog now (#424), with a confirmation there. */
  async function confirmSetStatus(member: RosterMemberRecord) {
    const next = member.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const verb = next === "INACTIVE" ? "Deactivate" : "Reactivate";
    const confirmed = window.confirm(`${verb} ${member.firstName} ${member.lastName}?`);
    if (!confirmed) return;
    const result = await setStatus(member, next);
    if (result) closeDialog();
  }

  async function remove(member: RosterMemberRecord) {
    const confirmed = window.confirm(
      `Remove ${member.firstName} ${member.lastName} from the roster? Their birth date and details are erased. This can't be undone. To keep them on file, mark them inactive instead.`,
    );
    if (!confirmed) return;
    await call(`${base}/${encodeURIComponent(member.id)}`, "DELETE", { confirm: true }, "Removed and erased.");
  }

  async function revealBirthDates() {
    const result = await call(birthDatesEndpoint ?? `${base}/birth-dates`, "POST", {}, "");
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
          <div className="club-roster-heading-actions">
            <span className="count-badge">{active.length} active</span>
            {!readOnly && (
              <button className="primary-button" disabled={saving} onClick={() => openDialog(null)} type="button">
                <Plus aria-hidden="true" size={16} /> Add to roster
              </button>
            )}
          </div>
        </div>
        {needBirthDates > 0 && (
          <p className="inline-notice roster-birth-date-notice" role="status">
            {needBirthDates === 1 ? "1 person needs" : `${needBirthDates} people need`} a birth date. The age from the
            registration form is shown until {readOnly ? "the club adds one." : "you add one; edit each person to add it."}
          </p>
        )}
        {complianceStatuses && (notInCompliance > 0 || expiringSoon > 0) && (
          <p className="inline-notice roster-compliance-notice" role="status">
            {notInCompliance} adult{notInCompliance === 1 ? "" : "s"} not in compliance
            {expiringSoon > 0 && ` · ${expiringSoon} expiring soon`}
          </p>
        )}
        <div className="club-roster-tools">
          <label className="checkbox-label">
            <input checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} type="checkbox" />
            Show inactive people
          </label>
          {!readOnly && (
            <span className="roster-csv-actions">
              <RosterCsvImport
                base={base}
                onImported={(updated, message) => {
                  setMembers(updated);
                  setBirthDates(null);
                  setNotice(message);
                }}
              />
            </span>
          )}
          {!canSeeBirthDates ? null : birthDates ? (
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
            <UsersRound size={17} aria-hidden="true" /> {readOnly
              ? "No one is on this club's roster yet."
              : "No one is on the roster yet. Add people below, or they'll be added when you register your club for an event."}
          </p>
        ) : (
          <div className="report-table-wrap">
            {/*
              One table for both sections (#435), not one per section: two
              separate tables size their columns independently, so the Staff
              table's columns drift out of step with the Members table's even
              though the headings match. A single table with a full-width
              section-title row keeps every column the same width all the way
              down, and the "Missing info" flag moves out of the Name cell
              (which was stretching that column unevenly) into its own column.
            */}
            <table className="report-table roster-card-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Age</th>
                  {birthDates && <th>Birth date</th>}
                  <th>Type</th>
                  <th>Current class</th>
                  <th>Role</th>
                  <th>Gender</th>
                  <th>Flags</th>
                  {complianceStatuses && <th>Background check</th>}
                  {!readOnly && <th><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => (
                  <Fragment key={section.key}>
                    <tr className="roster-section-row">
                      <th className="roster-section-heading" colSpan={rosterColumnCount} scope="rowgroup">
                        {section.title} <span className="count-badge">{section.people.length}</span>
                      </th>
                    </tr>
                    {section.people.length === 0 ? (
                      <tr className="roster-section-empty-row">
                        <td colSpan={rosterColumnCount}>{section.empty}</td>
                      </tr>
                    ) : (
                      section.people.map((member) => {
                        const missing = missingRosterFields(member);
                        return (
                          <tr key={member.id}>
                            <td className="roster-card-name" data-label="Name">
                              <strong translate="no">{member.lastName}, {member.firstName}</strong>
                            </td>
                            <td data-label="Age" translate="no">
                              {member.age ?? (member.reportedAge !== null ? `${member.reportedAge} (reported)` : "—")}
                            </td>
                            {birthDates && <td data-label="Birth date" translate="no">{birthDates[member.id] ?? "—"}</td>}
                            <td data-label="Type">{clubRosterAttendeeTypeLabels[member.attendeeType]}</td>
                            <td data-label="Current class">{member.classLevel ? clubClassLevelLabels[member.classLevel] : "—"}</td>
                            <td data-label="Role">{member.role || "—"}</td>
                            <td data-label="Gender">{member.gender ? clubRosterGenderLabels[member.gender] : "—"}</td>
                            <td className="roster-card-flags" data-label="Flags">
                              {member.status === "INACTIVE" && (
                                <span className="status-chip gold">{clubRosterStatusLabels.INACTIVE}</span>
                              )}
                              {missing.length > 0 && (
                                <span className="status-chip gold roster-missing-info" title={`Missing: ${missing.join(", ")}`}>
                                  Missing info: {missing.join(", ")}
                                </span>
                              )}
                              {member.status === "ACTIVE" && missing.length === 0 && "—"}
                            </td>
                            {complianceStatuses && (
                              <td data-label="Background check">
                                {complianceStatuses[member.id] ? (
                                  <>
                                    <span className={`status-chip ${complianceTone[complianceStatuses[member.id]!.state]}`}>
                                      {complianceLabel(complianceStatuses[member.id]!)}
                                    </span>
                                    {complianceStatuses[member.id]!.note && (
                                      <small className="quiet-copy background-check-note"> {complianceStatuses[member.id]!.note}</small>
                                    )}
                                  </>
                                ) : "—"}
                              </td>
                            )}
                            {!readOnly && <td className="honor-row-actions roster-card-actions" data-label="Actions">
                              <button aria-label={`Edit ${member.firstName} ${member.lastName}`} className="secondary-button" disabled={saving} onClick={() => openDialog(member)} type="button">
                                <Pencil aria-hidden="true" size={13} />
                              </button>
                              <button aria-label={`Remove ${member.firstName} ${member.lastName}`} className="secondary-button" disabled={saving} onClick={() => remove(member)} type="button">
                                <Trash2 aria-hidden="true" size={13} />
                              </button>
                            </td>}
                          </tr>
                        );
                      })
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialogOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeDialog(); }} role="presentation">
      <section aria-labelledby="roster-dialog-title" aria-modal="true" className="modal-card roster-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
      <form className="form-stack" key={editing?.id ?? "new"} onSubmit={save}>
        <div className="modal-head">
          <div>
            <p className="public-registration-eyebrow">{editing ? "Edit" : "Add someone"}</p>
            <h2 id="roster-dialog-title" translate={editing ? "no" : undefined}>{editing ? `${editing.firstName} ${editing.lastName}` : "Add to the roster"}</h2>
          </div>
          <button aria-label="Close" className="icon-button modal-close-button" onClick={closeDialog} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        {error && <div className="inline-notice error" role="alert">{error}</div>}
        <div className="form-grid two-column">
          <label>
            First name
            <input autoComplete="off" defaultValue={editing?.firstName ?? ""} maxLength={80} name="firstName" required />
          </label>
          <label>
            Last name
            <input autoComplete="off" defaultValue={editing?.lastName ?? ""} maxLength={80} name="lastName" required />
          </label>
          <BirthDateField
            defaultValue={editing && birthDates ? birthDates[editing.id] ?? "" : ""}
            label={editing && !editing.birthDateNeeded ? "Birth date (leave blank to keep)" : "Birth date"}
            name="birthDate"
            required={!editing}
          />
          <label>
            Type
            <select defaultValue={editing?.attendeeType ?? "YOUTH"} name="attendeeType" onChange={(event) => setFormType(event.target.value)}>
              {Object.entries(clubRosterAttendeeTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Current class
            <select defaultValue={editing?.classLevel ?? ""} name="classLevel">
              <option value="">None</option>
              {Object.entries(clubClassLevelLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Role (optional)
            {/* Left blank, youth save as "Pathfinder"; staff and adults stay blank (#424). */}
            <input defaultValue={editing?.role ?? ""} maxLength={60} name="role" placeholder={defaultRosterRole(formType)} />
          </label>
          <label>
            Gender
            <select defaultValue={editing?.gender ?? ""} name="gender" required>
              <option disabled value="">Choose one</option>
              {Object.entries(clubRosterGenderLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="field-help">
          Birth dates are encrypted and shown only to your club&apos;s director and deputy. Registrars and event
          staff see age only. Don&apos;t enter medical or insurance information here.
        </p>
        <div className="form-actions">
          {editing && (
            <button
              className="secondary-button roster-dialog-status-action"
              disabled={saving}
              onClick={() => confirmSetStatus(editing)}
              type="button"
            >
              <Power aria-hidden="true" size={14} /> {editing.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
            </button>
          )}
          <button className="secondary-button" disabled={saving} onClick={closeDialog} type="button">Cancel</button>
          <button className="primary-button" disabled={saving} type="submit">
            {editing ? <Save aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
            {editing ? " Save" : " Add to roster"}
          </button>
        </div>
      </form>
      </section>
        </div>
      )}
    </div>
  );
}
