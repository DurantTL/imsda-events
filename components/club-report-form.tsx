"use client";

import { useMemo, useState } from "react";
import { CircleAlert, Save } from "lucide-react";
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

type Prefill = { meetingPlace: string; meetingSchedule: string; pathfinderCount: number; tltCount: number; staffCount: number };
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

/**
 * The monthly report (#377). Every item is picked from the values the old
 * form offered, except on time, which the server works out. The total is
 * shown live and anything the rules refuse is flagged before saving.
 */
export function ClubReportForm({
  endpoint,
  monthLabel,
  dueLabel,
  initial,
  prefill,
  expectedOnTime,
  readOnly,
  variant = "account",
}: {
  endpoint: string;
  monthLabel: string;
  dueLabel: string;
  initial: ClubReportRecord | null;
  prefill: Prefill;
  /** On-time points this report will get: fixed once submitted, otherwise whether today is by the due date. */
  expectedOnTime: number;
  readOnly: boolean;
  variant?: "account" | "staff";
}) {
  const [report, setReport] = useState(initial);
  const [points, setPoints] = useState<PickedPoints>(initial?.points ?? {});
  const [classLevels, setClassLevels] = useState<ClubClassLevel[]>(initial?.classLevels ?? []);
  const [honors, setHonors] = useState<ReportHonor[]>(() => {
    const list = [...(initial?.honors ?? [])];
    while (list.length < MAX_HONORS) list.push({ name: "", participants: null });
    return list;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const onTime = report?.onTimePoints ?? expectedOnTime;
  const total = onTime + pickedTotal(points);
  const problems = useMemo(() => reportProblems({ points, honors, classLevels }), [points, honors, classLevels]);
  const problemFor = (key: PointItemKey | "honorsList") => problems.find((problem) => problem.key === key)?.message;
  const unanswered = pointItems.filter((item) => points[item.key] === undefined).length;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problems.length > 0) {
      setError("Fix the items marked below before saving.");
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
        }),
      });
      const result = await response.json().catch(() => ({})) as SaveResponse;
      if (!response.ok || !result.report) throw new Error(result.message ?? result.issues?.[0]?.message ?? "The report could not be saved.");
      setReport(result.report);
      setNotice(`Saved. ${result.report.totalPoints} points for ${monthLabel}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The report could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const card = variant === "account" ? "public-manage-card" : "panel";
  const eyebrow = variant === "account" ? "public-registration-eyebrow" : "eyebrow";

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
        {report && <span className="status-chip green">Submitted</span>}
      </div>

      {readOnly && (
        <div className="inline-notice" role="status">This report closed after {dueLabel}. Ask the conference office if something needs to change.</div>
      )}
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <fieldset className={`${card} form-stack`} disabled={readOnly || saving}>
        <legend className={eyebrow}>Club facts</legend>
        <div className="form-grid two-column">
          <label>Meeting place<input defaultValue={report?.meetingPlace ?? prefill.meetingPlace} maxLength={200} name="meetingPlace" /></label>
          <label>Meeting day and time<input defaultValue={report?.meetingSchedule ?? prefill.meetingSchedule} maxLength={120} name="meetingSchedule" /></label>
          <label>Average attendance<input defaultValue={report?.averageAttendance ?? ""} inputMode="numeric" max={999} min={0} name="averageAttendance" type="number" /></label>
          <label>Number of Pathfinders<input defaultValue={report?.pathfinderCount ?? prefill.pathfinderCount} inputMode="numeric" max={999} min={0} name="pathfinderCount" type="number" /></label>
          <label>Number of TLTs<input defaultValue={report?.tltCount ?? prefill.tltCount} inputMode="numeric" max={999} min={0} name="tltCount" type="number" /></label>
          <label>Number of staff<input defaultValue={report?.staffCount ?? prefill.staffCount} inputMode="numeric" max={999} min={0} name="staffCount" type="number" /></label>
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
          <div>
            <button className="primary-button" disabled={saving || problems.length > 0} type="submit">
              <Save aria-hidden="true" size={16} /> {report ? "Save changes" : "Save report"} · {total} points
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
