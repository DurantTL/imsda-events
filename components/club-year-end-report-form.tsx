"use client";

import { useMemo, useState } from "react";
import { RotateCcw, Save, Send } from "lucide-react";
import {
  yearEndFields,
  yearEndSectionTitles,
  yearEndTotals,
  type ResolvedField,
  type YearEndSection,
} from "@/modules/club-reports/year-end-domain";
import type { YearEndReportRecord } from "@/modules/club-reports/year-end-repository";

type Contact = {
  contactName: string;
  contactWorkPhone: string;
  contactHomePhone: string;
  contactCellPhone: string;
  contactEmail: string;
};

type PrefillMeta = {
  unplaced: { membersWithoutGender: number; membersWithoutAge: number; membersAgeOutsideBands: number; staffWithoutGender: number };
  tltsOnRoster: number;
} | null;

type SaveResponse = { report?: YearEndReportRecord; message?: string; issues?: Array<{ message?: string }> };

const sectionOrder: YearEndSection[] = [
  "membership", "staff", "tlts", "youthBaptisms", "adultBaptisms", "invested", "honors", "honorMasters", "leadershipAward", "instructorAward",
];

const originLabels = {
  "roster-age": "from your roster, estimated from the age on file (grade isn't stored)",
  roster: "from your roster",
  "class-completions": "from your class completions",
  honors: "from your honor records",
} as const;

const toCount = (value: string) => {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
};

/**
 * The Pathfinder Year-End Report (#607). Each pre-filled count says where it
 * came from; the director may change it, and the original stays visible.
 * Totals are calculated here for display only: the server works them out
 * again and never trusts these. Counts only, no names.
 */
