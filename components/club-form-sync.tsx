"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";

type SyncResult = { key: string; name: string; status: "UPDATED" | "CREATED" | "SKIPPED" | "UNCHANGED" | "REFUSED"; detail: string };
type SyncReport = { results: SyncResult[]; counts: { updated: number; created: number; skipped: number; unchanged: number; refused: number } };

const statusLabel: Record<SyncResult["status"], string> = {
  UPDATED: "UPDATED",
  CREATED: "UPDATED",
  SKIPPED: "SKIPPED",
  UNCHANGED: "Unchanged",
  REFUSED: "REFUSED",
};

/**
 * "Sync templates" (#742): runs the same sync as `npm run club-forms:sync`
 * and shows what happened to each template. System administrators only (the
 * route checks again). Re-sealing a large form can take a while, so the
 * button stays busy and announces progress until the server answers.
 */
export function ClubFormSync({ pendingCount }: { pendingCount: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<SyncReport | null>(null);

  async function run() {
    setRunning(true);
    setError("");
    try {
      const response = await fetch("/api/admin/club-forms/sync", { method: "POST" });
      const result = await response.json().catch(() => ({})) as Partial<SyncReport> & { message?: string };
      if (!response.ok || !result.results || !result.counts) {
        setError(result.message ?? "Templates could not be synced. Nothing was lost; try again.");
        return;
      }
      setReport(result as SyncReport);
      router.refresh();
    } catch {
      setError("Templates could not be synced. Check your connection and try again.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-labelledby="club-form-sync-heading" className="panel form-stack club-form-sync">
      <h3 id="club-form-sync-heading">Sync templates</h3>
      <p className="field-help">
        Brings each built-in form up to the version in the code, the same step as <code>npm run club-forms:sync</code>.
        A form edited in the app is skipped, and a change that would make an answer less protected is refused. {pendingCount > 0
          ? `${pendingCount} form${pendingCount === 1 ? " is" : "s are"} waiting for a sync.`
          : "Every built-in form is up to date."}
      </p>
      <div>
        <button className="primary-button" disabled={running} onClick={run} type="button">
          {running ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : <RefreshCw aria-hidden="true" size={14} />}{" "}
          {running ? "Syncing templates..." : "Sync templates"}
        </button>
      </div>
      <div aria-live="polite" role="status">
        {running && <p className="quiet-copy">Syncing. A form with many answers can take a minute. Please keep this page open.</p>}
      </div>
      {error && (
        <div className="inline-notice error" role="alert">
          {error}{" "}
          <button className="secondary-button" disabled={running} onClick={run} type="button">Retry</button>
        </div>
      )}
      {report && !running && (
        <div className="club-form-sync-results">
          <p>
            <strong>
              {report.counts.updated + report.counts.created} updated, {report.counts.skipped} skipped, {report.counts.unchanged} unchanged
              {report.counts.refused > 0 ? `, ${report.counts.refused} refused` : ""}.
            </strong>
          </p>
          <ul className="clone-plain-list">
            {report.results.map((item) => (
              <li key={item.key}>
                <strong>{statusLabel[item.status]}</strong> {item.name}: {item.detail}
              </li>
            ))}
          </ul>
          {report.counts.refused > 0 && (
            <div className="inline-notice error" role="alert">
              {report.counts.refused} form{report.counts.refused === 1 ? " was" : "s were"} not synced and need a reviewed change. <button className="secondary-button" disabled={running} onClick={run} type="button">Retry</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
