"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { RefreshCcw, Search, Undo2, UserCheck, UserX } from "lucide-react";

type ReviewCandidate = { personId: string; name: string; sites: string[] };
type ReviewItem = { id: string; entryId: string; name: string; site: string | null; reason: string; candidates: ReviewCandidate[] };
type ManualMatch = { id: string; personId: string; personName: string; entryName: string; site: string | null };
type NameOnlyMatch = { id: string; personId: string; personName: string; personSites: string[]; entryName: string; site: string | null };
type LookupResult = {
  query: string;
  hasList: boolean;
  rows: Array<{ id: string; name: string; site: string | null; status: string }>;
  people: Array<{ personId: string; name: string; sites: string[]; status: string }>;
  pairs: Array<{ entryId: string; personId: string; rowName: string; personName: string; reason: string }>;
  rejected: Array<{ entryId: string; personId: string; rowName: string; personName: string }>;
  truncated: boolean;
};
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
  const [nameOnlyMatches, setNameOnlyMatches] = useState<NameOnlyMatch[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lookupName, setLookupName] = useState("");
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [reviewsResponse, unmatchedResponse, manualResponse, nameOnlyResponse] = await Promise.all([
        fetch("/api/admin/background-checks/reviews"),
        fetch("/api/admin/background-checks/unmatched"),
        fetch("/api/admin/background-checks/manual-matches"),
        fetch("/api/admin/background-checks/name-only-matches"),
      ]);
      const reviewsResult = await reviewsResponse.json().catch(() => ({}));
      const unmatchedResult = await unmatchedResponse.json().catch(() => ({}));
      const manualResult = await manualResponse.json().catch(() => ({}));
      const nameOnlyResult = await nameOnlyResponse.json().catch(() => ({}));
      if (!reviewsResponse.ok || !unmatchedResponse.ok || !manualResponse.ok || !nameOnlyResponse.ok) throw new Error("Couldn't load the review list.");
      setReviews(reviewsResult.reviews ?? []);
      setUnmatched(unmatchedResult.entries ?? []);
      setManualMatches(manualResult.matches ?? []);
      setNameOnlyMatches(nameOnlyResult.matches ?? []);
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

  /** Re-runs matching for the whole list under the current rules (no new upload), then reloads. */
  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch("/api/admin/background-checks/rematch", { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message ?? "The list couldn't be re-matched.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The list couldn't be re-matched.");
    } finally {
      setRefreshing(false);
    }
  }

  async function notTheSamePerson(matchId: string) {
    setBusyId(matchId);
    setError("");
    try {
      const response = await fetch(`/api/admin/background-checks/name-only-matches/${encodeURIComponent(matchId)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message ?? "That match couldn't be undone.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That match couldn't be undone.");
    } finally {
      setBusyId(null);
    }
  }

  /** "Match them anyway": a staff match of a person staff earlier rejected for the row; clears the rejection. */
  async function matchAnyway(entryId: string, personId: string) {
    const busyKey = `${entryId}:${personId}`;
    setBusyId(busyKey);
    setError("");
    try {
      const response = await fetch("/api/admin/background-checks/rejected-matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId, personId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message ?? "That match couldn't be saved.");
      await load();
      if (lookupName.trim()) {
        const again = await fetch(`/api/admin/background-checks/lookup?name=${encodeURIComponent(lookupName.trim())}`);
        const next = await again.json().catch(() => ({}));
        if (again.ok) setLookup(next.lookup ?? null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That match couldn't be saved.");
    } finally {
      setBusyId(null);
    }
  }

  async function runLookup(event: FormEvent) {
    event.preventDefault();
    if (!lookupName.trim()) return;
    setLookingUp(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/background-checks/lookup?name=${encodeURIComponent(lookupName.trim())}`);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message ?? "That name couldn't be looked up.");
      setLookup(result.lookup ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That name couldn't be looked up.");
    } finally {
      setLookingUp(false);
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

  if (reviews === null && unmatched === null && manualMatches === null && nameOnlyMatches === null && !error) return null;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Background checks</p>
          <h2>Needs a look</h2>
          <p>Rows an upload couldn&apos;t match with confidence, waiting on a staff decision. Nothing is guessed.</p>
        </div>
        <button className="secondary-button" disabled={refreshing} onClick={() => void refresh()} type="button"><RefreshCcw aria-hidden="true" size={14} /> {refreshing ? "Re-matching…" : "Refresh"}</button>
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

      <h3>Matched by name, new since the last upload ({nameOnlyMatches?.length ?? 0})</h3>
      <p className="quiet-copy">These were matched by name. No action needed unless one is wrong. Each already counts, and it is remembered for the next upload, so it won&apos;t be listed again. &quot;Not the same person&quot; puts the row back to unmatched, and that person is never offered for that row again, even after a new upload (you can still match them by hand).</p>
      {nameOnlyMatches && nameOnlyMatches.length === 0 && <p className="report-empty">No new matches by name since the last upload.</p>}
      {nameOnlyMatches && nameOnlyMatches.length > 0 && (
        <div className="report-table-wrap">
          <table className="report-table">
            <caption className="sr-only">Background check rows matched on the name alone</caption>
            <thead><tr><th>Row</th><th>Row&apos;s site</th><th>Matched to</th><th>Their club or church</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {nameOnlyMatches.map((match) => (
                <tr key={match.id}>
                  <td translate="no">{match.entryName || "—"}</td>
                  <td>{match.site || "—"}</td>
                  <td translate="no">{match.personName || "—"}</td>
                  <td>{match.personSites.length > 0 ? match.personSites.join(", ") : "no club or church on file"}</td>
                  <td>
                    <button className="text-button" disabled={busyId === match.id} onClick={() => void notTheSamePerson(match.id)} type="button">
                      <UserX aria-hidden="true" size={14} /> Not the same person
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

      <h3>Why isn&apos;t this person matched?</h3>
      <form onSubmit={(event) => void runLookup(event)}>
        <label>
          <span className="sr-only">Name to look up</span>
          <input
            autoComplete="off"
            maxLength={100}
            onChange={(event) => setLookupName(event.target.value)}
            placeholder="First and last name, or just a last name"
            type="search"
            value={lookupName}
          />
        </label>{" "}
        <button className="secondary-button" disabled={lookingUp || !lookupName.trim()} type="submit"><Search aria-hidden="true" size={14} /> {lookingUp ? "Looking…" : "Look up"}</button>
      </form>
      {lookup && !lookup.hasList && <p className="report-empty">No list has been uploaded yet.</p>}
      {lookup && lookup.hasList && lookup.rows.length === 0 && lookup.people.length === 0 && <p className="report-empty">No list row or roster or registration person has that name or a similar one.</p>}
      {lookup && (lookup.rows.length > 0 || lookup.people.length > 0) && (
        <div className="background-check-lookup">
          <h4>List rows ({lookup.rows.length})</h4>
          {lookup.rows.length === 0 ? <p className="report-empty">No row on the list has that name or a similar one.</p> : (
            <div className="report-table-wrap">
              <table className="report-table">
                <caption className="sr-only">List rows with the same or a similar name</caption>
                <thead><tr><th>Row</th><th>Site</th><th>Status</th></tr></thead>
                <tbody>
                  {lookup.rows.map((row) => (
                    <tr key={row.id}><td translate="no">{row.name}</td><td>{row.site || "—"}</td><td>{row.status}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h4>Roster and registration people ({lookup.people.length})</h4>
          {lookup.people.length === 0 ? <p className="report-empty">No one on file has that name or a similar one.</p> : (
            <div className="report-table-wrap">
              <table className="report-table">
                <caption className="sr-only">People with the same or a similar name</caption>
                <thead><tr><th>Person</th><th>Club or church</th><th>Status</th></tr></thead>
                <tbody>
                  {lookup.people.map((person) => (
                    <tr key={person.personId}>
                      <td translate="no">{person.name}</td>
                      <td>{person.sites.length > 0 ? person.sites.join(", ") : "—"}</td>
                      <td>{person.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h4>Row and person pairs ({lookup.pairs.length})</h4>
          {lookup.pairs.length === 0 ? <p className="report-empty">No row and person share a last name and a similar first name.</p> : (
            <div className="report-table-wrap">
              <table className="report-table">
                <caption className="sr-only">Why each row and person did or didn&apos;t match</caption>
                <thead><tr><th>Row</th><th>Person</th><th>Why</th></tr></thead>
                <tbody>
                  {lookup.pairs.map((pair) => (
                    <tr key={`${pair.entryId}:${pair.personId}`}>
                      <td translate="no">{pair.rowName}</td>
                      <td translate="no">{pair.personName}</td>
                      <td>{pair.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(lookup.rejected ?? []).length > 0 && (
            <>
              <h4>Marked &quot;not the same person&quot; ({lookup.rejected.length})</h4>
              <ul className="background-check-candidates">
                {lookup.rejected.map((item) => (
                  <li key={`${item.entryId}:${item.personId}`}>
                    <span translate="no">{item.rowName}</span> is not <span translate="no">{item.personName}</span>{" "}
                    <button className="text-button" disabled={busyId === `${item.entryId}:${item.personId}`} onClick={() => void matchAnyway(item.entryId, item.personId)} type="button">
                      <UserCheck aria-hidden="true" size={14} /> Match them anyway
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {lookup.truncated && <p className="quiet-copy">Only the first {lookup.rows.length} rows and {lookup.people.length} people are shown. Type a first name to narrow it down.</p>}
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