export function ClubYearEndReportForm({
  endpoint,
  reportYear,
  spanLabel,
  dueLabel,
  initialResolved,
  initialContact,
  status,
  late,
  prefillMeta,
  readOnly,
  readOnlyNote,
}: {
  endpoint: string;
  reportYear: string;
  spanLabel: string;
  dueLabel: string;
  initialResolved: Record<string, ResolvedField>;
  initialContact: Contact;
  status: "DRAFT" | "SUBMITTED" | null;
  late: boolean;
  prefillMeta: PrefillMeta;
  readOnly: boolean;
  readOnlyNote?: string;
}) {
  const [resolved, setResolved] = useState(initialResolved);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    yearEndFields.map((field) => [field.key, String(initialResolved[field.key]?.value ?? 0)]),
  ));
  const [contact, setContact] = useState<Contact>(initialContact);
  const [current, setCurrent] = useState(status);
  const [isLate, setIsLate] = useState(late);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = readOnly || current === "SUBMITTED";

  const totals = useMemo(
    // A blank pre-filled field counts as its pre-filled number, exactly as the server resolves it.
    () => yearEndTotals(Object.fromEntries(yearEndFields.map((field) => [
      field.key,
      toCount(values[field.key] ?? "") ?? (field.source === "prefill" ? (resolved[field.key]?.prefill ?? 0) : 0),
    ]))),
    [values, resolved],
  );

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const next: "DRAFT" | "SUBMITTED" = submitter?.value === "draft" ? "DRAFT" : "SUBMITTED";
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...contact,
          values: Object.fromEntries(yearEndFields.map((field) => [field.key, toCount(values[field.key] ?? "")])),
          status: next,
        }),
      });
      const result = await response.json().catch(() => ({})) as SaveResponse;
      if (!response.ok || !result.report) {
        setError(result.issues?.[0]?.message ?? result.message ?? "The report could not be saved.");
        return;
      }
      setResolved(result.report.resolved);
      setCurrent(result.report.status);
      setIsLate(result.report.late);
      setNotice(next === "DRAFT" ? "Draft saved." : "Report submitted. Thank you.");
    } catch {
      setError("The report could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const totalLine = (label: string, value: number) => (
    <div className="club-report-item club-report-auto" key={label}>
      <span><strong>{label}</strong><small>Calculated</small></span>
      <strong>{value}</strong>
    </div>
  );

  return (
    <form className="page-stack club-report-form" onSubmit={save}>
      <div className="public-manage-card">
        <p className="public-registration-eyebrow">Pathfinder year {reportYear} · {spanLabel}</p>
        <h2>Year-End Report</h2>
        <p className="field-help">
          Due {dueLabel}. Please report as accurately as possible; your information aids the North America Division.
          Counts only, no names.
        </p>
        {current && (
          <span className={`status-chip ${current === "DRAFT" ? "gold" : "green"}`}>
            {current === "DRAFT" ? "Draft" : `Submitted${isLate ? " (late)" : ""}`}
          </span>
        )}
      </div>

      {readOnly && <div className="inline-notice" role="status">{readOnlyNote ?? "This report is closed."}</div>}
      {!readOnly && current === "SUBMITTED" && (
        <div className="inline-notice" role="status">
          Submitted. It is closed to changes; ask the conference office to reopen it if something needs to change.
        </div>
      )}
      <div className="inline-notice" role="note">
        Counts include roster members who were active at any point during the Pathfinder year, and TLTs (staff with the TLT class included).
        Youth are grouped by age on the roster, using the age on file.
      </div>
      {prefillMeta && (
        <div className="inline-notice" role="status">
          Not placed (age outside 10–18): {prefillMeta.unplaced.membersAgeOutsideBands}. These members are left out of the membership totals.
          {prefillMeta.unplaced.membersWithoutGender + prefillMeta.unplaced.staffWithoutGender > 0
            ? ` ${prefillMeta.unplaced.membersWithoutGender + prefillMeta.unplaced.staffWithoutGender} more have no gender on file.` : ""}
          {prefillMeta.unplaced.membersWithoutAge > 0 ? ` ${prefillMeta.unplaced.membersWithoutAge} more have no age or birth date on file.` : ""}
          {" "}Fix the roster, or adjust the numbers below.
        </div>
      )}
      {prefillMeta && prefillMeta.tltsOnRoster > 0 && (
        <div className="inline-notice" role="status">
          Your roster has {prefillMeta.tltsOnRoster} TLT{prefillMeta.tltsOnRoster === 1 ? "" : "s"}, but TLT level (1 to 4) isn&apos;t recorded, so enter the TLT counts by hand.
        </div>
      )}
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <fieldset className="public-manage-card form-stack" disabled={locked || saving}>
        <legend className="public-registration-eyebrow">Who is reporting</legend>
        <div className="form-grid two-column">
          <label>Name<input autoComplete="name" maxLength={120} onChange={(event) => setContact({ ...contact, contactName: event.target.value })} value={contact.contactName} /></label>
          <label>Email<input autoComplete="email" maxLength={200} onChange={(event) => setContact({ ...contact, contactEmail: event.target.value })} type="email" value={contact.contactEmail} /></label>
          <label>Work phone<input autoComplete="tel" maxLength={40} onChange={(event) => setContact({ ...contact, contactWorkPhone: event.target.value })} type="tel" value={contact.contactWorkPhone} /></label>
          <label>Home phone<input autoComplete="tel" maxLength={40} onChange={(event) => setContact({ ...contact, contactHomePhone: event.target.value })} type="tel" value={contact.contactHomePhone} /></label>
          <label>Cell phone<input autoComplete="tel" maxLength={40} onChange={(event) => setContact({ ...contact, contactCellPhone: event.target.value })} type="tel" value={contact.contactCellPhone} /></label>
        </div>
      </fieldset>

      {sectionOrder.map((section) => {
        const fields = yearEndFields.filter((field) => field.section === section);
        return (
          <fieldset className="public-manage-card form-stack" disabled={locked || saving} key={section}>
            <legend className="public-registration-eyebrow">{yearEndSectionTitles[section]}</legend>
            {fields.map((field) => {
              const info = resolved[field.key];
              const typed = toCount(values[field.key] ?? "");
              const original = field.source === "prefill" ? (info?.prefill ?? null) : null;
              const overridden = original !== null && typed !== null && typed !== original;
              return (
                <div className="club-report-item" key={field.key}>
                  <label htmlFor={`ye-${field.key}`}>
                    <strong>{field.label}</strong>
                    <small>
                      {field.origin ? originLabels[field.origin] : "Enter by hand"}
                      {overridden ? ` · you changed it from ${original}` : ""}
                    </small>
                  </label>
                  <span className="intro-actions">
                    <input
                      id={`ye-${field.key}`}
                      inputMode="numeric"
                      max={9999}
                      min={0}
                      onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
                      type="number"
                      value={values[field.key] ?? ""}
                    />
                    {overridden && !locked && (
                      <button
                        aria-label={`Restore ${original} for ${field.label}`}
                        className="text-button"
                        onClick={() => setValues((previous) => ({ ...previous, [field.key]: String(original) }))}
                        type="button"
                      >
                        <RotateCcw aria-hidden="true" size={14} /> {original}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
            {section === "membership" && totalLine("Membership total", totals.membership)}
            {section === "staff" && (
              <>
                {totalLine("Staff total", totals.staff)}
                {totalLine("3. Total membership (1 + 2)", totals.totalMembership)}
              </>
            )}
            {section === "tlts" && totalLine("TLTs total", totals.tlts)}
            {section === "youthBaptisms" && totalLine("Youth baptisms total", totals.youthBaptisms)}
            {section === "invested" && totalLine("Number invested, total", totals.invested)}
          </fieldset>
        );
      })}

      {!locked && (
        <div className="intro-actions">
          <button className="secondary-button" disabled={saving} formNoValidate name="intent" type="submit" value="draft">
            <Save aria-hidden="true" size={16} /> Save draft
          </button>
          <button className="primary-button" disabled={saving} name="intent" type="submit" value="submit">
            <Send aria-hidden="true" size={16} /> Submit report
          </button>
        </div>
      )}
    </form>
  );
}
