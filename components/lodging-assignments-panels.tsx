"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  exceptionKindLabels,
  waitlistStatusLabels,
  DEFAULT_OFFER_HOURS,
  MAX_IMPORT_BYTES,
  type WaitlistStatus,
} from "@/modules/lodging/assignment-domain";
import { lodgingCategoryLabels } from "@/modules/lodging/domain";
import type { PlanPreview } from "@/modules/lodging/assignment-service";
import type { AssignmentWorkspaceView, RoomingReports } from "@/modules/lodging/assignment-view";
import type { OfferPreviewRow } from "@/modules/lodging/waitlist-service";

/**
 * The panels of the staff assignment workspace that are not the room board (#200): exceptions, the waitlist, the
 * rule-assisted proposal and CSV import (preview first, then a confirmed apply), the reports, and what attendees see.
 * Every action is a call to a server route that checks the permission again; hiding a button here is a courtesy.
 */

export type Run = (action: () => Promise<{ workspace?: AssignmentWorkspaceView; [key: string]: unknown }>, success: string) => Promise<boolean>;

export async function callLodging(url: string, method: string, body?: unknown) {
  const response = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.message ?? "That could not be saved.");
  return json as { workspace?: AssignmentWorkspaceView; [key: string]: unknown };
}

const shortNight = (night: string) => new Date(`${night}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const nightRange = (first: string | null, last: string | null) => (first && last ? (first === last ? shortNight(first) : `${shortNight(first)} to ${shortNight(last)}`) : "all nights");

// ---------------------------------------------------------------------------
// Needs a look
// ---------------------------------------------------------------------------

export function ExceptionsPanel({ view, base, run, busy }: { view: AssignmentWorkspaceView; base: string; run: Run; busy: boolean }) {
  const conflicts = view.exceptions.filter((row) => row.section === "CONFLICT");
  const closeout = view.exceptions.filter((row) => row.section === "CLOSEOUT");
  const hasInactive = view.exceptions.some((row) => row.kind === "INACTIVE_REGISTRATION");
  const list = (rows: typeof view.exceptions) => rows.length === 0 ? <p>Nothing here.</p> : <ul className="lodging-assign-exceptions">{rows.map((row) => <li key={row.key}>
    <strong>{exceptionKindLabels[row.kind]}{row.kind === "ACCESSIBILITY_UNMET" ? " (restricted)" : ""}</strong>
    <p>{row.title}. {row.detail}</p>
  </li>)}</ul>;
  return <div className="lodging-assign-panels">
    <section className="panel" aria-labelledby="la-conflicts">
      <h3 id="la-conflicts">Conflicts and people not placed ({conflicts.length})</h3>
      <p className="field-hint">Rooms closed or held after people were placed, rooms over capacity, households split across rooms, keep-apart people sharing a room and anyone still without a place. Nothing here changes by itself.</p>
      {list(conflicts)}
    </section>
    <section className="panel" aria-labelledby="la-closeout">
      <h3 id="la-closeout">Closeout exceptions ({closeout.length})</h3>
      {list(closeout)}
      {hasInactive ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
        void run(() => callLodging(`${base}/assignments`, "POST", { action: "release_inactive", reason }), "Released the rooms of registrations that are no longer active.");
      }}>
        <label>Reason for releasing their rooms <input name="reason" required maxLength={300} defaultValue="Registration no longer active" /></label>
        <button type="submit" className="secondary-button" disabled={busy}>Release rooms of inactive registrations</button>
        <p className="field-hint">The history keeps every release. A cancelled registration&apos;s room is only counted as free once you do this.</p>
      </form> : null}
    </section>
  </div>;
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

const openStatuses: WaitlistStatus[] = ["JOINED", "OFFERED", "ACCEPTED", "EXPIRED"];

export function WaitlistPanel({ view, base, run, busy, canConfigure }: { view: AssignmentWorkspaceView; base: string; run: Run; busy: boolean; canConfigure: boolean }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [hours, setHours] = useState(DEFAULT_OFFER_HOURS);
  const [preview, setPreview] = useState<OfferPreviewRow[] | null>(null);
  const [offerResult, setOfferResult] = useState("");
  const registrations = [...new Map(view.people.filter((person) => person.kind === "ATTENDEE" && person.active && person.registrationId).map((person) => [person.registrationId!, person.registrationCode ?? ""])).entries()];
  const units = view.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.units.map((unit) => ({ building: building.name, unit }))));
  const categories = Object.entries(lodgingCategoryLabels) as Array<[string, string]>;
  const act = (body: unknown, success: string) => run(() => callLodging(`${base}/waitlist`, "POST", body), success);

  return <div className="lodging-assign-panels">
    <section className="panel" aria-labelledby="la-waitlist">
      <h3 id="la-waitlist">Lodging waitlist ({view.waitlist.length})</h3>
      <p className="field-hint">Offers are sent one email per entry, only when you confirm here. Nothing offers or promotes on its own. An offer reserves its places until it expires; placing the party in a room is a separate step after they accept. Nothing here changes a registration&apos;s charge.</p>
      {offerResult ? <p className="usage-note" role="status">{offerResult}</p> : null}
      {view.waitlist.length === 0 ? <p>Nobody is on the lodging waitlist.</p> : <div className="table-wrap"><table>
        <caption className="sr-only">Lodging waitlist</caption>
        <thead><tr>
          {canConfigure ? <th scope="col"><span className="sr-only">Choose</span></th> : null}
          <th scope="col">Registration</th><th scope="col">Type</th><th scope="col">Nights</th><th scope="col">People</th><th scope="col">Status</th><th scope="col">Actions</th>
        </tr></thead>
        <tbody>{view.waitlist.map((entry) => {
          const open = openStatuses.includes(entry.status);
          return <tr key={entry.id}>
            {canConfigure ? <td><input type="checkbox" aria-label={`Choose ${entry.registrationCode} for an offer`} disabled={!open || entry.status === "ACCEPTED"} checked={selected.includes(entry.id)} onChange={(event) => { setPreview(null); setSelected(event.target.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id)); }} /></td> : null}
            <th scope="row">{entry.registrationCode}<br /><small>{entry.holder}</small></th>
            <td>{lodgingCategoryLabels[entry.category]}</td>
            <td>{nightRange(entry.firstNight, entry.lastNight)}</td>
            <td>{entry.partySize}</td>
            <td>{waitlistStatusLabels[entry.status]}{entry.lapsed ? " (expired)" : ""}{entry.offerExpiresAt && entry.status === "OFFERED" ? <><br /><small>until {new Date(entry.offerExpiresAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</small></> : null}</td>
            <td>
              {open ? <details><summary>Answer, remove or place</summary>
                <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
                  const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
                  void act({ action: submitter?.value ?? "remove", entryId: entry.id, reason }, "Waitlist updated.");
                }}>
                  <label>Reason <input name="reason" required maxLength={300} /></label>
                  <button type="submit" value="accept" disabled={busy || entry.status !== "OFFERED"}>Record: accepted</button>
                  <button type="submit" value="decline" disabled={busy || entry.status !== "OFFERED"}>Record: declined</button>
                  <button type="submit" value="remove" disabled={busy}>Remove from the waitlist</button>
                </form>
                {entry.status === "ACCEPTED" && canConfigure ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const attendeeIds = form.getAll("attendeeId").map(String);
                  void act({ action: "promote", entryId: entry.id, eventUnitId: String(form.get("unit")), attendeeIds, confirmSpecialUse: form.get("special") === "on" }, "Placed the party in the room.");
                }}>
                  <fieldset><legend>Place the party in a room</legend>
                    <label>Room <select name="unit" required>{units.filter((row) => row.unit.status !== "NOT_ASSIGNABLE").map((row) => <option key={row.unit.eventUnitId} value={row.unit.eventUnitId}>{row.building} {row.unit.name}</option>)}</select></label>
                    {view.people.filter((person) => person.registrationId === entry.registrationId).map((person) => <label key={person.occupantKey}><input type="checkbox" name="attendeeId" value={person.occupantId} defaultChecked /> {person.name}</label>)}
                    <label><input type="checkbox" name="special" /> It is a special-use room and I want it anyway</label>
                    <button type="submit" disabled={busy}>Place them</button>
                  </fieldset>
                </form> : null}
              </details> : <span>{entry.status === "PROMOTED" ? "In a room" : "Closed"}</span>}
            </td>
          </tr>;
        })}</tbody>
      </table></div>}
      {canConfigure ? <div>
        <h4>Offer places</h4>
        <label>Offer expires after <input type="number" min={1} max={336} value={hours} onChange={(event) => { setPreview(null); setHours(Math.max(1, Math.min(336, Number(event.target.value) || DEFAULT_OFFER_HOURS))); }} /> hours</label>
        <button type="button" className="secondary-button" disabled={busy || selected.length === 0} onClick={() => {
          void run(async () => {
            const result = await callLodging(`${base}/waitlist`, "POST", { action: "offer", entryIds: selected, expiresInHours: hours, confirm: false });
            setPreview(((result.result as { rows: OfferPreviewRow[] }).rows));
            return {};
          }, "Check the list below, then confirm.");
        }}>Preview offers for {selected.length} {selected.length === 1 ? "entry" : "entries"}</button>
        {preview ? <div>
          <table>
            <caption>Who would be emailed (nothing is sent yet)</caption>
            <thead><tr><th scope="col">Registration</th><th scope="col">Email goes to</th><th scope="col">Result</th></tr></thead>
            <tbody>{preview.map((row) => <tr key={row.entryId}><th scope="row">{row.registrationCode}</th><td>{row.recipientMasked ?? "No address"}</td><td>{row.alreadyOffered ? "Already holds a live offer: no new email" : row.eligible ? "Will be offered" : row.reason}</td></tr>)}</tbody>
          </table>
          <button type="button" className="primary-button" disabled={busy || preview.every((row) => !row.eligible || row.alreadyOffered)} onClick={() => {
            void run(async () => {
              const result = await callLodging(`${base}/waitlist`, "POST", { action: "offer", entryIds: preview.map((row) => row.entryId), expiresInHours: hours, confirm: true });
              const outcome = result.result as { offered: Array<{ alreadyOffered: boolean }>; skipped: unknown[] };
              setOfferResult(`${outcome.offered.filter((row) => !row.alreadyOffered).length} offer email(s) queued, ${outcome.skipped.length} skipped.`);
              setPreview(null); setSelected([]);
              return result;
            }, "Offers sent.");
          }}>Send {preview.filter((row) => row.eligible && !row.alreadyOffered).length} offer email(s), one each</button>
        </div> : null}
        <p><button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ action: "expire_lapsed" }, "Recorded the lapsed offers.")}>Record offers that have expired</button></p>
      </div> : <p className="field-hint">Event administrators send offers and place parties from the waitlist.</p>}
    </section>

    <section className="panel" aria-labelledby="la-waitlist-add">
      <h3 id="la-waitlist-add">Add a registration to the waitlist</h3>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void act({ action: "join", registrationId: String(form.get("registration")), category: String(form.get("category")), partySize: Number(form.get("party")) || 1, reason: String(form.get("reason") ?? "") }, "Added to the waitlist.");
      }}>
        <label>Registration <select name="registration" required>{registrations.map(([id, code]) => <option key={id} value={id}>{code}</option>)}</select></label>
        <label>Lodging type <select name="category">{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>People <input type="number" name="party" min={1} max={50} defaultValue={1} /></label>
        <label>Note <input name="reason" maxLength={300} /></label>
        <span className="field-hint">No medical details.</span>
        <button type="submit" className="secondary-button" disabled={busy}>Add to the waitlist</button>
      </form>
    </section>
  </div>;
}

// ---------------------------------------------------------------------------
// Proposal and CSV import: preview first, then a confirmed apply
// ---------------------------------------------------------------------------

export function PlanPanel({ view, base, run, busy, canExport }: { view: AssignmentWorkspaceView; base: string; run: Run; busy: boolean; canExport: boolean }) {
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [csv, setCsv] = useState("");
  const [source, setSource] = useState<"PROPOSAL" | "CSV_IMPORT">("PROPOSAL");
  const request = (mode: "preview" | "apply") => ({ mode, source, ...(source === "CSV_IMPORT" ? { csv } : {}), ...(mode === "apply" && preview ? { fingerprint: preview.fingerprint } : {}) });
  return <div className="lodging-assign-panels">
    <section className="panel" aria-labelledby="la-plan">
      <h3 id="la-plan">Proposal and import</h3>
      <p className="field-hint">Both show exactly what they would do first and change nothing until you confirm. {view.canSeeSensitive ? "A proposal puts ground-floor needs on the ground floor." : "Without access to accessibility needs, a proposal does not consider them."}</p>
      <div role="group" aria-label="What to preview">
        <label><input type="radio" name="plan-source" checked={source === "PROPOSAL"} onChange={() => { setSource("PROPOSAL"); setPreview(null); }} /> Rule-assisted proposal (households first, preferences honoured)</label>
        <label><input type="radio" name="plan-source" checked={source === "CSV_IMPORT"} onChange={() => { setSource("CSV_IMPORT"); setPreview(null); }} /> CSV of assignments</label>
      </div>
      {source === "CSV_IMPORT" ? <div>
        <label>CSV file <input type="file" accept=".csv,text/csv" onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          if (file.size > MAX_IMPORT_BYTES) { setCsv(""); return; }
          setCsv(await file.text()); setPreview(null);
        }} /></label>
        <label>or paste it here <textarea rows={5} value={csv} maxLength={MAX_IMPORT_BYTES} onChange={(event) => { setCsv(event.target.value); setPreview(null); }} /></label>
        <p className="field-hint">Use the columns of the downloaded assignments file: Occupant ID, Place key (unit:&lt;key&gt; or bucket:&lt;kind&gt;), First night and Last night. Names are ignored. Anyone you list is moved to that place for those nights.</p>
      </div> : null}
      <button type="button" className="secondary-button" disabled={busy || (source === "CSV_IMPORT" && !csv.trim())} onClick={() => {
        void run(async () => { const result = await callLodging(`${base}/assignments/plan`, "POST", request("preview")); setPreview(result.preview as PlanPreview); return {}; }, "Preview ready. Nothing has changed.");
      }}>Preview</button>
      {preview ? <div>
        <p role="status"><strong>{preview.counts.new} new, {preview.counts.move} moved, {preview.counts.unchanged} unchanged, {preview.counts.problems} with problems, {preview.counts.unplaced} could not be placed.</strong> Nothing has been applied.</p>
        {preview.problems.length > 0 ? <ul className="form-error">{preview.problems.slice(0, 40).map((problem, index) => <li key={index}>{problem.line ? `Line ${problem.line}: ` : ""}{problem.message}</li>)}</ul> : null}
        {preview.unplaced.length > 0 ? <details><summary>{preview.unplaced.length} not placed</summary><ul>{preview.unplaced.map((row) => <li key={row.occupantId}>{row.name}: {row.reason}</li>)}</ul></details> : null}
        <div className="table-wrap"><table>
          <caption className="sr-only">Preview of the changes</caption>
          <thead><tr><th scope="col">Who</th><th scope="col">Place</th><th scope="col">Nights</th><th scope="col">Result</th></tr></thead>
          <tbody>{preview.rows.slice(0, 300).map((row, index) => <tr key={`${row.occupantId}-${index}`}><th scope="row">{row.name}</th><td>{row.place}</td><td>{nightRange(row.firstNight, row.lastNight)}</td><td>{row.outcome === "PROBLEM" ? row.message : row.outcome === "MOVE" ? "Moves them" : row.outcome === "NEW" ? "New" : "Already there"}</td></tr>)}</tbody>
        </table></div>
        <button type="button" className="primary-button" disabled={busy || preview.counts.new + preview.counts.move === 0 || (source === "CSV_IMPORT" && preview.problems.length > 0)} onClick={() => {
          void run(async () => { const result = await callLodging(`${base}/assignments/plan`, "POST", request("apply")); setPreview(null); return result; }, "Applied exactly what was previewed.");
        }}>Apply these {preview.counts.new + preview.counts.move} changes</button>
        {source === "CSV_IMPORT" && preview.problems.length > 0 ? <p className="field-hint">A file with problems is not applied. Fix it and preview again.</p> : null}
      </div> : null}
    </section>
    <section className="panel" aria-labelledby="la-export">
      <h3 id="la-export">Export</h3>
      {canExport ? <ul>
        <li><a href={`/api/events/${view.eventId}/exports/lodging-assignments?report=assignments`}>Rooming list (CSV, the file the import reads)</a></li>
        <li><a href={`/api/events/${view.eventId}/exports/lodging-assignments?report=occupancy`}>Occupancy by night (CSV)</a></li>
        <li><a href={`/api/events/${view.eventId}/exports/lodging-assignments?report=unassigned`}>Not placed (CSV)</a></li>
        <li><a href={`/api/events/${view.eventId}/exports/lodging-assignments?report=conflicts`}>Conflicts (CSV)</a></li>
        <li><a href={`/api/events/${view.eventId}/exports/lodging-assignments?report=keys`}>Key hand-off inputs (CSV)</a></li>
        <li><a href={`/api/events/${view.eventId}/exports/lodging-assignments?report=closeout`}>Closeout exceptions (CSV)</a></li>
      </ul> : <p>Exports need the reports permission.</p>}
      <p className="field-hint">Names appear, as on any rooming list; contact details never do. {view.canSeeSensitive ? "The two accessibility columns are included for you." : "Accessibility columns are not included."}</p>
    </section>
  </div>;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function ReportsPanel({ eventId }: { eventId: string }) {
  const [reports, setReports] = useState<RoomingReports | null>(null);
  const [error, setError] = useState("");
  const [night, setNight] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/events/${eventId}/lodging/assignments/reports`);
        const json = await response.json();
        if (!response.ok) throw new Error(json.message ?? "The reports could not be loaded.");
        if (!cancelled) setReports(json.reports as RoomingReports);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "The reports could not be loaded.");
      }
    })();
    return () => { cancelled = true; };
  }, [eventId]);
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!reports) return <p role="status">Loading the reports...</p>;
  const drill = night ? reports.occupancyByUnit.map((unit) => ({ unit, row: unit.nights.find((entry) => entry.night === night)! })).filter((entry) => entry.row && (entry.row.occupied > 0 || entry.row.status !== "AVAILABLE")) : [];
  const nameOf = new Map(reports.rooming.flatMap((group) => group.occupants.map((occupant) => [occupant.assignmentId, `${occupant.name} (${occupant.registrationCode || "expected guest"})`] as const)));
  return <div className="lodging-assign-panels">
    <section className="panel" aria-labelledby="la-occ">
      <h3 id="la-occ">Occupancy by night</h3>
      <div className="table-wrap"><table>
        <caption className="sr-only">Occupancy by night</caption>
        <thead><tr><th scope="col">Night</th><th scope="col">Places</th><th scope="col">Placed</th><th scope="col">Free</th><th scope="col">Rooms in service</th><th scope="col">Housing elsewhere</th><th scope="col">Rooms and people</th></tr></thead>
        <tbody>{reports.occupancy.map((row) => <tr key={row.night}>
          <th scope="row">{shortNight(row.night)}</th><td>{row.capacity}{row.unlimited ? " + no limit" : ""}</td><td>{row.occupied}</td><td>{row.available}</td><td>{row.unitsInService}</td><td>{row.offsite}</td>
          <td><button type="button" className="secondary-button" aria-pressed={night === row.night} onClick={() => setNight(night === row.night ? null : row.night)}>{night === row.night ? "Hide" : "Show"}</button></td>
        </tr>)}</tbody>
      </table></div>
      {night ? <div>
        <h4>{shortNight(night)}: rooms with people or out of service</h4>
        {drill.length === 0 ? <p>Nobody is placed on this night.</p> : <ul>{drill.map(({ unit, row }) => <li key={unit.unitId}><strong>{unit.building} {unit.name}</strong>: {row.occupied}{row.capacity === null ? "" : ` of ${row.capacity}`}{row.status !== "AVAILABLE" ? ` (${row.status.toLowerCase().replace("_", " ")})` : ""}
          {row.assignmentIds.length > 0 ? <ul>{row.assignmentIds.map((id) => <li key={id}>{nameOf.get(id) ?? "Someone"}</li>)}</ul> : null}
        </li>)}</ul>}
      </div> : null}
    </section>
    <section className="panel" aria-labelledby="la-rooming">
      <h3 id="la-rooming">Rooming list</h3>
      {reports.rooming.length === 0 ? <p>Nobody is placed yet.</p> : reports.rooming.map((group) => <div key={group.placeKey}>
        <h4>{group.building}: {group.place}</h4>
        <ul>{group.occupants.map((occupant) => <li key={occupant.assignmentId}>{occupant.name}{occupant.registrationCode ? ` (${occupant.registrationCode})` : " (expected guest)"}, {nightRange(occupant.firstNight, occupant.lastNight)}{occupant.people > 1 ? `, ${occupant.people} people` : ""}{occupant.groundFloorNeeded || occupant.accessibleRoomNeeded ? " [accessibility need]" : ""}</li>)}</ul>
      </div>)}
    </section>
    <section className="panel" aria-labelledby="la-keys">
      <h3 id="la-keys">Key hand-off inputs</h3>
      <p className="field-hint">What the person handing out keys needs. Key issuance itself is a separate feature.</p>
      {reports.keyHandoff.length === 0 ? <p>No rooms are assigned.</p> : <div className="table-wrap"><table>
        <thead><tr><th scope="col">Room or site</th><th scope="col">People</th><th scope="col">Arrives</th><th scope="col">Leaves</th><th scope="col">Name on the registration</th></tr></thead>
        <tbody>{reports.keyHandoff.map((row) => <tr key={row.placeKey}><th scope="row">{row.building} {row.place}</th><td>{row.people}</td><td>{shortNight(row.arrival)}</td><td>{shortNight(row.departure)}</td><td>{row.holder}</td></tr>)}</tbody>
      </table></div>}
    </section>
    <section className="panel" aria-labelledby="la-unassigned">
      <h3 id="la-unassigned">Not placed ({reports.unassigned.length}) and conflicts ({reports.conflicts.length})</h3>
      <ul>{[...reports.unassigned, ...reports.conflicts].map((row) => <li key={row.key}><strong>{row.label}</strong>: {row.title}. {row.detail}</li>)}</ul>
      {reports.unassigned.length + reports.conflicts.length === 0 ? <p>Nothing to resolve.</p> : null}
    </section>
  </div>;
}

