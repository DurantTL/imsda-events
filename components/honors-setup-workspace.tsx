"use client";

import { staffPageTitles } from "@/components/staff-navigation";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Award, CalendarRange, ClipboardList, Copy, Pencil, Plus, Power, Save, Trash2, TriangleAlert, X } from "lucide-react";
import { clubClassLevelLabels, clubClassLevels } from "@/modules/club-rosters/domain";
import { honorOfferingSpanLabels, offeringPlacementPatch, sessionEditPatch } from "@/modules/honors/domain";
import { honorSetChange, honorsNeedConfirmationMessage } from "@/modules/honors/offering-honors";
import { HonorMultiSelect } from "@/components/honor-multi-select";
import { siteChangePatch } from "@/modules/honors/locations";
import type { HonorCopyPlan } from "@/modules/honors/copy";
import { groupSessionsBySite, nextSessionOrder, sessionClassWarning, sharedSessionsLabel } from "@/modules/honors/session-order";
import type { EventHonorSetup } from "@/modules/honors/repository";

type Offering = EventHonorSetup["offerings"][number];
type SetupSession = EventHonorSetup["sessions"][number];
type ApiResult = Partial<EventHonorSetup> & {
  error?: string;
  picks?: number;
  plan?: HonorCopyPlan;
  setup?: EventHonorSetup;
  message?: string;
  /** After adding or raising a class level or prerequisite: how many enrolled youth don't meet it (#832). */
  requirementImpact?: { offeringId: string; unmet: number };
  issues?: Array<{ message?: string }>;
};

function optionalNumber(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
}

