"use client";
import { useCallback, useRef, useState } from "react";
import { Award, Eye, Pencil, Plus, Power, Save, Trash2, UsersRound, X } from "lucide-react";
import { BirthDateField } from "@/components/birth-date-field";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { RosterTypeDefinitions } from "@/components/roster-type-definitions";
import { validateRosterForm, rosterFormFieldOrder, type RosterFormErrors, type RosterFormField } from "@/modules/club-rosters/form-validation";
import { ClubMemberHonorsDialog } from "@/components/club-member-honors-dialog";
import { RosterCsvImport } from "@/components/roster-csv-import";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { complianceFilterLabels, complianceFilterState, type ComplianceFilterValue } from "@/modules/background-checks/display";
import {
  clubClassLevelLabels,
  attendeeTypeAgeHint,
  clubRosterAttendeeTypeLabels,
  clubRosterGenderLabels,
  clubRosterStatusLabels,
  defaultRosterRole,
  missingRosterFields,
  rosterSectionOf,
} from "@/modules/club-rosters/domain";
import {
  GUARDIAN_SLOTS,
  guardianFieldLabels,
  guardianSlotValues,
  validateGuardianForm,
  type GuardianFormErrors,
  type GuardianRecord,
} from "@/modules/club-rosters/guardians-domain";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";
import { honorSummaryByMemberId, type ClubHonorsRow, type CurrentMemberHonor } from "@/modules/honors/member-honor-domain";

type RosterResponse = {
  members?: RosterMemberRecord[];
  birthDates?: Record<string, string>;
  guardians?: Record<string, GuardianRecord[]>;
  nameKept?: boolean;
  message?: string;
  issues?: Array<{ message?: string }>;
};