// ---------------------------------------------------------------------------
// What attendees see
// ---------------------------------------------------------------------------

export function DisplayPanel({ view, base, run, busy, canConfigure }: { view: AssignmentWorkspaceView; base: string; run: Run; busy: boolean; canConfigure: boolean }) {
  const registrations = [...new Map(view.people.filter((person) => person.kind === "ATTENDEE" && person.active && person.registrationId && person.placements.length > 0).map((person) => [person.registrationId!, person.registrationCode ?? ""])).entries()];
  const noticeOf = new Map(view.notices.map((notice) => [notice.registrationId, notice]));
  return <div className="lodging-assign-panels">
    <section className="panel" aria-labelledby="la-display">
      <h3 id="la-display">What attendees see</h3>
      <p>Attendees see their approved building, room and instructions on their private registration page only after you show assignments. Roommates are shown by first name only, only adults on other registrations, and only when you turn that on. Contact details are never shown.</p>
      {canConfigure ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void run(() => callLodging(`${base}/assignments/settings`, "PATCH", {
          showAssignmentsToAttendees: form.get("show") === "on",
          showRoommateFirstNames: form.get("mates") === "on",
          attendeeInstructions: String(form.get("instructions") ?? "").trim() || null,
        }), "Saved.");
      }}>
        <label><input type="checkbox" name="show" defaultChecked={view.settings.showAssignmentsToAttendees} /> Show room assignments to attendees</label>
        <label><input type="checkbox" name="mates" defaultChecked={view.settings.showRoommateFirstNames} /> Show roommates by first name</label>
        <label>Instructions shown with the assignment <textarea name="instructions" rows={3} maxLength={1000} defaultValue={view.settings.attendeeInstructions ?? ""} /></label>
        <span className="field-hint">The same words for everyone. Do not put personal details here.</span>
        <button type="submit" className="primary-button" disabled={busy}>Save</button>
      </form> : <p>Currently: assignments are {view.settings.showAssignmentsToAttendees ? "shown" : "hidden"}, roommates are {view.settings.showRoommateFirstNames ? "shown by first name" : "hidden"}. Event administrators change this.</p>}
    </section>
    <section className="panel" aria-labelledby="la-notices">
      <h3 id="la-notices">Room notices</h3>
      <p className="field-hint">Each notice is one email to one registration, sent only when you press the button. A notice is out of date as soon as that registration&apos;s rooms change afterwards.</p>
      {registrations.length === 0 ? <p>No registration has a room yet.</p> : <ul>{registrations.map(([registrationId, code]) => {
        const notice = noticeOf.get(registrationId);
        return <li key={registrationId}>
          {code}: {notice ? (notice.obsolete ? "notice is out of date" : "notice is current") : "no notice sent"}{notice?.messageStatus ? ` (${notice.messageStatus.toLowerCase()})` : ""}
          {canConfigure && view.settings.showAssignmentsToAttendees ? <button type="button" className="secondary-button" disabled={busy || (notice !== undefined && !notice.obsolete)} onClick={() => void run(() => callLodging(`${base}/assignments/notices`, "POST", { registrationId }), "Room notice queued.")}>{notice ? "Send the new notice" : "Send room notice"}</button> : null}
        </li>;
      })}</ul>}
      {!view.settings.showAssignmentsToAttendees ? <p className="field-hint">Show assignments to attendees first: a notice says what the private page says.</p> : null}
    </section>
  </div>;
}
