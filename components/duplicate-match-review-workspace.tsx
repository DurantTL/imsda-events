"use client";

import { useState } from "react";
import {
  Clock,
  Mail,
  Merge,
  Phone,
  RefreshCw,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { PersonMatchCandidateRecord } from "@/modules/people/duplicate-match-repository";

const signalLabels: Record<string, string> = {
  EMAIL_MATCH: "Same email address",
  PHONE_MATCH: "Same phone number",
  SAME_SURNAME: "Same last name",
  SAME_FULL_NAME: "Same first and last name",
  HOUSEHOLD_SHARED: "Share a household",
  EXTERNAL_IDENTITY_SHARED: "Same external system identity",
  EMAIL_MISMATCH: "Different email addresses",
  PHONE_MISMATCH: "Different phone numbers",
};

function signalLabel(signal: string) {
  return signalLabels[signal] ?? signal;
}

function personLine(person: PersonMatchCandidateRecord["personA"]) {
  return `${person.firstName} ${person.lastName}`;
}

function ConfidenceChip({ confidence }: { confidence: string }) {
  const className = confidence === "HIGH" ? "gold" : confidence === "MEDIUM" ? "purple" : "";
  return <span className={`status-chip ${className}`}>{confidence === "HIGH" ? "High confidence" : confidence === "MEDIUM" ? "Medium confidence" : "Low confidence"}</span>;
}

type CandidatesResponse = {
  candidates?: PersonMatchCandidateRecord[];
  candidate?: PersonMatchCandidateRecord;
  result?: { created: number; superseded: number; unchanged: number; evaluated: number };
  message?: string;
  issues?: Array<{ message?: string }>;
};

export function DuplicateMatchReviewWorkspace({
  initialCandidates,
}: {
  initialCandidates: PersonMatchCandidateRecord[];
}) {
  const [candidates, setCandidates] = useState(initialCandidates);
  const [busyId, setBusyId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dismissing, setDismissing] = useState<PersonMatchCandidateRecord | null>(null);
  const [reason, setReason] = useState("");
  const dialogRef = useAccessibleDialog<HTMLElement>(Boolean(dismissing), closeDismiss);

  function closeDismiss() {
    if (busyId) return;
    setDismissing(null);
    setReason("");
  }

  async function readResponse(response: Response) {
    const result = await response.json().catch(() => ({})) as CandidatesResponse;
    if (!response.ok) {
      throw new Error(result.message ?? result.issues?.[0]?.message ?? "That request could not be completed.");
    }
    return result;
  }

  async function runGeneration() {
    setGenerating(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/people/matches", { method: "POST" });
      const result = await readResponse(response);
      setCandidates(result.candidates ?? []);
      setNotice(
        result.result
          ? `Scan complete: ${result.result.created} new or updated candidate${result.result.created === 1 ? "" : "s"}, ${result.result.unchanged} unchanged.`
          : "Scan complete.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That scan could not be completed.");
    } finally {
      setGenerating(false);
    }
  }

  async function defer(candidate: PersonMatchCandidateRecord) {
    setBusyId(candidate.id);
    setError("");
    setNotice("");
    try {
      await fetch(`/api/people/matches/${candidate.id}/defer`, { method: "POST" });
      setNotice(`Deferred ${personLine(candidate.personA)} / ${personLine(candidate.personB)} — it stays in the queue for later review.`);
    } catch {
      setError("That candidate could not be deferred.");
    } finally {
      setBusyId("");
    }
  }

  async function submitDismiss(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dismissing) return;
    setBusyId(dismissing.id);
    setError("");
    try {
      const response = await fetch(`/api/people/matches/${dismissing.id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      await readResponse(response);
      setCandidates((current) => current.filter((candidate) => candidate.id !== dismissing.id));
      setNotice(`Dismissed ${personLine(dismissing.personA)} / ${personLine(dismissing.personB)}.`);
      setDismissing(null);
      setReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That candidate could not be dismissed.");
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Identity</p>
          <h2>Possible duplicate people</h2>
          <p>
            People who may be the same person, based on rule-based evidence — never applied
            automatically. Review the evidence for each pair, then dismiss it, defer it for later,
            or (once merging ships) merge the records.
          </p>
        </div>
        <div className="intro-actions">
          <button className="secondary-button" type="button" onClick={runGeneration} disabled={generating}>
            <RefreshCw aria-hidden="true" size={15} /> {generating ? "Scanning…" : "Scan for new candidates"}
          </button>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="inline-notice" role="status">{notice}</p>}

      {candidates.length === 0 ? (
        <section className="panel empty-state">
          <ShieldCheck aria-hidden="true" size={24} />
          <h3>Nothing open for review</h3>
          <p>Run a scan to look for shared emails, phone numbers, household and surname overlaps, or shared external identities.</p>
        </section>
      ) : (
        <section className="panel duplicate-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Open candidates</p>
              <h2>{candidates.length} pair{candidates.length === 1 ? "" : "s"} to review</h2>
            </div>
          </div>
          {candidates.map((candidate) => (
            <article className="duplicate-group" key={candidate.id}>
              <header>
                <ConfidenceChip confidence={candidate.confidence} />
                <strong>{personLine(candidate.personA)} &amp; {personLine(candidate.personB)}</strong>
                <small>Rule version {candidate.ruleVersion} · computed {new Date(candidate.computedAt).toLocaleString()}</small>
              </header>

              <ul className="duplicate-member-list">
                {[candidate.personA, candidate.personB].map((person) => (
                  <li key={person.id}>
                    <span>
                      <strong>{personLine(person)}</strong>
                      <small className="duplicate-contact">
                        {person.normalizedEmail && <span><Mail aria-hidden="true" size={12} /> {person.normalizedEmail}</span>}
                        {person.phone && <span><Phone aria-hidden="true" size={12} /> {person.phone}</span>}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>

              <div className="quiet-copy">
                <strong>Matched:</strong>{" "}
                {candidate.matchedSignals.length > 0
                  ? candidate.matchedSignals.map(signalLabel).join(" · ")
                  : "—"}
                {candidate.contradictingSignals.length > 0 && (
                  <>
                    <br /><strong>Contradicting:</strong>{" "}
                    {candidate.contradictingSignals.map(signalLabel).join(" · ")}
                  </>
                )}
              </div>

              <div className="form-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busyId === candidate.id}
                  onClick={() => { setDismissing(candidate); setReason(""); }}
                >
                  <X aria-hidden="true" size={15} /> Dismiss
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busyId === candidate.id}
                  onClick={() => defer(candidate)}
                >
                  <Clock aria-hidden="true" size={15} /> Defer
                </button>
                <button className="secondary-button" type="button" disabled title="Merging is not built yet (#127) — this button is a placeholder.">
                  <Merge aria-hidden="true" size={15} /> Merge (coming soon)
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {dismissing && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyId) closeDismiss(); }}>
          <section className="modal-card" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="dismiss-match-title" tabIndex={-1}>
            <div className="modal-head">
              <div>
                <p className="eyebrow">Not the same person</p>
                <h2 id="dismiss-match-title">Dismiss this candidate</h2>
              </div>
              <button className="icon-button" type="button" aria-label="Close dialog" onClick={closeDismiss}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <p className="confirm-copy">
              {personLine(dismissing.personA)} and {personLine(dismissing.personB)} will be marked as reviewed
              and not the same person. This pair will not reappear unless something about their
              records changes.
            </p>
            <form className="form-stack" onSubmit={submitDismiss}>
              <label>
                Reason <small>Required, at least five characters</small>
                <textarea
                  name="reason"
                  rows={3}
                  required
                  minLength={5}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className="form-actions">
                <button className="secondary-button" type="button" onClick={closeDismiss} disabled={Boolean(busyId)}>
                  Cancel
                </button>
                <button className="primary-button" type="submit" disabled={Boolean(busyId) || reason.trim().length < 5}>
                  {busyId ? "Dismissing…" : "Dismiss candidate"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      <section className="boundary-callout">
        <UsersRound aria-hidden="true" size={20} />
        <span>
          <strong>Evidence, not action</strong>
          <small>
            Nothing here merges records at any confidence. This queue shows only the names,
            contact fields, and matched signals needed to decide whether two people are the same
            — not registrations, payments, medical, or consent records.
          </small>
        </span>
      </section>
    </section>
  );
}