/** A background check's mark on a club page (#427): status only, or status and note for staff. */
export type RosterComplianceInfo = {
  state: "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | "NO_RECORD";
  note: string | null;
  /** The note as readable reasons, for the same staff who get the note (#544); empty otherwise. */
  reasons?: string[];
};

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
  honorSummaries: initialHonorSummaries,
  honorsPopup,
  complianceFilter: initialComplianceFilter = null,
  headingActions,
  healthTab,
  healthRecordFlags,
  guardians: initialGuardians,
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
  /** Each active member's current honors (#486), keyed by roster member id. Omitted where honors aren't shown here. */
  honorSummaries?: Record<string, CurrentMemberHonor[]>;
  /**
   * Opens each person's honors in a popup (#701) instead of linking away.
   * `canRecord` shows the record form; without it the popup is view-only.
   * Omit where the caller can't use the club honors endpoints (staff views).
   */
  honorsPopup?: { canRecord: boolean };
  /** `?compliance=` from the What's next reminder link (#479): narrows the list to that one flag. */
  complianceFilter?: ComplianceFilterValue | null;
  /** Extra actions beside "Add to roster", such as "Request a transfer" (#489). */
  headingActions?: React.ReactNode;
  /**
   * The Health tab link and status chip per member (#611). Present only when
   * the feature is switched on and the viewer is the club's director or
   * deputy; omitted everywhere else, so nothing about health is rendered.
   */
  healthTab?: Record<string, { status: "NONE" | "CURRENT" | "NEEDS_UPDATE"; hasHealthNote: boolean }>;
  /** A neutral "Has a health record" marker (#611): a record exists, nothing more. Ids only, never text. */
  healthRecordFlags?: Record<string, boolean>;
  /**
   * Guardian contacts per roster member id (#510). Present only for the club's
   * director and deputy on the current year: it is what turns the guardian
   * fields on in the add/edit popup. Omitted for every other role, so nothing
   * about guardians is rendered or sent.
   */
  guardians?: Record<string, GuardianRecord[]>;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [honorSummaries, setHonorSummaries] = useState(initialHonorSummaries);
  const [honorsFor, setHonorsFor] = useState<RosterMemberRecord | null>(null);
  const [editing, setEditing] = useState<RosterMemberRecord | null>(null);
  /** The type picked in the dialog, so the Role placeholder shows the blank-role default (#424). */
  const [formType, setFormType] = useState<string>("YOUTH");
  const [formBirthDate, setFormBirthDate] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [birthDates, setBirthDates] = useState<Record<string, string> | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [complianceFilter, setComplianceFilter] = useState(initialComplianceFilter);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fieldErrors, setFieldErrors] = useState<RosterFormErrors>({});
  const [guardianMap, setGuardianMap] = useState(initialGuardians);
  const [guardianErrors, setGuardianErrors] = useState<GuardianFormErrors>({});
  const canEditGuardians = initialGuardians !== undefined && !readOnly;
  /** Whether the dialog has this member's current guardians (#510): "failed" leaves guardians untouched on save. */
  const [guardianState, setGuardianState] = useState<"ready" | "loading" | "failed">("ready");
  const [guardianRev, setGuardianRev] = useState(0);
  const guardianLoadToken = useRef(0);
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/roster`;
  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditing(null);
  }, []);
  const dialogRef = useAccessibleDialog<HTMLElement>(dialogOpen, closeDialog);
  const closeHonors = useCallback(() => setHonorsFor(null), []);

  /** After a honor is recorded in the popup, refresh the row's chips from the Honors list. */
  async function refreshHonorSummaries() {
    try {
      const response = await fetch(`/api/attendee/clubs/${encodeURIComponent(organizationId)}/honors`);
      const body = await response.json().catch(() => ({})) as { rows?: ClubHonorsRow[] };
      if (response.ok && body.rows) setHonorSummaries(honorSummaryByMemberId(body.rows));
    } catch {
      // The chips catch up on the next page load.
    }
  }

  /** Add and edit happen in a pop-up (#383), so the list never scrolls away. */
  function openDialog(member: RosterMemberRecord | null) {
    setEditing(member);
    setFormType(member?.attendeeType ?? "YOUTH");
    setFormBirthDate("");
    setNotice("");
    setError("");
    setFieldErrors({});
    setGuardianErrors({});
    setDialogOpen(true);
    // Re-read this member's guardians as the dialog opens, so a page left open
    // can't save over a co-leader's newer edit (#510). Until the answer is
    // in, the guardian fields are read-only and a save is held back.
    const token = ++guardianLoadToken.current;
    if (canEditGuardians && member) {
      setGuardianState("loading");
      fetch(base)
        .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) as RosterResponse }))
        .then(({ ok, body }) => {
          if (token !== guardianLoadToken.current) return;
          if (ok && body.guardians) {
            setGuardianMap(body.guardians);
            setGuardianRev((current) => current + 1);
            setGuardianState("ready");
          } else {
            setGuardianState("failed");
          }
        })
        .catch(() => {
          if (token === guardianLoadToken.current) setGuardianState("failed");
        });
    } else {
      setGuardianState("ready");
    }
  }

  const typeHint = formBirthDate
    ? attendeeTypeAgeHint(formType as keyof typeof clubRosterAttendeeTypeLabels, formBirthDate, calendarDateInEventTimeZone(new Date(), "America/Chicago"))
    : null;
  const active = members.filter((member) => member.status === "ACTIVE");
  const needBirthDates = active.filter((member) => member.birthDateNeeded).length;
  const notInCompliance = complianceStatuses
    ? active.filter((member) => complianceStatuses[member.id]?.state === "NOT_COMPLIANT").length
    : 0;
  const expiringSoon = complianceStatuses
    ? active.filter((member) => complianceStatuses[member.id]?.state === "FLAGGED").length
    : 0;
  const beforeComplianceFilter = showInactive ? members : active;
  const visible = complianceFilter && complianceStatuses
    ? beforeComplianceFilter.filter((member) => complianceStatuses[member.id]?.state === complianceFilterState[complianceFilter])
    : beforeComplianceFilter;
  const sections = [
    { key: "STAFF", title: "Staff", empty: "No staff on the roster yet.", people: visible.filter((member) => rosterSectionOf(member.attendeeType) === "STAFF") },
    { key: "MEMBERS", title: "Members", empty: "No Pathfinders on the roster yet.", people: visible.filter((member) => rosterSectionOf(member.attendeeType) === "MEMBERS") },
  ] as const;
  /** Name, Age, Type, Current class, Role, Gender, Flags — plus every optional column, for the section-title row's colSpan. */
  const rosterColumnCount = 7 + (birthDates ? 1 : 0) + (complianceStatuses ? 1 : 0) + (honorSummaries ? 1 : 0) + (readOnly ? 0 : 1);

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
      if (result.guardians) setGuardianMap(result.guardians);
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
    const attendeeType = String(form.get("attendeeType") ?? "YOUTH");
    // Inline, per-field errors (#571 F-26) instead of only the browser tooltip.
    const errors = validateRosterForm({
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      birthDate,
      birthDateText: String(form.get("birthDateText") ?? ""),
      gender: String(form.get("gender") ?? ""),
      editing: Boolean(editing),
    });
    setFieldErrors(errors);
    // Guardian contacts (#510): two slots, every field optional; only email and phone format are checked.
    if (canEditGuardians && guardianState === "loading") {
      setError("Still loading this person's guardian contacts. Try again in a moment.");
      return;
    }
    const guardianSlots = canEditGuardians && guardianState === "ready"
      ? Array.from({ length: GUARDIAN_SLOTS }, (_, index) => ({
        name: String(form.get(`g${index + 1}Name`) ?? "").trim(),
        relationship: String(form.get(`g${index + 1}Relationship`) ?? "").trim(),
        email: String(form.get(`g${index + 1}Email`) ?? "").trim(),
        phone: String(form.get(`g${index + 1}Phone`) ?? "").trim(),
      }))
      : null;
    const guardianProblems = guardianSlots ? validateGuardianForm(guardianSlots) : {};
    setGuardianErrors(guardianProblems);
    const firstInvalid = rosterFormFieldOrder.find((field) => errors[field]);
    if (firstInvalid) {
      const target = firstInvalid === "birthDate" ? "birthDateText" : firstInvalid;
      (formElement.elements.namedItem(target) as HTMLElement | null)?.focus();
      return;
    }
    const firstGuardianProblem = Object.keys(guardianProblems)[0];
    if (firstGuardianProblem) {
      (formElement.elements.namedItem(firstGuardianProblem) as HTMLElement | null)?.focus();
      return;
    }
    const details = {
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      attendeeType,
      role: String(form.get("role") ?? ""),
      classLevel: String(form.get("classLevel") ?? "") || null,
      gender: String(form.get("gender") ?? "") || null,
      ...(guardianSlots ? { guardians: guardianSlots } : {}),
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
    const result = await call(`${base}/${encodeURIComponent(member.id)}`, "DELETE", { confirm: true }, "Removed and erased.");
    if (result?.nameKept) setNotice("Removed and erased. Their name stays on items already ordered.");
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
            <h2 id="club-roster-heading">Roster</h2>
          </div>
          <div className="club-roster-heading-actions">
            <span className="count-badge">{active.length} active</span>
            {!readOnly && (
              <button className="primary-button" disabled={saving} onClick={() => openDialog(null)} type="button">
                <Plus aria-hidden="true" size={16} /> Add to roster
              </button>
            )}
            {!readOnly && headingActions}
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
        {complianceFilter && complianceStatuses && (
          <p className="inline-notice roster-compliance-notice" role="status">
            Showing only people {complianceFilterLabels[complianceFilter]}.{" "}
            <button className="text-button" onClick={() => setComplianceFilter(null)} type="button">Clear filter</button>
          </p>
        )}
        <div className="club-roster-tools club-roster-toolbar">
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
            <UsersRound size={17} aria-hidden="true" /> {complianceFilter && complianceStatuses
              ? "No one matches this filter."
              : readOnly
                ? "No one is on this club's roster yet."
                : "No one is on the roster yet. Add regular members using Add to roster above, or import a CSV. You can add event-only guests when registering."}
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
            <table aria-labelledby="club-roster-heading" className="report-table roster-card-table">
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
                  {honorSummaries && <th>Honors</th>}
                  {!readOnly && <th><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              {/* One row group per section, so each section heading covers only its own rows. */}
                {sections.map((section) => (
                  <tbody key={section.key}>
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
                              {/* The flex layout lives on this wrapper: a td that is itself flex stops being a table cell and drifts out of line (#435). */}
                              <div className="roster-flag-list">
                              {member.status === "INACTIVE" && (
                                <span className="status-chip gold">{clubRosterStatusLabels.INACTIVE}</span>
                              )}
                              {missing.length > 0 && (
                                <span className="status-chip gold roster-missing-info" title={`Missing: ${missing.join(", ")}`}>
                                  Missing info: {missing.join(", ")}
                                </span>
                              )}
                              {member.status === "ACTIVE" && missing.length === 0 && "—"}
                              </div>
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
                                    {(complianceStatuses[member.id]!.reasons ?? []).length > 0 && (
                                      <small className="quiet-copy background-check-note">
                                        <br />{complianceStatuses[member.id]!.reasons!.join("; ")}
                                      </small>
                                    )}
                                  </>
                                ) : "—"}
                              </td>
                            )}
                            {honorSummaries && (
                              <td data-label="Honors">
                                {(honorSummaries[member.id] ?? []).length === 0 ? "—" : (
                                  <div className="roster-flag-list">
                                    {(honorSummaries[member.id] ?? []).map((honor) => (
                                      <span className={`status-chip ${honor.status === "COMPLETED" ? "green" : "gold"}`} key={honor.honorId}>
                                        <Award aria-hidden="true" size={12} /> {honor.honorName}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {honorsPopup && (
                                  <button
                                    aria-haspopup="dialog"
                                    aria-label={`Honors for ${member.firstName} ${member.lastName}`}
                                    className="secondary-button roster-honors-button"
                                    onClick={() => setHonorsFor(member)}
                                    type="button"
                                  >
                                    <Award aria-hidden="true" size={13} /> Honors
                                  </button>
                                )}
                              </td>
                            )}
                            {!readOnly && <td className="roster-card-actions" data-label="Actions">
                              <div className="honor-row-actions">
                              {healthRecordFlags?.[member.id] && (
                                <span className="status-chip">Has a health record</span>
                              )}
                              {healthTab && (
                                <a
                                  aria-label={`Health record for ${member.firstName} ${member.lastName}`}
                                  className="secondary-button"
                                  href={`/account/clubs/${encodeURIComponent(organizationId)}/roster/${encodeURIComponent(member.id)}/health`}
                                >
                                  Health{healthTab[member.id]?.status === "NEEDS_UPDATE" ? ": needs update" : healthTab[member.id]?.status === "NONE" ? ": none yet" : ""}
                                </a>
                              )}
                              <button aria-label={`Edit ${member.firstName} ${member.lastName}`} className="secondary-button" disabled={saving} onClick={() => openDialog(member)} type="button">
                                <Pencil aria-hidden="true" size={13} />
                              </button>
                              <button aria-label={`Remove ${member.firstName} ${member.lastName}`} className="secondary-button" disabled={saving} onClick={() => remove(member)} type="button">
                                <Trash2 aria-hidden="true" size={13} />
                              </button>
                              </div>
                            </td>}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                ))}
            </table>
          </div>
        )}
      </section>

      {dialogOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeDialog(); }} role="presentation">
      <section aria-labelledby="roster-dialog-title" aria-modal="true" className="modal-card roster-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
      <form
        className="form-stack"
        key={editing?.id ?? "new"}
        noValidate
        onInput={(event) => {
          const name = (event.target as HTMLInputElement).name;
          const field = (name === "birthDateText" ? "birthDate" : name) as RosterFormField;
          setFieldErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
        }}
        onSubmit={save}
      >
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
            <input aria-describedby={fieldErrors.firstName ? "roster-firstName-error" : undefined} aria-invalid={fieldErrors.firstName ? true : undefined} autoComplete="off" defaultValue={editing?.firstName ?? ""} maxLength={80} name="firstName" required />
            {fieldErrors.firstName && <span className="roster-field-error" id="roster-firstName-error" role="alert">{fieldErrors.firstName}</span>}
          </label>
          <label>
            Last name
            <input aria-describedby={fieldErrors.lastName ? "roster-lastName-error" : undefined} aria-invalid={fieldErrors.lastName ? true : undefined} autoComplete="off" defaultValue={editing?.lastName ?? ""} maxLength={80} name="lastName" required />
            {fieldErrors.lastName && <span className="roster-field-error" id="roster-lastName-error" role="alert">{fieldErrors.lastName}</span>}
          </label>
          <BirthDateField
            defaultValue={editing && birthDates ? birthDates[editing.id] ?? "" : ""}
            label={editing && !editing.birthDateNeeded ? "Birth date (leave blank to keep)" : "Birth date"}
            error={fieldErrors.birthDate}
            name="birthDate"
            onParsedChange={setFormBirthDate}
            required={!editing}
          />
          <label>
            Type
            <select aria-describedby="roster-type-hint roster-type-definitions" defaultValue={editing?.attendeeType ?? "YOUTH"} name="attendeeType" onChange={(event) => setFormType(event.target.value)}>
              {Object.entries(clubRosterAttendeeTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <div className="roster-type-help">
            <RosterTypeDefinitions className="field-help" id="roster-type-definitions" />
            <p className="field-help roster-type-hint" id="roster-type-hint" role="status">{typeHint ?? ""}</p>
          </div>
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
            <select aria-describedby={fieldErrors.gender ? "roster-gender-error" : undefined} aria-invalid={fieldErrors.gender ? true : undefined} defaultValue={editing?.gender ?? ""} name="gender" required>
              <option disabled value="">Choose one</option>
              {Object.entries(clubRosterGenderLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            {fieldErrors.gender && <span className="roster-field-error" id="roster-gender-error" role="alert">{fieldErrors.gender}</span>}
          </label>
        </div>
        {canEditGuardians && (
          <fieldset className="roster-guardians" key={`${editing?.id ?? "new"}-${guardianRev}`}>
            <legend>Guardians (optional)</legend>
            <p className="field-help">
              Up to two guardians. Your club&apos;s director and deputy, Area Coordinators and conference staff with
              sensitive-data access can see them. They are erased when this person is removed from the roster.
            </p>
            {guardianState === "failed" && (
              <p className="field-help" role="status">Guardian contacts couldn&apos;t be loaded, so saving won&apos;t change them. Close and reopen this person to try again.</p>
            )}
            {Array.from({ length: GUARDIAN_SLOTS }, (_, index) => {
              const slot = index + 1;
              const stored = guardianSlotValues(editing ? guardianMap?.[editing.id] : undefined)[index]!;
              const emailError = guardianErrors[`g${slot as 1 | 2}Email`];
              const phoneError = guardianErrors[`g${slot as 1 | 2}Phone`];
              return (
                <div className="roster-guardian-slot" key={slot} role="group" aria-label={`Guardian ${slot}`}>
                  <h3>Guardian {slot}</h3>
                  <div className="form-grid two-column">
                    <label>
                      {guardianFieldLabels.name}
                      <input autoComplete="off" defaultValue={stored.name} readOnly={guardianState !== "ready"} maxLength={120} name={`g${slot}Name`} />
                    </label>
                    <label>
                      {guardianFieldLabels.relationship}
                      <input autoComplete="off" defaultValue={stored.relationship} readOnly={guardianState !== "ready"} maxLength={60} name={`g${slot}Relationship`} placeholder="e.g. Mother" />
                    </label>
                    <label>
                      {guardianFieldLabels.email}
                      <input aria-describedby={emailError ? `roster-g${slot}Email-error` : undefined} aria-invalid={emailError ? true : undefined} autoComplete="off" defaultValue={stored.email} readOnly={guardianState !== "ready"} inputMode="email" maxLength={254} name={`g${slot}Email`} type="text" />
                      {emailError && <span className="roster-field-error" id={`roster-g${slot}Email-error`} role="alert">{emailError}</span>}
                    </label>
                    <label>
                      {guardianFieldLabels.phone}
                      <input aria-describedby={phoneError ? `roster-g${slot}Phone-error` : undefined} aria-invalid={phoneError ? true : undefined} autoComplete="off" defaultValue={stored.phone} readOnly={guardianState !== "ready"} inputMode="tel" maxLength={40} name={`g${slot}Phone`} type="text" />
                      {phoneError && <span className="roster-field-error" id={`roster-g${slot}Phone-error`} role="alert">{phoneError}</span>}
                    </label>
                  </div>
                </div>
              );
            })}
          </fieldset>
        )}
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
      {honorsFor && honorsPopup && (
        <ClubMemberHonorsDialog
          canRecord={honorsPopup.canRecord}
          member={honorsFor}
          onClose={closeHonors}
          onRecorded={refreshHonorSummaries}
          organizationId={organizationId}
        />
      )}
    </div>
  );
}
