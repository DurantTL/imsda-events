"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  FileCheck2,
  Printer,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import type { RankedAssignmentPreview } from "@/modules/program-assignments/domain";
import type {
  ProgramAssignmentDiagnostic,
  ProgramAssignmentWorkspaceField,
} from "@/modules/program-assignments/repository";

type AppliedRun = {
  id: string;
  formVersionId: string;
  formVersionNumber: number;
  formName: string;
  fieldId: string;
  fieldLabel: string;
  sourceFingerprint: string;
  clientRequestId: string;
  appliedByName: string;
  supersedesRunId: string | null;
  appliedAt: string;
  summary: RankedAssignmentPreview["summary"];
};

type ApiResult = {
  preview?: RankedAssignmentPreview;
  run?: AppliedRun;
  error?: string;
  message?: string;
};

function localDate(value: string) {
  return new Date(value).toLocaleString();
}

function fieldIdentity(field: ProgramAssignmentWorkspaceField) {
  return `${field.formVersionId}::${field.fieldId}`;
}

function assignedRankLabel(rank: number | null) {
  if (rank === 1) return "1st choice";
  if (rank === 2) return "2nd choice";
  if (rank) return `Choice ${rank}`;
  return "Unassigned";
}

export function ProgramAssignmentsWorkspace({
  eventId,
  eventName,
  fields,
  diagnostics,
  initialRuns,
}: {
  eventId: string;
  eventName: string;
  fields: ProgramAssignmentWorkspaceField[];
  diagnostics: ProgramAssignmentDiagnostic[];
  initialRuns: AppliedRun[];
}) {
  const router = useRouter();
  const formVersions = useMemo(() => {
    const seen = new Set<string>();
    return fields.filter((field) => {
      if (seen.has(field.formVersionId)) return false;
      seen.add(field.formVersionId);
      return true;
    });
  }, [fields]);
  const [selectedVersionId, setSelectedVersionId] = useState(
    formVersions[0]?.formVersionId ?? "",
  );
  const availableFields = fields.filter((field) => (
    field.formVersionId === selectedVersionId
  ));
  const [selectedFieldIdentity, setSelectedFieldIdentity] = useState(
    availableFields[0] ? fieldIdentity(availableFields[0]) : "",
  );
  const selectedField = fields.find((field) => (
    fieldIdentity(field) === selectedFieldIdentity
    && field.formVersionId === selectedVersionId
  )) ?? availableFields[0] ?? null;
  const [preview, setPreview] = useState<RankedAssignmentPreview | null>(null);
  const [runs, setRuns] = useState(initialRuns);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const applyRequestId = useRef("");

  function selectVersion(formVersionId: string) {
    const firstField = fields.find((field) => field.formVersionId === formVersionId);
    setSelectedVersionId(formVersionId);
    setSelectedFieldIdentity(firstField ? fieldIdentity(firstField) : "");
    setPreview(null);
    applyRequestId.current = "";
    setError("");
    setNotice("");
  }

  function selectField(identity: string) {
    setSelectedFieldIdentity(identity);
    setPreview(null);
    applyRequestId.current = "";
    setError("");
    setNotice("");
  }

  async function loadPreview() {
    if (!selectedField) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const search = new URLSearchParams({
        formVersionId: selectedField.formVersionId,
        fieldId: selectedField.fieldId,
      });
      const response = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/program-assignments?${search.toString()}`,
        { cache: "no-store" },
      );
      const result = await response.json() as ApiResult;
      if (!response.ok || !result.preview) {
        throw new Error(result.message ?? "The preview could not be loaded.");
      }
      setPreview(result.preview);
      applyRequestId.current = crypto.randomUUID();
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error ? caught.message : "The preview could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function applyPreview() {
    if (!preview || !selectedField) return;
    if (!applyRequestId.current) {
      applyRequestId.current = crypto.randomUUID();
    }
    setApplying(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/program-assignments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            formVersionId: preview.formVersionId,
            fieldId: preview.fieldId,
            previewFingerprint: preview.sourceFingerprint,
            clientRequestId: applyRequestId.current,
          }),
        },
      );
      const result = await response.json() as ApiResult;
      if (!response.ok || !result.run) {
        if (response.status === 409) {
          setPreview(null);
          applyRequestId.current = "";
        }
        throw new Error(result.message ?? "The assignments could not be applied.");
      }
      setRuns((current) => [
        result.run!,
        ...current.filter((run) => run.id !== result.run!.id),
      ]);
      setNotice(
        `Applied a frozen roster with ${result.run.summary.assigned} assigned and ${result.run.summary.unassigned} unassigned.`,
      );
      setPreview(null);
      applyRequestId.current = "";
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The assignments could not be applied.");
    } finally {
      setApplying(false);
    }
  }

  if (fields.length === 0) {
    return (
      <section className="page-stack program-assignments-workspace">
        <div className="page-intro">
          <div>
            <p className="eyebrow">Program planning</p>
            <h2>Seminar assignments</h2>
            <p>Turn attendee rankings into room rosters for {eventName}.</p>
          </div>
          <Link className="secondary-button" href={`/more?event=${encodeURIComponent(eventId)}`}>
            Back to More
          </Link>
        </div>
        <section className="panel assignment-empty">
          <span><UsersRound aria-hidden="true" size={24} /></span>
          <h3>No assignable ranked sessions yet</h3>
          <p>Publish a form with an attendee field set to <strong>Ranked choices</strong> and <strong>Collect interest, assign later</strong>. Then return here to preview room assignments.</p>
          <Link className="primary-button" href={`/registration-builder?event=${encodeURIComponent(eventId)}`}>
            Open registration form
          </Link>
        </section>
        {diagnostics.length > 0 && (
          <section className="panel assignment-diagnostics">
            <h3>Fields that need attention</h3>
            {diagnostics.map((diagnostic) => (
              <p key={`${diagnostic.formName}-${diagnostic.formVersionNumber}-${diagnostic.fieldLabel}`}>
                <strong>{diagnostic.fieldLabel}</strong> · {diagnostic.formName} v{diagnostic.formVersionNumber}<br />
                <span>{diagnostic.reason}</span>
              </p>
            ))}
          </section>
        )}
      </section>
    );
  }

  return (
    <section className="page-stack program-assignments-workspace">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Program planning</p>
          <h2>Seminar assignments</h2>
          <p>Preview the best fit from attendee rankings, check the result, and apply a frozen roster only when you are ready.</p>
        </div>
        <Link className="secondary-button" href={`/more?event=${encodeURIComponent(eventId)}`}>
          Back to More
        </Link>
      </div>

      <div className="assignment-safety-note">
        <Eye aria-hidden="true" size={19} />
        <p><strong>Preview is safe.</strong> It does not save, message people, reserve form choices, or change registrations. Apply creates a new historical roster; it never edits an older run.</p>
      </div>

      <section className="panel assignment-step">
        <div className="assignment-step-number">1</div>
        <div className="assignment-step-content">
          <div>
            <p className="eyebrow">Choose one session</p>
            <h3>What are you assigning?</h3>
            <p>Each published form version stays separate so its choices and limits cannot be mixed accidentally.</p>
          </div>
          <div className="assignment-select-grid">
            <label>
              Registration form
              <select
                value={selectedVersionId}
                onChange={(event) => selectVersion(event.target.value)}
              >
                {formVersions.map((field) => (
                  <option value={field.formVersionId} key={field.formVersionId}>
                    {field.formName} · version {field.formVersionNumber}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Ranked session
              <select
                value={selectedField ? fieldIdentity(selectedField) : ""}
                onChange={(event) => selectField(event.target.value)}
              >
                {availableFields.map((field) => (
                  <option value={fieldIdentity(field)} key={fieldIdentity(field)}>
                    {field.fieldLabel}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selectedField && (
            <div className="assignment-field-hint">
              <span>{selectedField.optionCount} choices</span>
              <span>{selectedField.limitedOptionCount} with room limits</span>
              <span>{selectedField.unlimitedOptionCount} unlimited because no limit is set</span>
            </div>
          )}
          <button
            className="primary-button"
            type="button"
            onClick={loadPreview}
            disabled={loading || !selectedField}
          >
            {loading
              ? <><RefreshCw aria-hidden="true" className="spin" size={16} /> Building preview…</>
              : <><Eye aria-hidden="true" size={16} /> Preview assignments</>}
          </button>
        </div>
      </section>

      {error && (
        <div className="assignment-feedback error" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <p><strong>Action needed</strong>{error}</p>
        </div>
      )}
      {notice && (
        <div className="assignment-feedback success" role="status">
          <CheckCircle2 aria-hidden="true" size={18} />
          <p><strong>Roster applied</strong>{notice}</p>
        </div>
      )}

      {preview && (
        <>
          <section className="panel assignment-step">
            <div className="assignment-step-number">2</div>
            <div className="assignment-step-content">
              <div className="assignment-preview-heading">
                <div>
                  <p className="eyebrow">Nothing saved yet</p>
                  <h3>Review the preview</h3>
                  <p>Built from submitted and confirmed registrations for this exact published form version.</p>
                </div>
                <span className="review-badge">Preview only</span>
              </div>
              <div className="assignment-summary-grid">
                <article><strong>{preview.summary.assigned}</strong><span>assigned</span></article>
                <article><strong>{preview.summary.firstChoiceAssigned}</strong><span>1st choice</span></article>
                <article><strong>{preview.summary.secondChoiceAssigned}</strong><span>2nd choice</span></article>
                <article><strong>{preview.summary.lowerChoiceAssigned}</strong><span>lower choice</span></article>
                <article className={preview.summary.unassigned > 0 ? "warning" : ""}><strong>{preview.summary.unassigned}</strong><span>unassigned</span></article>
              </div>

              {preview.summary.unlimitedOptions > 0 && (
                <div className="assignment-capacity-warning">
                  <AlertTriangle aria-hidden="true" size={18} />
                  <p><strong>{preview.summary.unlimitedOptions} {preview.summary.unlimitedOptions === 1 ? "choice has" : "choices have"} no room limit.</strong> Missing limits are treated as unlimited. Add limits in a new form version if these rooms are not unlimited.</p>
                </div>
              )}

              <div className="report-table-wrap">
                <table className="report-table assignment-capacity-table">
                  <caption className="sr-only">Capacity and assignment results</caption>
                  <thead>
                    <tr>
                      <th scope="col">Room / choice</th>
                      <th scope="col">Limit</th>
                      <th scope="col">Interest</th>
                      <th scope="col">Assigned</th>
                      <th scope="col">1st</th>
                      <th scope="col">2nd</th>
                      <th scope="col">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.choices.map((choice) => (
                      <tr key={choice.option}>
                        <th scope="row">{choice.option}</th>
                        <td>{choice.capacity ?? "Unlimited*"}</td>
                        <td>{choice.demand}</td>
                        <td><strong>{choice.assigned}</strong></td>
                        <td>{choice.firstChoiceAssigned}</td>
                        <td>{choice.secondChoiceAssigned}</td>
                        <td>{choice.remaining ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <details className="assignment-detail" open={preview.summary.unassigned > 0}>
                <summary>Review attendee results ({preview.assignments.length})</summary>
                <div className="report-table-wrap">
                  <table className="report-table">
                    <caption className="sr-only">Previewed attendee assignments</caption>
                    <thead>
                      <tr><th scope="col">Attendee</th><th scope="col">Assignment</th><th scope="col">Result</th><th scope="col">Registration</th></tr>
                    </thead>
                    <tbody>
                      {preview.assignments.map((assignment) => (
                        <tr key={assignment.attendeeId}>
                          <th scope="row">{assignment.lastName}, {assignment.firstName}</th>
                          <td>{assignment.assignedOption ?? "Unassigned"}</td>
                          <td>{assignment.unassignedReason === "NO_RANKED_CHOICES"
                            ? "No ranking submitted"
                            : assignment.unassignedReason === "CAPACITY_FULL"
                              ? "No ranked room available"
                              : assignedRankLabel(assignment.preferenceRank)}</td>
                          <td>{assignment.confirmationCode}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          </section>

          <section className="panel assignment-step assignment-apply-step">
            <div className="assignment-step-number">3</div>
            <div className="assignment-step-content">
              <div>
                <p className="eyebrow">Explicit save</p>
                <h3>Apply this roster</h3>
                <p>This freezes the preview as a new historical run. If registrations or limits changed, apply stops and asks you to preview again.</p>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={applyPreview}
                disabled={applying || preview.summary.attendees === 0}
              >
                {applying
                  ? <><RefreshCw aria-hidden="true" className="spin" size={16} /> Applying…</>
                  : <><FileCheck2 aria-hidden="true" size={16} /> Apply reviewed assignments</>}
              </button>
              {preview.summary.attendees === 0 && (
                <p className="quiet-copy">There are no submitted or confirmed attendees from this form version to assign.</p>
              )}
            </div>
          </section>
        </>
      )}

      <section className="panel assignment-history">
        <div className="section-heading">
          <div><p className="eyebrow">Immutable history</p><h2>Applied rosters</h2><p>Every apply creates a new run. Earlier rosters remain available for comparison and records.</p></div>
          <span className="count-badge">{runs.length} runs</span>
        </div>
        {runs.length === 0
          ? <p className="report-empty">No roster has been applied yet. Previewing does not add anything here.</p>
          : <div className="assignment-run-list">
              {runs.map((run, index) => (
                <article key={run.id}>
                  <div className="assignment-run-main">
                    <span className="assignment-run-icon"><FileCheck2 aria-hidden="true" size={18} /></span>
                    <div>
                      <h3>{run.fieldLabel}</h3>
                      <p>{run.formName} · version {run.formVersionNumber} · {localDate(run.appliedAt)}</p>
                      <small>{run.summary.assigned} assigned · {run.summary.firstChoiceAssigned} first choice · {run.summary.secondChoiceAssigned} second choice · {run.summary.unassigned} unassigned · by {run.appliedByName}</small>
                    </div>
                  </div>
                  <div className="assignment-run-actions">
                    {index === 0 && <span className="review-badge">Newest</span>}
                    <a
                      className="secondary-button"
                      href={`/api/events/${encodeURIComponent(eventId)}/program-assignments/${encodeURIComponent(run.id)}/roster`}
                    >
                      <Download aria-hidden="true" size={15} /> CSV
                    </a>
                    <Link
                      className="secondary-button"
                      href={`/more/program-assignments/${encodeURIComponent(run.id)}?event=${encodeURIComponent(eventId)}`}
                    >
                      <Printer aria-hidden="true" size={15} /> Print
                    </Link>
                  </div>
                </article>
              ))}
            </div>}
      </section>

      {diagnostics.length > 0 && (
        <details className="panel assignment-diagnostics">
          <summary>Fields not available for attendee assignment ({diagnostics.length})</summary>
          {diagnostics.map((diagnostic) => (
            <p key={`${diagnostic.formName}-${diagnostic.formVersionNumber}-${diagnostic.fieldLabel}`}>
              <strong>{diagnostic.fieldLabel}</strong> · {diagnostic.formName} v{diagnostic.formVersionNumber}<br />
              <span>{diagnostic.reason}</span>
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
