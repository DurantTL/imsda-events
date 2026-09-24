"use client";

import { useMemo, useState } from "react";
import { CircleAlert, RefreshCw, Save, Send } from "lucide-react";
import {
  MAX_HONORS,
  ON_TIME_POINTS,
  pickedTotal,
  pointItems,
  reportProblems,
  type PickedPoints,
  type PointItemKey,
  type ReportHonor,
} from "@/modules/club-reports/domain";
import type { ClubReportRecord } from "@/modules/club-reports/repository";
import { clubClassLevelLabels, type ClubClassLevel } from "@/modules/club-rosters/domain";

type Prefill = {
  meetingPlace: string;
  meetingSchedule: string;
  pathfinderCount: number;
  tltCount: number;
  staffCount: number;
  /** From that month's meeting notes, for a brand new report (#426); null with no notes yet. */
  averageAttendance: number | null;
  honors: ReportHonor[];
};

/** The raw meeting-notes averages, for the "Refresh from meeting notes" button on a draft (#426). */
export type NotesPrefill = { averageAttendance: number | null; pathfinderCount: number | null; tltCount: number | null; staffCount: number | null; honors: ReportHonor[] };

type SaveResponse = { report?: ClubReportRecord; message?: string; issues?: Array<{ message?: string }> };

const pathfinderClasses: ClubClassLevel[] = ["FRIEND", "COMPANION", "EXPLORER", "RANGER", "VOYAGER", "GUIDE"];