/** Whole cents from a dollars text box; blank or zero means no additional cost. */
function dollarsToCents(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

export function HonorsSetupWorkspace({
  catalog,
  eventId,
  eventName,
  initialSetup,
  otherEvents,
}: {
  catalog: Array<{ id: string; code: string; name: string }>;
  eventId: string;
  eventName: string;
  initialSetup: EventHonorSetup;
  otherEvents: Array<{ id: string; name: string }>;
}) {
  const [setup, setSetup] = useState(initialSetup);
  const [newSessionSite, setNewSessionSite] = useState(initialSetup.locations.find((location) => location.isActive)?.id ?? "");
  const [span, setSpan] = useState<"SINGLE_SESSION" | "ALL_SESSIONS">("SINGLE_SESSION");
  const [editing, setEditing] = useState<Offering | null>(null);
  // The honors chosen for the class being added, and for the one being edited (#812); the first is the primary.
  const [newHonorIds, setNewHonorIds] = useState<string[]>([]);
  const [editHonorIds, setEditHonorIds] = useState<string[]>([]);
  // The honors a youth must have completed first (#832), for the class being added and the one being edited.
  const [newPrerequisiteIds, setNewPrerequisiteIds] = useState<string[]>([]);
  const [editPrerequisiteIds, setEditPrerequisiteIds] = useState<string[]>([]);
  const [editSpan, setEditSpan] = useState<"SINGLE_SESSION" | "ALL_SESSIONS">("SINGLE_SESSION");
  const [editingSession, setEditingSession] = useState<SetupSession | null>(null);
  const [copySource, setCopySource] = useState(otherEvents[0]?.id ?? "");
  const [plan, setPlan] = useState<HonorCopyPlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/events/${encodeURIComponent(eventId)}/honors`;

  // Sites in the location's sort order, sessions ordered within each site (#589).
  // An event without locations is one group, exactly as before.
  const hasSites = setup.locations.length > 0;
  const siteGroups = useMemo(() => groupSessionsBySite(setup.sessions, setup.locations), [setup.sessions, setup.locations]);
  const sessions = useMemo(() => siteGroups.flatMap((group) => group.sessions), [siteGroups]);
  const siteName = (locationId: string | null) => setup.locations.find((location) => location.id === locationId)?.name ?? null;
  const sessionSiteSuffix = (locationId: string | null) => (hasSites ? ` — ${siteName(locationId) ?? "No site"}` : "");

  const groups = useMemo(() => [
    // An all-sessions class is at its own site (#589): one "All sessions" group per site, in the sites' order.
    ...siteGroups.map((group) => ({
      key: `all-${group.location?.id ?? "none"}`,
      title: hasSites ? `All sessions — ${group.location?.name ?? "No site"}` : "All sessions",
      offerings: setup.offerings.filter((offering) => offering.span === "ALL_SESSIONS" && (offering.locationId ?? null) === (group.location?.id ?? null)),
    })),
    ...sessions.map((session) => ({
      key: session.id,
      title: `${session.name}${hasSites ? ` — ${setup.locations.find((location) => location.id === session.locationId)?.name ?? "No site"}` : ""}`,
      offerings: setup.offerings.filter((offering) => offering.sessionId === session.id),
    })),
  ], [setup, sessions, hasSites, siteGroups]);
  const hasActiveSites = setup.locations.some((location) => location.isActive !== false);

  const totalSeats = setup.offerings
    .filter((offering) => offering.isActive)
    .reduce((total, offering) => total + offering.capacity, 0);

  /**
   * `needsConfirmation` sees a failed response first; returning true means the
   * caller handles it (a delete that must first tell the person how many picks
   * it removes), so no error is shown.
   */
  async function call(
    url: string,
    method: string,
    body: unknown,
    success: string,
    needsConfirmation?: (result: ApiResult) => boolean,
  ) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok) {
        if (needsConfirmation?.(result)) return null;
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The change could not be saved.");
      }
      const next = result.setup ?? (result.sessions && result.offerings ? result as EventHonorSetup : null);
      if (next) setSetup({ locations: next.locations, sessions: next.sessions, offerings: next.offerings });
      const unmet = result.requirementImpact?.unmet ?? 0;
      if (success) {
        setNotice(unmet > 0 ? `${success} ${unmet === 1 ? "1 enrolled youth doesn't" : `${unmet} enrolled youth don't`} meet this; they keep ${unmet === 1 ? "their seat" : "their seats"}.` : success);
      }
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function addSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const result = await call(`${base}/sessions`, "POST", {
      name: String(form.get("name") ?? ""),
      // An empty Order takes the suggested next order for the site, never 0.
      sortOrder: optionalNumber(form.get("sortOrder"))
        ?? nextSessionOrder(setup.sessions.filter((session) => (session.locationId ?? "") === newSessionSite)),
      locationId: hasSites ? String(form.get("locationId") ?? "") || null : null,
    }, "Session added.");
    if (result) formElement.reset();
  }

  async function saveSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingSession) return;
    const form = new FormData(event.currentTarget);
    // Only what changed is sent, so a rename never carries (or clears) the site.
    const patch = sessionEditPatch(editingSession, {
      name: String(form.get("name") ?? ""),
      // An empty Order means unchanged, not 0.
      sortOrder: optionalNumber(form.get("sortOrder")) ?? editingSession.sortOrder,
      locationId: hasSites ? String(form.get("locationId") ?? "") || null : editingSession.locationId,
    });
    if (Object.keys(patch).length === 0) {
      setEditingSession(null);
      return;
    }
    const result = await call(`${base}/sessions/${encodeURIComponent(editingSession.id)}`, "PATCH", patch, "Session updated.");
    if (result) setEditingSession(null);
  }

  /**
   * Deleting asks once, then, when clubs have picked the class or session's
   * classes, asks again with the live count the server reports and re-sends
   * with that number as the confirmation. The server removes the picks only
   * when the number still matches.
   */
  async function confirmedDelete(url: string, label: string, success: string) {
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    const pending: { picks: number | null } = { picks: null };
    const needsConfirmation = (result: ApiResult) => {
      if (result.error !== "PICKS_NEED_CONFIRMATION" || typeof result.picks !== "number") return false;
      pending.picks = result.picks;
      return true;
    };
    let confirmed: number | null = null;
    // The count can change between asking and deleting (a club saved picks):
    // every time the server reports a different count, ask again with it.
    // Each confirmation the person gives is always followed by its request; at the limit the error replaces another question.
    for (let confirmations = 0; ; confirmations += 1) {
      pending.picks = null;
      const result = await call(
        confirmed === null ? url : `${url}?confirmPicks=${confirmed}`,
        "DELETE",
        undefined,
        success,
        needsConfirmation,
      );
      if (result || pending.picks === null) return result;
      if (confirmations >= 5) {
        setError("The number of class picks kept changing, so nothing was deleted. Try again.");
        return null;
      }
      const picks: number = pending.picks;
      if (!window.confirm(`${picks} class pick${picks === 1 ? "" : "s"} by clubs will be removed from their registrations. Delete ${label} anyway?`)) return null;
      confirmed = picks;
    }
  }

  async function removeSession(session: SetupSession) {
    const classes = session.offeringCount === 0 ? "" : ` and its ${session.offeringCount} class${session.offeringCount === 1 ? "" : "es"}`;
    const result = await confirmedDelete(`${base}/sessions/${encodeURIComponent(session.id)}`, `the session "${session.name}"${classes}`, "Session deleted.");
    if (result && editingSession?.id === session.id) setEditingSession(null);
  }

  async function removeOffering(offering: Offering) {
    const result = await confirmedDelete(`${base}/offerings/${encodeURIComponent(offering.id)}`, `the ${offering.honorName} class`, "Class deleted.");
    if (result && editing?.id === offering.id) setEditing(null);
  }

  async function saveOffering(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const details = {
      capacity: Number(form.get("capacity") ?? 0),
      minimumAge: optionalNumber(form.get("minimumAge")),
      minimumClassLevel: String(form.get("minimumClassLevel") ?? "") || null,
      prerequisiteHonorIds: editing ? editPrerequisiteIds : newPrerequisiteIds,
      perClubLimit: optionalNumber(form.get("perClubLimit")),
      teacherName: String(form.get("teacherName") ?? ""),
      location: String(form.get("location") ?? ""),
      additionalCostCents: dollarsToCents(form.get("additionalCost")),
      requirementNote: String(form.get("requirementNote") ?? ""),
      // Only an all-sessions class has its own site; a single-session class is at its session's.
      // Editing sends the site only when it changed (a legacy no-site class, or one with picks, keeps editing its other fields).
      ...(editing
        ? {
          ...offeringPlacementPatch(editing, {
            honorIds: editHonorIds,
            span: editSpan,
            // A disabled select (a class clubs picked) isn't submitted: fall back to the current session so it isn't read as a change.
            sessionId: editSpan === "SINGLE_SESSION" && !form.has("sessionId")
              ? editing.sessionId
              : String(form.get("sessionId") ?? "") || null,
          }),
          ...siteChangePatch(editing.locationId ?? null, form.get("locationId")),
        }
        : span === "ALL_SESSIONS" && hasSites ? { locationId: String(form.get("locationId") ?? "") || null } : {}),
    };
    if (!editing && newHonorIds.length === 0) {
      setError("Choose at least one honor for the class.");
      return;
    }
    if (editing && editHonorIds.length === 0) {
      setError("Choose at least one honor for the class.");
      return;
    }
    const result = editing
      ? await saveEditedOffering(editing, details)
      : await call(`${base}/offerings`, "POST", {
        honorIds: newHonorIds,
        span,
        sessionId: span === "SINGLE_SESSION" ? String(form.get("sessionId") ?? "") || null : null,
        ...details,
      }, "Class added.");
    if (result) {
      setEditing(null);
      setNewHonorIds([]);
      setNewPrerequisiteIds([]);
      formElement.reset();
    }
  }

  /**
   * Changing the honors of a class people are enrolled in asks first: "12 students are enrolled. They will now take:
   * Birds + Knots." The count is sent back as the confirmation, and the server refuses a stale one with the live
   * count, which is asked about again (#812).
   */
  async function saveEditedOffering(offering: Offering, details: Record<string, unknown>) {
    const url = `${base}/offerings/${encodeURIComponent(offering.id)}`;
    const names = editHonorIds.map((id) => honorOptions(offering).find((honor) => honor.id === id)?.name ?? id);
    const ask = (enrolled: number) => window.confirm(`${honorsNeedConfirmationMessage(enrolled, names)} Save this change?`);
    const changed = honorSetChange(offering.honorIds, editHonorIds).changed;
    let confirmed: number | undefined;
    if (changed && offering.enrolled > 0) {
      if (!ask(offering.enrolled)) return null;
      confirmed = offering.enrolled;
    }
    const pending: { enrolled: number | null } = { enrolled: null };
    const needsConfirmation = (result: ApiResult) => {
      if (result.error !== "HONORS_NEED_CONFIRMATION" || typeof result.picks !== "number") return false;
      pending.enrolled = result.picks;
      return true;
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      pending.enrolled = null;
      const result = await call(url, "PATCH", { ...details, ...(confirmed === undefined ? {} : { confirmEnrolled: confirmed }) }, "Class updated.", needsConfirmation);
      if (result || pending.enrolled === null) return result;
      if (!ask(pending.enrolled)) return null;
      confirmed = pending.enrolled;
    }
    setError("The number of enrolled people kept changing, so nothing was saved. Try again.");
    return null;
  }

  /** The catalog plus the honors the class already teaches, even ones the catalog has since turned off. */
  const honorOptions = (offering: Offering) => [
    ...catalog,
    ...offering.honors.filter((honor) => !catalog.some((entry) => entry.id === honor.id)),
  ];

  async function toggleOffering(offering: Offering) {
    await call(
      `${base}/offerings/${encodeURIComponent(offering.id)}`,
      "PATCH",
      { isActive: !offering.isActive },
      offering.isActive ? "Class deactivated." : "Class reactivated.",
    );
  }

  async function previewCopy() {
    setPlan(null);
    const result = await call(`${base}/copy`, "POST", { sourceEventId: copySource }, "");
    if (result?.plan) setPlan(result.plan);
  }

  async function applyCopy() {
    if (!plan) return;
    const result = await call(
      `${base}/copy`,
      "POST",
      { sourceEventId: plan.sourceEvent.id, fingerprint: plan.fingerprint },
      `Copied ${plan.createCount} classes from ${plan.sourceEvent.name}.`,
    );
    if (result) setPlan(null);
  }

  async function writeBackCompletions() {
    const result = await call(`${base}/completions`, "POST", undefined, "") as (ApiResult & { written?: number; alreadyRecorded?: number; skipped?: number }) | null;
    if (result && typeof result.written === "number") {
      setNotice(`Wrote ${result.written} completion${result.written === 1 ? "" : "s"} into members' honor records. ${result.alreadyRecorded ?? 0} already recorded. ${result.skipped ?? 0} skipped (not checked in, or not on the enrolling club's roster).`);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Honors Weekend</p>
          <h2 className="duplicate-page-title">{staffPageTitles.honors}</h2>
          <p>
            Name this site&apos;s sessions, then add the classes it teaches. A class can teach one honor or several. Capacity
            counts youth seats only. Seats and sign-ups appear here once class
            selection opens.
          </p>
        </div>
        <div className="intro-actions">
          <span className="count-badge">{totalSeats} youth seats</span>
          <Link className="secondary-button" href={`/more/honors/rosters?event=${encodeURIComponent(eventId)}`}>
            <ClipboardList aria-hidden="true" size={15} /> Rosters
          </Link>
        </div>
      </div>

      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Step 1</p>
            <h2>Sessions</h2>
          </div>
          <span className="count-badge">{setup.sessions.length} sessions</span>
        </div>
        {siteGroups.filter((group) => group.sessions.length > 0).map((group) => (
          <div key={group.location?.id ?? "none"}>
            {hasSites && (
              <h3 className="honor-group-heading">
                <span translate="no">{group.location ? group.location.name : sharedSessionsLabel}</span>
                {group.location && group.location.isActive === false ? " (inactive)" : ""}
              </h3>
            )}
            <ul className="honor-session-list">
              {group.sessions.map((session) => (
                <li key={session.id}>
                  <CalendarRange aria-hidden="true" size={16} />
                  <strong>{session.name}</strong>
                  <small>{session.offeringCount} classes</small>
                  {sessionClassWarning(session) && (
                    <p className="honor-session-warning" role="status">
                      <TriangleAlert aria-hidden="true" size={14} /> {sessionClassWarning(session)}
                    </p>
                  )}
                  <button
                    aria-label={`Edit session ${session.name}`}
                    className="text-button"
                    disabled={saving}
                    onClick={() => { setEditingSession(session); setNotice(""); setError(""); }}
                    type="button"
                  >
                    <Pencil aria-hidden="true" size={13} /> Edit
                  </button>
                  <button
                    aria-label={`Delete session ${session.name}`}
                    className="text-button"
                    disabled={saving}
                    onClick={() => removeSession(session)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={13} /> Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {editingSession && (
          <form className="form-stack honor-inline-form" key={editingSession.id} onSubmit={saveSession}>
            <p className="eyebrow">Edit session</p>
            {hasSites && (
              <label>
                Site
                <select defaultValue={editingSession.locationId ?? ""} name="locationId" required={hasActiveSites && editingSession.locationId !== null}>
                  <option value="">{hasActiveSites ? "Choose a site" : "No site (shown to every site)"}</option>
                  {setup.locations.map((location) => (
                    <option key={location.id} value={location.id}>{location.name}{location.isActive ? "" : " (inactive)"}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Session name
              <input defaultValue={editingSession.name} maxLength={80} name="name" required />
            </label>
            <label>
              Order
              <input defaultValue={editingSession.sortOrder} max={99} min={0} name="sortOrder" type="number" />
            </label>
            <button className="primary-button" disabled={saving} type="submit">
              <Save aria-hidden="true" size={14} /> Save session
            </button>
            <button className="secondary-button" onClick={() => setEditingSession(null)} type="button">
              <X aria-hidden="true" size={14} /> Cancel
            </button>
          </form>
        )}
        <form className="form-stack honor-inline-form" onSubmit={addSession}>
          {hasSites && (
            <label>
              Site
              <select name="locationId" onChange={(event) => setNewSessionSite(event.target.value)} required={hasActiveSites} value={newSessionSite}>
                <option value="">{hasActiveSites ? "Choose a site" : "No site (shown to every site)"}</option>
                {setup.locations.map((location) => (
                  <option key={location.id} value={location.id}>{location.name}{location.isActive ? "" : " (inactive)"}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Session name
            <input maxLength={80} name="name" placeholder="e.g. Sabbath afternoon" required />
          </label>
          <label>
            Order
            <input
              defaultValue={nextSessionOrder(setup.sessions.filter((session) => (session.locationId ?? "") === newSessionSite))}
              key={newSessionSite}
              max={99}
              min={0}
              name="sortOrder"
              type="number"
            />
          </label>
          <button className="secondary-button" disabled={saving} type="submit">
            <Plus aria-hidden="true" size={14} /> Add session
          </button>
        </form>
      </section>

      <form className="panel form-stack" key={editing?.id ?? "new"} onSubmit={saveOffering}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Step 2</p>
            <h2>{editing ? `Edit ${editing.honorName}` : "Add a class"}</h2>
          </div>
          {editing && (
            <button className="secondary-button" onClick={() => setEditing(null)} type="button">
              <X aria-hidden="true" size={14} /> Cancel
            </button>
          )}
        </div>
        {editing && (
          <div className="form-grid two-column">
            <HonorMultiSelect label="Honors taught" onChange={setEditHonorIds} options={honorOptions(editing)} value={editHonorIds} />
            {editing.enrolled > 0 && (
              <p className="field-help">
                {editing.enrolled === 1 ? "1 person is" : `${editing.enrolled} people are`} enrolled. Adding an honor gives it to them; removing one takes it
                from them (unless it was already recorded as completed). You will be asked to confirm.
              </p>
            )}
            <label>
              Taught in
              <select disabled={editing.enrolled > 0} name="span" onChange={(event) => setEditSpan(event.target.value as typeof editSpan)} value={editSpan}>
                <option value="SINGLE_SESSION">{honorOfferingSpanLabels.SINGLE_SESSION}</option>
                <option value="ALL_SESSIONS">{honorOfferingSpanLabels.ALL_SESSIONS} (fills every session)</option>
              </select>
            </label>
            {editSpan === "SINGLE_SESSION" && (
              <label>
                Session
                <select defaultValue={editing.sessionId ?? ""} disabled={editing.enrolled > 0} name="sessionId" required>
                  <option value="">Choose a session</option>
                  {sessions.map((session) => (
                    <option key={session.id} value={session.id}>{session.name}{sessionSiteSuffix(session.locationId)}</option>
                  ))}
                </select>
              </label>
            )}
            {editing.enrolled > 0 && (
              <p className="field-help">Clubs have picked this class, so its session and span are fixed. Its seats, teacher and room can still change.</p>
            )}
          </div>
        )}
        {!editing && (
          <div className="form-grid two-column">
            <HonorMultiSelect label="Honors taught" onChange={setNewHonorIds} options={catalog} value={newHonorIds} />
            <label>
              Taught in
              <select name="span" onChange={(event) => setSpan(event.target.value as typeof span)} value={span}>
                <option value="SINGLE_SESSION">{honorOfferingSpanLabels.SINGLE_SESSION}</option>
                <option value="ALL_SESSIONS">{honorOfferingSpanLabels.ALL_SESSIONS} (fills every session)</option>
              </select>
            </label>
            {span === "ALL_SESSIONS" && hasSites && (
              <label>
                Site
                <select name="locationId" required={hasActiveSites}>
                  <option value="">{hasActiveSites ? "Choose a site" : "No site"}</option>
                  {setup.locations.map((location) => (
                    <option key={location.id} value={location.id}>{location.name}{location.isActive === false ? " (inactive)" : ""}</option>
                  ))}
                </select>
              </label>
            )}
            {span === "SINGLE_SESSION" && (
              <label>
                Session
                <select name="sessionId" required>
                  <option value="">Choose a session</option>
                  {sessions.map((session) => (
                    <option key={session.id} value={session.id}>{session.name}{sessionSiteSuffix(session.locationId)}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <div className="form-grid two-column">
          {editing && editSpan === "ALL_SESSIONS" && hasSites && (
            editing.span === "ALL_SESSIONS" && editing.enrolled > 0 ? (
              // Clubs have picked this class, so it can't move: show the site, don't ask for one.
              <p className="field-help" data-testid="class-site-readonly">
                Site: <strong translate="no">{siteName(editing.locationId) ?? "No site"}</strong> (fixed once clubs have picked this class)
              </p>
            ) : (
              <label>
                Site
                <select defaultValue={editing.locationId ?? ""} name="locationId" required={hasActiveSites && (editing.span === "SINGLE_SESSION" || editing.locationId !== null)}>
                  <option value="">{hasActiveSites ? "Choose a site" : "No site"}</option>
                  {setup.locations.map((location) => (
                    <option key={location.id} value={location.id}>{location.name}{location.isActive === false ? " (inactive)" : ""}</option>
                  ))}
                </select>
              </label>
            )
          )}
          <label>
            Youth seats
            <input defaultValue={editing?.capacity ?? ""} max={10000} min={0} name="capacity" required type="number" />
          </label>
          <label>
            Minimum age (optional)
            <input defaultValue={editing?.minimumAge ?? ""} max={99} min={0} name="minimumAge" type="number" />
          </label>
          <label>
            Minimum class level (optional)
            <select defaultValue={editing?.minimumClassLevel ?? ""} name="minimumClassLevel">
              <option value="">No minimum</option>
              {clubClassLevels.map((level) => (
                <option key={level} value={level}>{clubClassLevelLabels[level]} and up</option>
              ))}
            </select>
            <small className="field-help">Checked against the class level the director sets on the club roster. If it is missing, the director confirms.</small>
          </label>
          <label>
            Per-club limit (optional)
            <input defaultValue={editing?.perClubLimit ?? ""} max={1000} min={1} name="perClubLimit" type="number" />
          </label>
          <label>
            Teacher (optional)
            <input defaultValue={editing?.teacherName ?? ""} maxLength={120} name="teacherName" />
          </label>
          <label>
            Location (optional)
            <input defaultValue={editing?.location ?? ""} maxLength={120} name="location" />
          </label>
          <label>
            Additional cost in dollars (optional)
            <input defaultValue={editing?.additionalCostCents ? (editing.additionalCostCents / 100).toFixed(2) : ""} min={0.01} max={10000} name="additionalCost" step="0.01" type="number" />
          </label>
          <label>
            Special requirement (optional)
            <input defaultValue={editing?.requirementNote ?? ""} maxLength={200} name="requirementNote" placeholder="Bring a flashlight" />
          </label>
        </div>
        <div className="form-grid two-column">
          {editing
            ? <HonorMultiSelect label="Prerequisite honors (optional)" onChange={setEditPrerequisiteIds} options={[...catalog, ...editing.prerequisiteHonors.filter((honor) => !catalog.some((entry) => entry.id === honor.id))]} value={editPrerequisiteIds} />
            : <HonorMultiSelect label="Prerequisite honors (optional)" onChange={setNewPrerequisiteIds} options={catalog} value={newPrerequisiteIds} />}
          <p className="field-help">Youth must have these honors completed on their honor record to take the class. If no record is found, the director confirms.</p>
        </div>
        {catalog.length === 0 && !editing && (
          <p className="field-help">The honor catalog is empty. A system administrator adds honors under System management → Honor catalog.</p>
        )}
        <div>
          <button className="primary-button" disabled={saving} type="submit">
            {editing ? <Save aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
            {editing ? " Save class" : " Add class"}
          </button>
        </div>
      </form>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Offered at this site</p>
            <h2>Classes</h2>
          </div>
          <span className="count-badge">{setup.offerings.length} classes</span>
        </div>
        {setup.offerings.length === 0 ? (
          <div className="empty-state">
            <Award aria-hidden="true" size={27} />
            <h3>No classes yet</h3>
            <p>Add sessions and classes above, or copy them from another site below.</p>
          </div>
        ) : groups.filter((group) => group.offerings.length > 0).map((group) => (
          <div className="report-table-wrap honor-table-wrap" key={group.key}>
            <h3 className="honor-group-heading">{group.title}</h3>
            <table className="report-table roster-card-table">
              <thead>
                <tr>
                  <th>Honors</th>
                  <th>Youth seats taken</th>
                  <th>Min. age</th>
                  <th>Requires</th>
                  <th>Per club</th>
                  <th>Teacher</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {group.offerings.map((offering) => (
                  <tr key={offering.id}>
                    <td className="roster-card-name" data-label="Honors">
                      {/* One line per honor the class teaches (#812). */}
                      {offering.honors.map((honor) => (
                        <div key={honor.id}><strong>{honor.name}</strong> <small><code>{honor.code}</code></small></div>
                      ))}
                    </td>
                    <td data-label="Youth seats taken">
                      {offering.seatsTaken} / {offering.capacity}
                      {offering.enrolled > offering.seatsTaken && <><br /><small>+{offering.enrolled - offering.seatsTaken} without a seat</small></>}
                    </td>
                    <td data-label="Min. age">{offering.minimumAge ?? "—"}</td>
                    <td data-label="Requires">
                      {offering.minimumClassLevel === null && offering.prerequisiteHonors.length === 0 ? "—" : (
                        <>
                          {offering.minimumClassLevel !== null && <div>{clubClassLevelLabels[offering.minimumClassLevel]} and up</div>}
                          {offering.prerequisiteHonors.map((honor) => <div key={honor.id}><small>Needs <span translate="no">{honor.name}</span></small></div>)}
                        </>
                      )}
                    </td>
                    <td data-label="Per club">{offering.perClubLimit ?? "—"}</td>
                    <td data-label="Teacher" translate="no">{offering.teacherName || "—"}</td>
                    <td data-label="Location">{offering.location || "—"}</td>
                    <td data-label="Status">
                      <span className={`status-chip ${offering.isActive ? "green" : "gold"}`}>
                        {offering.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="honor-row-actions roster-card-actions">
                      <button
                        aria-label={`Edit ${offering.honorName}`}
                        className="secondary-button"
                        disabled={saving}
                        onClick={() => { setEditing(offering); setEditHonorIds(offering.honorIds); setEditPrerequisiteIds(offering.prerequisiteHonorIds); setEditSpan(offering.span); setNotice(""); setError(""); }}
                        type="button"
                      >
                        <Pencil aria-hidden="true" size={13} />
                      </button>
                      <button
                        aria-label={`${offering.isActive ? "Deactivate" : "Reactivate"} ${offering.honorName}`}
                        className="secondary-button"
                        disabled={saving}
                        onClick={() => toggleOffering(offering)}
                        type="button"
                      >
                        <Power aria-hidden="true" size={13} />
                      </button>
                      <button
                        aria-label={`Delete ${offering.honorName}`}
                        className="secondary-button"
                        disabled={saving}
                        onClick={() => removeOffering(offering)}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section className="panel form-stack">
        <div className="section-heading">
          <div>
            <p className="eyebrow">After the weekend</p>
            <h2>Write back completions</h2>
          </div>
        </div>
        <p className="field-help">
          Adds each checked-in youth&apos;s classes to their year-round honor record, so the
          club&apos;s order list picks them up. Safe to run again: a class already written back
          is never added twice.
        </p>
        <div>
          <button className="secondary-button" disabled={saving} onClick={writeBackCompletions} type="button">
            <Award aria-hidden="true" size={14} /> Write back completions
          </button>
        </div>
      </section>

      {otherEvents.length > 0 && (
        <section className="panel form-stack">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Save time</p>
              <h2>Copy from another site</h2>
            </div>
          </div>
          <p className="field-help">
            Copies that site&apos;s sessions and active classes into {eventName}. You review
            everything first. Nothing already set up here is changed or replaced.
          </p>
          <div className="honor-inline-form">
            <label>
              Copy from
              <select onChange={(event) => { setCopySource(event.target.value); setPlan(null); }} value={copySource}>
                {otherEvents.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                ))}
              </select>
            </label>
            <button className="secondary-button" disabled={saving || !copySource} onClick={previewCopy} type="button">
              <Copy aria-hidden="true" size={14} /> Preview copy
            </button>
          </div>
          {plan && (
            <div className="form-stack">
              <p>
                <strong>{plan.createCount}</strong> classes will be copied and{" "}
                <strong>{plan.skipCount}</strong> skipped.{" "}
                {plan.sessions.filter((session) => session.action === "CREATE").length} new sessions will be added.
              </p>
              {plan.warnings.length > 0 && (
                <div className="inline-notice error" role="status">
                  <TriangleAlert aria-hidden="true" size={14} /> <strong>Some sessions will have no site.</strong>
                  <ul>{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                </div>
              )}
              <div className="report-table-wrap">
                <table className="report-table">
                  <thead>
                    <tr><th>Honor</th><th>Session</th><th>Youth seats</th><th>Result</th></tr>
                  </thead>
                  <tbody>
                    {plan.offerings.map((row) => (
                      <tr key={row.sourceOfferingId}>
                        <td>{row.honorName} <small><code>{row.honorCode}</code></small></td>
                        <td>{row.sessionName ?? honorOfferingSpanLabels.ALL_SESSIONS}</td>
                        <td>{row.capacity}</td>
                        <td>
                          {row.action === "CREATE"
                            ? <span className="status-chip green">Will copy</span>
                            : <><span className="status-chip gold">Skipped</span> <small>{row.reason}</small></>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <button className="primary-button" disabled={saving || (plan.createCount === 0 && plan.sessions.every((session) => session.action === "EXISTS"))} onClick={applyCopy} type="button">
                  <Copy aria-hidden="true" size={16} /> Copy {plan.createCount} classes
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
