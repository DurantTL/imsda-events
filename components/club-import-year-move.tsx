"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft } from "lucide-react";
import { MOVE_IMPORT_ACTION } from "@/modules/club-imports/domain";
import { conflictLabel, type ImportYearMovePreview } from "@/modules/club-imports/move-year-domain";

type ClubImportSummary = { clubYear: string; entryId: string; peopleOnRoster: number };
type MoveResponse = { preview?: ImportYearMovePreview; moved?: ImportYearMovePreview & { rowsMoved: number }; message?: string };

/**
 * "Move this import to another club year" (#541), on the staff club page for
 * system administrators. Pick the year, preview the counts and any conflicts,
 * then move. Nothing is merged and no one is created or deleted.
 */
export function ClubImportYearMove({
  organizationId,
  imports,
  yearChoices,
}: {
  organizationId: string;
  imports: ClubImportSummary[];
  yearChoices: string[];
}) {
  const router = useRouter();
  const [fromYear, setFromYear] = useState(imports[0]?.clubYear ?? "");
  const targets = yearChoices.filter((year) => year !== fromYear);
  const [toYear, setToYear] = useState(targets[0] ?? "");
  const [preview, setPreview] = useState<ImportYearMovePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function send(mode: "preview" | "move") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/organizations/${encodeURIComponent(organizationId)}/club-import-year`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromYear, toYear, mode }),
      });
      const result = await response.json().catch(() => ({})) as MoveResponse;
      if (result.preview) setPreview(result.preview);
      if (!response.ok) throw new Error(result.message ?? "The import could not be moved.");
      if (result.moved) {
        setPreview(null);
        setNotice(`Moved ${result.moved.rowsMoved} roster row${result.moved.rowsMoved === 1 ? "" : "s"} and the import from ${result.moved.fromYear} to ${result.moved.toYear}. No one was added or removed.`);
        router.refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The import could not be moved.");
    } finally {
      setBusy(false);
    }
  }

  const current = preview && preview.fromYear === fromYear && preview.toYear === toYear ? preview : null;

  return (
    <section className="public-manage-card" aria-labelledby="club-import-year-heading" id="club-import-year">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Club import</p>
        <h2 id="club-import-year-heading">{MOVE_IMPORT_ACTION}</h2>
      </div>
      <p className="field-help">
        For a registration imported into the wrong club year. This moves the imported roster rows and the import record
        together. It never creates, deletes, or merges anyone, and it stops if anything conflicts.
      </p>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      {imports.length === 0 ? (
        <p className="public-manage-empty">This club has no form 89 import.</p>
      ) : (
        <>
          <div className="form-grid two-column">
            <label>
              Import to move
              <select
                disabled={busy}
                onChange={(event) => {
                  const year = event.target.value;
                  setFromYear(year);
                  setToYear(yearChoices.find((choice) => choice !== year) ?? "");
                  setPreview(null);
                }}
                value={fromYear}
              >
                {imports.map((item) => (
                  <option key={item.clubYear} value={item.clubYear}>
                    {item.clubYear} (entry {item.entryId}, {item.peopleOnRoster} on the roster)
                  </option>
                ))}
              </select>
            </label>
            <label>
              Move to club year
              <select disabled={busy} onChange={(event) => { setToYear(event.target.value); setPreview(null); }} value={toYear}>
                {targets.map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
            </label>
          </div>
          {current && (
            <div className="inline-notice" role="status">
              <p>
                Moves <strong>{current.rowsToMove}</strong> roster row{current.rowsToMove === 1 ? "" : "s"}
                {" "}({current.peopleOnRoster} on the roster) and the import record from {current.fromYear} to {current.toYear}.
                {" "}The {current.fromYear} roster will have none of them. No people are created or deleted.
              </p>
              {current.conflicts.length > 0 && (
                <>
                  <p><strong>{current.conflicts.length} conflict{current.conflicts.length === 1 ? "" : "s"}. Nothing can be moved until each is resolved:</strong></p>
                  <ul className="club-import-problems">
                    {current.conflicts.map((conflict, index) => (
                      <li key={`${conflict.kind}-${"rosterMemberId" in conflict ? conflict.rosterMemberId : index}`} translate="no">
                        {conflictLabel(conflict, current.toYear)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          <div className="intro-actions">
            <button className="secondary-button" disabled={busy || !toYear} onClick={() => send("preview")} type="button">
              Preview the move
            </button>
            <button
              className="primary-button"
              disabled={busy || !current || current.conflicts.length > 0}
              onClick={() => send("move")}
              type="button"
            >
              <ArrowRightLeft aria-hidden="true" size={14} /> {busy ? "Moving…" : `Move to ${toYear}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
