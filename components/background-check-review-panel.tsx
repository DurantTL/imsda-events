"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCcw, Undo2, UserCheck, UserX } from "lucide-react";

type ReviewCandidate = { personId: string; name: string; sites: string[] };
type ReviewItem = { id: string; entryId: string; name: string; site: string | null; reason: string; candidates: ReviewCandidate[] };
type ManualMatch = { id: string; personId: string; personName: string; entryName: string; site: string | null };
type UnmatchedEntry = { id: string; name: string; site: string | null; complianceStatus: string | null; checkedOn: string | null; expiresOn: string | null };

/**
 * Staff review for the background-check list (#527): entries or people an
 * upload couldn't match with confidence, and entries that match no one yet.
 * Nothing here is guessed — staff pick a candidate by hand, or say none of
 * them is right. A pick is a staff decision: it holds across refreshes and
 * uploads, even if the names differ, until staff undo it here.
 */
export function BackgroundCheckReviewPanel() {
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null);
  const [unmatched, setUnmatched] = useState<UnmatchedEntry[] | null>(null);
  const [manualMatches, setManualMatches] = useState<ManualMatch[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [reviewsResponse, unmatchedResponse, manualResponse] = await Promise.all([
        fetch("/api/admin/background-checks/reviews"),
        fetch("/api/admin/background-checks/unmatched"),
        fetch("/api/admin/background-checks/manual-matches"),
      ]);
      const reviewsResult = await reviewsResponse.json().catch(() => ({}));
      const unmatchedResult = await unmatchedResponse.json().catch(() => ({}));
      const manualResult = await manualResponse.json().catch(() => ({}));
      if (!reviewsResponse.ok || !unmatchedResponse.ok || !manualResponse.ok) throw new Error("Couldn't load the review list.");
      setReviews(reviewsResult.reviews ?? []);
      setUnmatched(unmatchedResult.entries ?? []);
      setManualMatches(manualResult.matches ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't load the review list.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function resolve(reviewId: string, decision: { type: "match"; personId: string } | { type: "dismiss" }) {
    setBusyId(reviewId);
    setError("");
    try {
      const response = await fetch(`/api/admin/background-checks/reviews/${encodeURIComponent(reviewId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message ?? "That decision couldn't be saved.");
      setReviews(result.reviews ?? []);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That decision couldn't be saved.");
    } finally {
      setBusyId(null);
    }
  }

  async function undo(matchId: string) {
    setBusyId(matchId);
    setError("");
    try {
      const response = await fetch(`/api/admin/background-checks/manual-matches/${encodeURIComponent(matchId)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message ?? "That match couldn't be undone.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That match couldn't be undone.");
    } finally {
      setBusyId(null);
    }
  }

  if (reviews === null && unmatched === null && manualMatches === null && !error) return null;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Background checks</p>
          <h2>Needs a look</h2>
          <p>Rows an upload couldn&apos;t match with confidence, waiting on a staff decision. Nothing is guessed.</p>
        </div>
        <button className="secondary-button" onClick={() => void load()} type="button"><RefreshCcw aria-hidden="true" size={14} /> Refresh</button>
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <h3>To review ({reviews?.length ?? 0})</h3>
      {reviews && reviews.length === 0 && <p className="report-empty">Nothing waiting on a decision.</p>}
      {reviews && reviews.length > 0 && (
        <div className="report-table-wrap">
          <table className="report-table">
            <caption className="sr-only">Background checks needing review</caption>
            <thead><tr><th>Row</th><th>Site</th><th>Why</th><th>Candidates</th></tr></thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.id}>
                  <td translate="no">{review.name || "—"}</td>
                  <td>{review.site || "—"}</td>
                  <td>{review.reason}</td>
                  <td>
                    <ul className="background-check-candidates">
                      {review.candidates.map((candidate) => (
                        <li key={candidate.personId}>
                          <span translate="no">{candidate.name}</span>
                          <small className="quiet-copy"> {candidate.sites.length > 0 ? candidate.sites.join(", ") : "no club or church on file"}</small>{" "}
                          <button
                            className="text-button"
                            disabled={busyId === review.id}
                            onClick={() => void resolve(review.id, { type: "match", personId: candidate.personId })}
                            type="button"
                          >
                            <UserCheck aria-hidden="true" size={14} /> Match
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button className="text-button" disabled={busyId === review.id} onClick={() => void resolve(review.id, { type: "dismiss" })} type="button">
                      <UserX aria-hidden="true" size={14} /> None of these
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Matched by hand ({manualMatches?.length ?? 0})</h3>
      {manualMatches && manualMatches.length === 0 && <p className="report-empty">No rows are matched by hand.</p>}
      {manualMatches && manualMatches.length > 0 && (
        <div className="report-table-wrap">
          <table className="report-table">
            <caption className="sr-only">Background check rows matched to a person by hand</caption>
            <thead><tr><th>Row</th><th>Site</th><th>Matched to</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {manualMatches.map((match) => (
                <tr key={match.id}>
                  <td translate="no">{match.entryName || "—"}</td>
                  <td>{match.site || "—"}</td>
                  <td translate="no">{match.personName || "—"}</td>
                  <td>
                    <button className="text-button" disabled={busyId === match.id} onClick={() => void undo(match.id)} type="button">
                      <Undo2 aria-hidden="true" size={14} /> Undo match
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="background-check-unmatched">
        <summary><strong>Not on a club roster or registration yet ({unmatched?.length ?? 0})</strong></summary>
        <p className="quiet-copy">Most volunteers on the conference-wide list aren&apos;t on any club roster. This isn&apos;t work to do; they match once they appear on a roster or registration.</p>
      {unmatched && unmatched.length === 0 && <p className="report-empty">Everyone on the list is matched to someone.</p>}
      {unmatched && unmatched.length > 0 && (
        <div className="report-table-wrap">
          <table className="report-table">
            <caption className="sr-only">Background check list entries not matched to anyone</caption>
            <thead><tr><th>Name</th><th>Site</th></tr></thead>
            <tbody>
              {unmatched.map((entry) => (
                <tr key={entry.id}>
                  <td translate="no">{entry.name || "—"}</td>
                  <td>{entry.site || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </details>
    </section>
  );
}
