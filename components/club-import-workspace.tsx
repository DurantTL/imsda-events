"use client";

import { useState } from "react";
import { CheckCircle2, CircleAlert, FileUp, Upload } from "lucide-react";
import { confirmPayload } from "@/modules/club-imports/confirm-payload";
import { churchStem, earlierImportNotice, inFileDuplicateKeys, skipReasonLabel, submissionYearNote } from "@/modules/club-imports/domain";
import type { AnnotatedImportDraft, ClubImportResult } from "@/modules/club-imports/repository";
import { clubClassLevelLabels } from "@/modules/club-rosters/domain";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";
import { sponsorOptionLabel } from "@/modules/organizations/domain";

type Draft = AnnotatedImportDraft & { include: boolean; expanded: boolean };
type Church = { id: string; name: string; type: string };
type ApiError = { message?: string; issues?: Array<{ message?: string; path?: Array<string | number> }> };
/** What the preview route returns for an uploaded export. */
export type ClubImportPreview = { drafts: AnnotatedImportDraft[]; churches?: Church[]; clubYearChoices?: string[]; skipped?: number };

const NEW_CHURCH = "__new__";

/** Already imported for the club year chosen in the preview (#541). */
function importedFor(draft: Pick<AnnotatedImportDraft, "importedYears" | "clubYear">) {
  return draft.importedYears[draft.clubYear] ?? null;
}

/** Where staff move an import to another year: the club's staff page (#541). */
const moveHref = (clubId: string) => `/admin/organizations/${encodeURIComponent(clubId)}/club#club-import-year`;

function draftProblems(draft: Draft) {
  const problems: string[] = [];
  const earlier = earlierImportNotice(draft.importedYears, draft.clubYear);
  if (earlier?.blocking) problems.push(earlier.message);
  if (draft.existingClub && !draft.existingClub.isActive) problems.push("A club with this name is inactive. Rename it or reactivate that club first.");
  if (draft.clubName.trim().length < 2) problems.push("Give the club a name.");
  if (!draft.churchId && !draft.newChurchName && !(draft.existingClub?.isActive && draft.existingClub.hasSponsoringChurch)) {
    problems.push("Choose or create the club's sponsoring church or company.");
  }
  const missingLast = draft.people.filter((person) => person.include && !person.lastName.trim()).length;
  if (missingLast) problems.push(`${missingLast} ${missingLast === 1 ? "person has" : "people have"} no last name. Add one or skip them.`);
  return problems;
}

/**
 * The preview's starting state (#541): every club is selected, so one click
 * imports it, except an entry imported before in any club year. That one is
 * unselected: importing again would add everyone a second time, and the
 * card points to the Move action instead.
 */
export function loadPreviewDrafts(drafts: AnnotatedImportDraft[]): Draft[] {
  return drafts.map((draft) => {
    const loaded = { ...draft, include: !earlierImportNotice(draft.importedYears, draft.clubYear), expanded: false };
    // Open the cards that need attention; the rest stay folded until clicked.
    return { ...loaded, expanded: !loaded.include || draftProblems(loaded).length > 0 };
  });
}

/**
 * The club import (#376): upload the form 89 export, review and edit every
 * club, then import. Nothing is emailed here; invites wait on the Club
 * invites page until an administrator sends them. `initialPreview` starts on
 * an already-read export (render tests).
 */