function toCount(value: string) {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatShortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function padHonors(honors: readonly ReportHonor[]) {
  const list = [...honors];
  while (list.length < MAX_HONORS) list.push({ name: "", participants: null });
  return list;
}

/**
 * The monthly report (#377). Every item is picked from the values the old
 * form offered, except on time, which the server works out. The total is
 * shown live and anything the rules refuse is flagged before saving. A new
 * report prefills from that month's meeting notes (#426); "Save draft" and
 * "Submit report" are distinct actions with a visible draft/submitted state.
 */
export function ClubReportForm({
  endpoint,
  reopenEndpoint,
  monthLabel,
  dueLabel,
  initial,
  prefill,
  notesPrefill,
  expectedOnTime,
  readOnly,
  readOnlyNote,
  allowDraft = false,
  variant = "account",
}: {
  endpoint: string;
  /** Only for the account variant: reopens a SUBMITTED report back to DRAFT (#426). */
  reopenEndpoint?: string;
  monthLabel: string;
  dueLabel: string;
  initial: ClubReportRecord | null;
  prefill: Prefill;
  notesPrefill?: NotesPrefill | null;
  /** On-time points this report will get: fixed once submitted, otherwise whether today is by the due date. */
  expectedOnTime: number;
  readOnly: boolean;
  /** Replaces the "closed after the due date" note, e.g. for an Area Coordinator's view (#387). */
  readOnlyNote?: string;
  /** Whether Save draft / Submit report are offered separately (club directors); staff always submits directly. */
  allowDraft?: boolean;
  variant?: "account" | "staff";
}) {
  const [report, setReport] = useState(initial);
  const [points, setPoints] = useState<PickedPoints>(initial?.points ?? {});
  const [classLevels, setClassLevels] = useState<ClubClassLevel[]>(initial?.classLevels ?? []);
  const [honors, setHonors] = useState<ReportHonor[]>(() => padHonors(initial?.honors ?? (initial ? [] : prefill.honors)));
  const [countsRefresh, setCountsRefresh] = useState<Pick<NotesPrefill, "averageAttendance" | "pathfinderCount" | "tltCount" | "staffCount"> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // A draft stores no on-time points yet; show what submitting now would earn.
  const onTime = report?.status === "SUBMITTED" ? report.onTimePoints : expectedOnTime;
  const total = onTime + pickedTotal(points);
  const problems = useMemo(() => reportProblems({ points, honors, classLevels }), [points, honors, classLevels]);
  const problemFor = (key: PointItemKey | "honorsList") => problems.find((problem) => problem.key === key)?.message;
  const unanswered = pointItems.filter((item) => points[item.key] === undefined).length;
  const isDraft = report?.status === "DRAFT";

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const status: "DRAFT" | "SUBMITTED" = submitter?.value === "draft" ? "DRAFT" : "SUBMITTED";
    if (status === "SUBMITTED" && problems.length > 0) {
      setError("Fix the items marked below before submitting.");
      return;
    }
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingPlace: String(form.get("meetingPlace") ?? ""),
          meetingSchedule: String(form.get("meetingSchedule") ?? ""),
          averageAttendance: toCount(String(form.get("averageAttendance") ?? "")),
          pathfinderCount: toCount(String(form.get("pathfinderCount") ?? "")),
          tltCount: toCount(String(form.get("tltCount") ?? "")),
          staffCount: toCount(String(form.get("staffCount") ?? "")),
          investitureDate: String(form.get("investitureDate") ?? ""),
          classLevels,
          points,
          honors: honors.filter((honor) => honor.name.trim() || honor.participants !== null),
          signatureName: String(form.get("signatureName") ?? ""),
          signedOn: String(form.get("signedOn") ?? ""),
          status,
        }),
      });
      const result = await response.json().catch(() => ({})) as SaveResponse;
      if (!response.ok || !result.report) throw new Error(result.message ?? result.issues?.[0]?.message ?? "The report could not be saved.");
      setReport(result.report);
      setCountsRefresh(null);
      setNotice(status === "DRAFT" ? "Draft saved." : `Submitted. ${result.report.totalPoints} points for ${monthLabel}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The report could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function reopen() {
    if (!reopenEndpoint) return;
    if (!window.confirm("Reopen this report as a draft? You can change it and submit again before the due date.")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(reopenEndpoint, { method: "POST" });
      const result = await response.json().catch(() => ({})) as SaveResponse;
      if (!response.ok || !result.report) throw new Error(result.message ?? "This report could not be reopened.");
      setReport(result.report);
      setNotice("Reopened as a draft.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This report could not be reopened.");
    } finally {
      setSaving(false);
    }
  }

  function refreshFromNotes() {
    if (!notesPrefill) return;
    if (!window.confirm("Replace attendance and honors below with this month's meeting-note averages? Anything else you typed stays.")) return;
    setCountsRefresh({
      averageAttendance: notesPrefill.averageAttendance,
      pathfinderCount: notesPrefill.pathfinderCount,
      tltCount: notesPrefill.tltCount,
      staffCount: notesPrefill.staffCount,
    });
    setHonors(padHonors(notesPrefill.honors));
  }

  const card = variant === "account" ? "public-manage-card" : "panel";
  const eyebrow = variant === "account" ? "public-registration-eyebrow" : "eyebrow";
  // Keyed only on the four counts, so a refresh leaves other typed fields alone.
  const countsKey = countsRefresh ? "refreshed" : "initial";
  const countValue = (field: "averageAttendance" | "pathfinderCount" | "tltCount" | "staffCount", reportValue: number | null | undefined, prefillValue: number | null) => {
    if (countsRefresh) return countsRefresh[field] ?? "";
    if (reportValue !== null && reportValue !== undefined) return reportValue;
    return prefillValue ?? "";
  };

  return (
    <form className="club-report-form" onSubmit={save}>
      <div className={`${card} club-report-total`} aria-live="polite">
        <div>
          <p className={eyebrow}>{monthLabel}</p>
          <h2>{total} points</h2>
          <p className="field-help">
            {onTime > 0 ? `Includes ${ON_TIME_POINTS} for submitting by ${dueLabel}.` : `Submitted after ${dueLabel}, so no on-time points.`}
            {unanswered > 0 && !readOnly ? ` ${unanswered} item${unanswered === 1 ? "" : "s"} not answered yet (counted as 0).` : ""}
          </p>
        </div>
        {report && (
          <span className={`status-chip ${isDraft ? "gold" : "green"}`}>
            {isDraft ? "Draft" : `Submitted${report.submittedAt ? ` (${formatShortDate(report.submittedAt)})` : ""}`}
          </span>
        )}
      </div>

      {readOnly && (
        <div className="inline-notice" role="status">{readOnlyNote ?? `This report closed after ${dueLabel}. Ask the conference office if something needs to change.`}</div>
      )}
      {!readOnly && allowDraft && !isDraft && report && reopenEndpoint && (
        <div className="inline-notice" role="status">
          Submitted. <button className="text-button" disabled={saving} onClick={reopen} type="button">Reopen as draft</button> to change it.
        </div>
      )}
      {!readOnly && notesPrefill && report && isDraft && (
        <div className="inline-notice" role="status">
          <button className="text-button" disabled={saving} onClick={refreshFromNotes} type="button">
            <RefreshCw aria-hidden="true" size={14} /> Refresh from meeting notes
          </button>
        </div>
      )}
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <fieldset className={`${card} form-stack`} disabled={readOnly || saving}>
        <legend className={eyebrow}>Club facts</legend>
        <div className="form-grid two-column">
          <label>Meeting place<input defaultValue={report?.meetingPlace ?? prefill.meetingPlace} maxLength={200} name="meetingPlace" /></label>
          <label>Meeting day and time<input defaultValue={report?.meetingSchedule ?? prefill.meetingSchedule} maxLength={120} name="meetingSchedule" /></label>
          <label>Average attendance<input key={`${countsKey}-averageAttendance`} defaultValue={countValue("averageAttendance", report?.averageAttendance, prefill.averageAttendance)} inputMode="numeric" max={999} min={0} name="averageAttendance" type="number" /></label>
          <label>Number of Pathfinders<input key={`${countsKey}-pathfinderCount`} defaultValue={countValue("pathfinderCount", report?.pathfinderCount, prefill.pathfinderCount)} inputMode="numeric" max={999} min={0} name="pathfinderCount" type="number" /></label>
          <label>Number of TLTs<input key={`${countsKey}-tltCount`} defaultValue={countValue("tltCount", report?.tltCount, prefill.tltCount)} inputMode="numeric" max={999} min={0} name="tltCount" type="number" /></label>
          <label>Number of staff<input key={`${countsKey}-staffCount`} defaultValue={countValue("staffCount", report?.staffCount, prefill.staffCount)} inputMode="numeric" max={999} min={0} name="staffCount" type="number" /></label>
          <label>Investiture date (if set)<input defaultValue={report?.investitureDate ?? ""} name="investitureDate" type="date" /></label>
        </div>
      </fieldset>

      <fieldset className={`${card} form-stack`} disabled={readOnly || saving}>
        <legend className={eyebrow}>Points</legend>
        <div className="club-report-item club-report-auto">
          <span><strong>Report submitted by {dueLabel}</strong><small>Worked out from when you first submit.</small></span>
          <strong>{onTime}</strong>
        </div>
        {pointItems.map((item) => {
          const problem = problemFor(item.key);
          return (
            <div className={`club-report-item${problem ? " has-problem" : ""}`} key={item.key}>
              <label htmlFor={`points-${item.key}`}>
                <strong>{item.label}</strong>
                {item.help && <small>{item.help}</small>}
                {problem && <small className="club-report-problem"><CircleAlert aria-hidden="true" size={13} /> {problem}</small>}
              </label>
              <select
                id={`points-${item.key}`}
                onChange={(event) => setPoints((current) => {
                  const next = { ...current };
                  if (event.target.value === "") delete next[item.key];
                  else next[item.key] = Number(event.target.value);
                  return next;
                })}
                value={points[item.key] ?? ""}
              >
                <option value="">Choose</option>
                {item.values.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
          );
        })}

        <div className="club-report-sub">
          <strong>Class levels worked on</strong>
          <div className="club-report-checks">
            {pathfinderClasses.map((level) => (
              <label className="checkbox-label" key={level}>
                <input
                  checked={classLevels.includes(level)}
                  onChange={(event) => setClassLevels((current) => (event.target.checked ? [...current, level] : current.filter((item) => item !== level)))}
                  type="checkbox"
                />
                {clubClassLevelLabels[level]}
              </label>
            ))}
          </div>
        </div>

        <div className="club-report-sub">
          <strong>Honors worked on (up to {MAX_HONORS})</strong>
          {problemFor("honorsList") && <small className="club-report-problem">{problemFor("honorsList")}</small>}
          {honors.map((honor, index) => (
            <div className="form-grid two-column club-report-honor" key={index}>
              <label>
                Honor {index + 1}
                <input
                  maxLength={80}
                  onChange={(event) => setHonors((current) => current.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))}
                  value={honor.name}
                />
              </label>
              <label>
                Number participating
                <input
                  inputMode="numeric"
                  max={999}
                  min={0}
                  onChange={(event) => setHonors((current) => current.map((item, i) => (i === index ? { ...item, participants: toCount(event.target.value) } : item)))}
                  type="number"
                  value={honor.participants ?? ""}
                />
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className={`${card} form-stack`} disabled={readOnly || saving}>
        <legend className={eyebrow}>Signature</legend>
        <div className="form-grid two-column">
          <label>Type your full name<input autoComplete="name" defaultValue={report?.signatureName ?? ""} maxLength={120} minLength={2} name="signatureName" required /></label>
          <label>Date<input defaultValue={report?.signedOn ?? today()} name="signedOn" required type="date" /></label>
        </div>
        {!readOnly && (
          <div className="intro-actions">
            {allowDraft && (!report || isDraft) && (
              <button className="secondary-button" disabled={saving} formNoValidate name="intent" type="submit" value="draft">
                <Save aria-hidden="true" size={16} /> Save draft
              </button>
            )}
            <button className="primary-button" disabled={saving || problems.length > 0} name="intent" type="submit" value="submit">
              <Send aria-hidden="true" size={16} /> {allowDraft ? "Submit report" : (report ? "Save changes" : "Save report")} · {total} points
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
