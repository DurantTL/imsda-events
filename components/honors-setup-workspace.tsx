"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Award, CalendarRange, ClipboardList, Copy, Pencil, Plus, Power, Save, Trash2, X } from "lucide-react";
import { honorOfferingSpanLabels } from "@/modules/honors/domain";
import type { HonorCopyPlan } from "@/modules/honors/copy";
import type { EventHonorSetup } from "@/modules/honors/repository";

type Offering = EventHonorSetup["offerings"][number];
type ApiResult = Partial<EventHonorSetup> & {
  plan?: HonorCopyPlan;
  setup?: EventHonorSetup;
  message?: string;
  issues?: Array<{ message?: string }>;
};

function optionalNumber(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
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
  const [span, setSpan] = useState<"SINGLE_SESSION" | "ALL_SESSIONS">("SINGLE_SESSION");
  const [editing, setEditing] = useState<Offering | null>(null);
  const [copySource, setCopySource] = useState(otherEvents[0]?.id ?? "");
  const [plan, setPlan] = useState<HonorCopyPlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/events/${encodeURIComponent(eventId)}/honors`;

  const groups = useMemo(() => [
    { key: "all", title: "All sessions", offerings: setup.offerings.filter((offering) => offering.span === "ALL_SESSIONS") },
    ...setup.sessions.map((session) => ({
      key: session.id,
      title: session.name,
      offerings: setup.offerings.filter((offering) => offering.sessionId === session.id),
    })),
  ], [setup]);

  const totalSeats = setup.offerings
    .filter((offering) => offering.isActive)
    .reduce((total, offering) => total + offering.capacity, 0);

  async function call(url: string, method: string, body: unknown, success: string) {
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
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The change could not be saved.");
      }
      const next = result.setup ?? (result.sessions && result.offerings ? result as EventHonorSetup : null);
      if (next) setSetup({ sessions: next.sessions, offerings: next.offerings });
      if (success) setNotice(success);
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
      sortOrder: Number(form.get("sortOrder") ?? 0),
    }, "Session added.");
    if (result) formElement.reset();
  }

  async function renameSession(sessionId: string, current: string) {
    const name = window.prompt("Session name", current);
    if (name === null || name.trim() === current) return;
    await call(`${base}/sessions/${encodeURIComponent(sessionId)}`, "PATCH", { name }, "Session renamed.");
  }

  async function removeSession(sessionId: string, name: string) {
    if (!window.confirm(`Remove the empty session "${name}"?`)) return;
    await call(`${base}/sessions/${encodeURIComponent(sessionId)}`, "DELETE", undefined, "Session removed.");
  }

  async function saveOffering(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const details = {
      capacity: Number(form.get("capacity") ?? 0),
      minimumAge: optionalNumber(form.get("minimumAge")),
      perClubLimit: optionalNumber(form.get("perClubLimit")),
      teacherName: String(form.get("teacherName") ?? ""),
      location: String(form.get("location") ?? ""),
    };
    const result = editing
      ? await call(`${base}/offerings/${encodeURIComponent(editing.id)}`, "PATCH", details, "Class updated.")
      : await call(`${base}/offerings`, "POST", {
        honorId: String(form.get("honorId") ?? ""),
        span,
        sessionId: span === "SINGLE_SESSION" ? String(form.get("sessionId") ?? "") || null : null,
        ...details,
      }, "Class added.");
    if (result) {
      setEditing(null);
      formElement.reset();
    }
  }

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

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Honors Weekend</p>
          <h2>Classes for {eventName}</h2>
          <p>
            Name this site&apos;s sessions, then add the honors it teaches. Capacity
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
        {setup.sessions.length > 0 && (
          <ul className="honor-session-list">
            {setup.sessions.map((session) => (
              <li key={session.id}>
                <CalendarRange aria-hidden="true" size={16} />
                <strong>{session.name}</strong>
                <small>{session.offeringCount} classes</small>
                <button className="text-button" disabled={saving} onClick={() => renameSession(session.id, session.name)} type="button">
                  <Pencil aria-hidden="true" size={13} /> Rename
                </button>
                {session.offeringCount === 0 && (
                  <button className="text-button" disabled={saving} onClick={() => removeSession(session.id, session.name)} type="button">
                    <Trash2 aria-hidden="true" size={13} /> Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form className="form-stack honor-inline-form" onSubmit={addSession}>
          <label>
            Session name
            <input maxLength={80} name="name" placeholder="e.g. Sabbath afternoon" required />
          </label>
          <label>
            Order
            <input defaultValue={setup.sessions.length} max={99} min={0} name="sortOrder" type="number" />
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
        {!editing && (
          <div className="form-grid two-column">
            <label>
              Honor
              <select name="honorId" required>
                <option value="">Choose an honor</option>
                {catalog.map((honor) => (
                  <option key={honor.id} value={honor.id}>{honor.name} ({honor.code})</option>
                ))}
              </select>
            </label>
            <label>
              Taught in
              <select name="span" onChange={(event) => setSpan(event.target.value as typeof span)} value={span}>
                <option value="SINGLE_SESSION">{honorOfferingSpanLabels.SINGLE_SESSION}</option>
                <option value="ALL_SESSIONS">{honorOfferingSpanLabels.ALL_SESSIONS} (fills every session)</option>
              </select>
            </label>
            {span === "SINGLE_SESSION" && (
              <label>
                Session
                <select name="sessionId" required>
                  <option value="">Choose a session</option>
                  {setup.sessions.map((session) => (
                    <option key={session.id} value={session.id}>{session.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <div className="form-grid two-column">
          <label>
            Youth seats
            <input defaultValue={editing?.capacity ?? ""} max={10000} min={0} name="capacity" required type="number" />
          </label>
          <label>
            Minimum age (optional)
            <input defaultValue={editing?.minimumAge ?? ""} max={99} min={0} name="minimumAge" type="number" />
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
          <div className="report-table-wrap" key={group.key}>
            <h3 className="honor-group-heading">{group.title}</h3>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Honor</th>
                  <th>Youth seats taken</th>
                  <th>Min. age</th>
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
                    <td><strong>{offering.honorName}</strong><br /><small><code>{offering.honorCode}</code></small></td>
                    <td>
                      {offering.seatsTaken} / {offering.capacity}
                      {offering.enrolled > offering.seatsTaken && <><br /><small>+{offering.enrolled - offering.seatsTaken} without a seat</small></>}
                    </td>
                    <td>{offering.minimumAge ?? "—"}</td>
                    <td>{offering.perClubLimit ?? "—"}</td>
                    <td translate="no">{offering.teacherName || "—"}</td>
                    <td>{offering.location || "—"}</td>
                    <td>
                      <span className={`status-chip ${offering.isActive ? "green" : "gold"}`}>
                        {offering.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="honor-row-actions">
                      <button
                        aria-label={`Edit ${offering.honorName}`}
                        className="secondary-button"
                        disabled={saving}
                        onClick={() => { setEditing(offering); setNotice(""); setError(""); }}
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
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