export function ClubImportWorkspace({ initialPreview }: { initialPreview?: ClubImportPreview }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(initialPreview ? loadPreviewDrafts(initialPreview.drafts) : null);
  const [churches, setChurches] = useState<Church[]>(initialPreview?.churches ?? []);
  const [yearChoices, setYearChoices] = useState<string[]>(initialPreview?.clubYearChoices ?? []);
  const [skipped, setSkipped] = useState(initialPreview?.skipped ?? 0);
  const [results, setResults] = useState<ClubImportResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function readFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setResults(null);
    try {
      const response = await fetch("/api/admin/club-import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await file.text(),
      });
      const result = await response.json().catch(() => ({})) as ApiError & Partial<ClubImportPreview>;
      if (!response.ok || !result.drafts) throw new Error(result.message ?? "That file could not be read.");
      setChurches(result.churches ?? []);
      setYearChoices(result.clubYearChoices ?? []);
      setSkipped(result.skipped ?? 0);
      setDrafts(loadPreviewDrafts(result.drafts));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That file could not be read.");
    } finally {
      setBusy(false);
    }
  }

  function update(index: number, change: (draft: Draft) => Draft) {
    setDrafts((current) => current && current.map((draft, i) => (i === index ? change(draft) : draft)));
  }

  // Moving to a year it was already imported for unselects it; nothing selects it by itself.
  const changeYear = (index: number, clubYear: string) =>
    update(index, (d) => ({ ...d, clubYear, include: importedFor({ importedYears: d.importedYears, clubYear }) ? false : d.include }));

  const chosen = drafts?.filter((draft) => draft.include) ?? [];
  const blocked = chosen.filter((draft) => draftProblems(draft).length > 0);

  async function confirm() {
    if (!drafts) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/club-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirmPayload(drafts)),
      });
      const result = await response.json().catch(() => ({})) as ApiError & { results?: ClubImportResult[] };
      if (!response.ok || !result.results) throw new Error(result.message ?? "The import could not be completed.");
      setResults(result.results);
      setDrafts(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The import could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-stack club-import">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Clubs</p>
          <h2>Import clubs</h2>
          <p>
            Upload the entries export of the old website&apos;s <strong>Pathfinder Yearly Club Registration</strong> form (form 89,
            JSON). Review and edit each club, then import. The file isn&apos;t stored. Addresses, phone numbers, and
            child-protection answers are left out. Nothing is emailed until you send invites.
          </p>
        </div>
      </div>

      {error && <div className="inline-notice error" role="alert">{error}</div>}

      {results && (
        <section className="panel">
          <div className="section-heading"><div><p className="eyebrow">Done</p><h2>Import results</h2></div></div>
          <ul className="club-import-results">
            {results.map((result) => (
              <li key={result.sourceKey}>
                {result.status === "IMPORTED" ? <CheckCircle2 aria-hidden="true" size={16} /> : <CircleAlert aria-hidden="true" size={16} />}
                <span>
                  <strong translate="no">{result.clubName}</strong> ({result.clubYear}): {result.message}
                  {result.status === "IMPORTED" && ` ${result.membersAdded} added to the roster, ${result.membersSkipped} skipped; ${result.invitesCreated} invite${result.invitesCreated === 1 ? "" : "s"} waiting.`}
                  {result.organizationId && result.status !== "FAILED" && (
                    <> <a href={`/admin/organizations/${encodeURIComponent(result.organizationId)}/club?year=${encodeURIComponent(result.clubYear)}`}>View the {result.clubYear} roster</a>.</>
                  )}
                  {result.skipped.length > 0 && (
                    <ul className="club-import-skipped" aria-label={`Skipped from ${result.clubName}`}>
                      {result.skipped.map((skip, skipIndex) => (
                        <li key={`${skip.name}-${skipIndex}`}><span translate="no">{skip.name}</span>: {skipReasonLabel(skip.reason, result.clubYear)}</li>
                      ))}
                    </ul>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="field-help club-import-next">Next: <a href="/admin/clubs/invites">review and send the club invites</a>.</p>
        </section>
      )}

      {!drafts && (
        <label className="panel club-import-upload">
          <FileUp aria-hidden="true" size={26} />
          <strong>{busy ? "Reading…" : "Choose the export file"}</strong>
          <small>Fluent Forms → Entries → Export → JSON</small>
          <input accept="application/json,.json" disabled={busy} onChange={readFile} type="file" />
        </label>
      )}

      {drafts && (
        <>
          <div className="panel club-import-summary">
            <p>
              <strong>{drafts.length}</strong> registration{drafts.length === 1 ? "" : "s"} found
              {skipped ? ` (${skipped} skipped: not form 89 or in the trash)` : ""}. <strong>{chosen.length}</strong> selected.
            </p>
            <div className="intro-actions">
              <button className="secondary-button" disabled={busy} onClick={() => setDrafts(null)} type="button">Start over</button>
              <button className="primary-button" disabled={busy || chosen.length === 0 || blocked.length > 0} onClick={confirm} type="button">
                <Upload aria-hidden="true" size={16} /> {busy ? "Importing…" : `Import ${chosen.length} club${chosen.length === 1 ? "" : "s"}`}
              </button>
            </div>
            {blocked.length > 0 && <p className="field-help">Fix or unselect the clubs marked below before importing.</p>}
          </div>

          {drafts.map((draft, index) => {
            const problems = draftProblems(draft);
            const earlier = earlierImportNotice(draft.importedYears, draft.clubYear);
            const duplicates = inFileDuplicateKeys(draft.people);
            const unkeptDuplicates = draft.people.filter((person) => duplicates.has(person.key) && !person.keepBoth).length;
            const churchValue = draft.churchId ?? (draft.newChurchName ? NEW_CHURCH : "");
            return (
              <details
                className="panel club-import-club"
                key={draft.sourceKey}
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  if (open !== draft.expanded) update(index, (d) => ({ ...d, expanded: open }));
                }}
                open={draft.expanded}
              >
                <summary>
                  <input
                    aria-label={`Import ${draft.clubName || "this club"}`}
                    checked={draft.include}
                    onChange={(event) => update(index, (d) => ({ ...d, include: event.target.checked }))}
                    onClick={(event) => event.stopPropagation()}
                    type="checkbox"
                  />
                  <span>
                    <strong translate="no">{draft.clubName || "Unnamed club"}</strong>
                    <small>
                      {draft.clubYear} · entry {draft.entryId}{draft.submittedOn ? ` · ${draft.submittedOn}` : ""} ·{" "}
                      {draft.people.filter((person) => person.include).length} people
                      {draft.existingClub?.isActive ? " · adds to the existing club" : ""}
                    </small>
                    {submissionYearNote(draft) && <small className="club-import-year-note">{submissionYearNote(draft)}</small>}
                  </span>
                  {problems.length > 0 && draft.include && <span className="status-chip coral">Needs a fix</span>}
                  {importedFor(draft) && <span className="status-chip gold">Imported</span>}
                </summary>

                {problems.length > 0 && (
                  <ul className="club-import-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
                )}
                {earlier && (
                  <p className="inline-notice club-import-move-hint" role="status">
                    {earlier.blocking ? "" : `${earlier.message} `}
                    <a href={moveHref(earlier.clubId)}>Open the club to move its import</a>.
                  </p>
                )}

                <div className="form-stack">
                <div className="form-grid two-column">
                  <label>
                    Club name
                    <input
                      maxLength={120}
                      onChange={(event) => update(index, (d) => ({ ...d, clubName: event.target.value, existingClub: null }))}
                      value={draft.clubName}
                    />
                  </label>
                  <label>
                    Sponsoring church or company{draft.churchName ? ` (form: ${draft.churchName})` : ""}
                    <select
                      required
                      onChange={(event) => {
                        const value = event.target.value;
                        update(index, (d) => ({
                          ...d,
                          churchId: value && value !== NEW_CHURCH ? value : null,
                          newChurchName: value === NEW_CHURCH ? (d.newChurchName || d.churchName) : "",
                        }));
                      }}
                      value={churchValue}
                    >
                      <option disabled value="">Choose a church or company</option>
                      {(draft.newChurchName || draft.churchName) && (
                        <option value={NEW_CHURCH}>Create church: {draft.newChurchName || draft.churchName}</option>
                      )}
                      {churches.map((church) => <option key={church.id} value={church.id}>{church.type !== "CHURCH" && churchStem(church.name) === churchStem(draft.churchName) ? `Use existing ${church.type === "GROUP" ? "group" : "company"}: ${church.name}` : sponsorOptionLabel(church)}</option>)}
                    </select>
                  </label>
                  <label>
                    Club year to import into
                    <select
                      aria-label={`Club year for ${draft.clubName || "this club"}`}
                      onChange={(event) => changeYear(index, event.target.value)}
                      value={draft.clubYear}
                    >
                      {(yearChoices.length ? yearChoices : [draft.clubYear]).map((year) => <option key={year} value={year}>{year}</option>)}
                    </select>
                  </label>
                </div>
                </div>

                <h3 className="club-import-subhead">Invites (sent later, from Club invites)</h3>
                {draft.invites.length === 0 ? (
                  <p className="field-help">The form had no leader email. Add a director from the club&apos;s Team page later.</p>
                ) : (
                  <div className="report-table-wrap">
                    <table className="report-table club-import-table">
                      <thead><tr><th>Invite</th><th>Role</th><th>Name</th><th>Email</th></tr></thead>
                      <tbody>
                        {draft.invites.map((invite, inviteIndex) => (
                          <tr key={invite.key}>
                            <td>
                              <input
                                aria-label={`Invite ${invite.name || invite.email}`}
                                checked={invite.include}
                                onChange={(event) => update(index, (d) => ({ ...d, invites: d.invites.map((item, i) => (i === inviteIndex ? { ...item, include: event.target.checked } : item)) }))}
                                type="checkbox"
                              />
                            </td>
                            <td>{clubDirectorRoleLabels[invite.role]}</td>
                            <td translate="no">{invite.name}</td>
                            <td>
                              <input
                                aria-label={`Email for ${invite.name || clubDirectorRoleLabels[invite.role]}`}
                                className="club-import-email"
                                maxLength={254}
                                onChange={(event) => update(index, (d) => ({ ...d, invites: d.invites.map((item, i) => (i === inviteIndex ? { ...item, email: event.target.value.trim() } : item)) }))}
                                type="email"
                                value={invite.email}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <h3 className="club-import-subhead">Roster for {draft.clubYear}</h3>
                {unkeptDuplicates > 0 && (
                  <p className="field-help">
                    {unkeptDuplicates === 1 ? "1 person has" : `${unkeptDuplicates} people have`} the same name and section as
                    someone above and {unkeptDuplicates === 1 ? "is" : "are"} skipped. If they are different people, tick Keep both.
                  </p>
                )}
                <div className="report-table-wrap">
                  <table className="report-table club-import-table">
                    <thead><tr><th>Add</th><th>First name</th><th>Last name</th><th>Type</th><th>Class</th><th>Age</th><th>Check</th></tr></thead>
                    <tbody>
                      {draft.people.map((person, personIndex) => {
                        const set = (change: Partial<typeof person>) => update(index, (d) => ({
                          ...d,
                          people: d.people.map((item, i) => (i === personIndex ? { ...item, ...change } : item)),
                        }));
                        return (
                          <tr key={person.key}>
                            <td><input aria-label={`Add ${person.firstName} ${person.lastName}`} checked={person.include} onChange={(event) => set({ include: event.target.checked })} type="checkbox" /></td>
                            <td><input aria-label="First name" maxLength={80} onChange={(event) => set({ firstName: event.target.value })} value={person.firstName} /></td>
                            <td><input aria-label="Last name" maxLength={80} onChange={(event) => set({ lastName: event.target.value })} value={person.lastName} /></td>
                            <td>
                              <select aria-label="Type" onChange={(event) => set({ attendeeType: event.target.value as "STAFF" | "YOUTH" })} value={person.attendeeType}>
                                <option value="STAFF">Staff</option>
                                <option value="YOUTH">Pathfinder</option>
                              </select>
                            </td>
                            <td>
                              <select
                                aria-label="Class"
                                onChange={(event) => set({ classLevel: (event.target.value || null) as typeof person.classLevel, classText: "" })}
                                value={person.classLevel ?? ""}
                              >
                                <option value="">{person.classText ? `None (form: ${person.classText})` : "None"}</option>
                                {Object.entries(clubClassLevelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                              </select>
                            </td>
                            <td>
                              <input
                                aria-label="Age"
                                className="club-import-age"
                                inputMode="numeric"
                                max={99}
                                min={0}
                                onChange={(event) => set({ reportedAge: event.target.value === "" ? null : Math.max(0, Math.min(99, Number(event.target.value) || 0)) })}
                                type="number"
                                value={person.reportedAge ?? ""}
                              />
                            </td>
                            <td>
                              {duplicates.has(person.key) ? (
                                <label className="checkbox-label">
                                  <input
                                    aria-label={`Keep both people named ${person.firstName} ${person.lastName}`}
                                    checked={person.keepBoth}
                                    onChange={(event) => set({ keepBoth: event.target.checked })}
                                    type="checkbox"
                                  />
                                  Same name as above. Keep both
                                </label>
                              ) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="field-help">
                  The form has ages, not birth dates. Imported people show &ldquo;birth date needed&rdquo; until the director adds one.
                </p>
              </details>
            );
          })}
        </>
      )}
    </section>
  );
}
