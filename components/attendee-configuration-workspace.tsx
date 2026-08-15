"use client";

import { useState } from "react";

type AttendeeTypeRow = {
  id: string; code: string; label: string; description: string; sortOrder: number;
  isActive: boolean; minimumAge: number | null; maximumAge: number | null;
};
type ClassificationRow = {
  id: string; kind: "CATEGORY" | "TRACK" | "DEPARTMENT"; code: string; label: string;
  description: string; sortOrder: number; isActive: boolean;
};

async function responseJson(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? "The configuration could not be saved.");
  return body;
}

export function AttendeeConfigurationWorkspace({
  eventId,
  eventName,
  initialTypes,
  initialClassifications,
}: {
  eventId: string;
  eventName: string;
  initialTypes: AttendeeTypeRow[];
  initialClassifications: ClassificationRow[];
}) {
  const [types, setTypes] = useState(initialTypes);
  const [classifications, setClassifications] = useState(initialClassifications);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function addType(form: FormData) {
    setSaving(true); setError("");
    try {
      const body = await responseJson(await fetch(`/api/events/${eventId}/attendee-types`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: form.get("code"), label: form.get("label"), description: form.get("description"),
          sortOrder: Number(form.get("sortOrder") ?? 0), isActive: true,
          minimumAge: form.get("minimumAge") === "" ? null : Number(form.get("minimumAge")),
          maximumAge: form.get("maximumAge") === "" ? null : Number(form.get("maximumAge")),
        }),
      }));
      setTypes((current) => [...current, body.attendeeType].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The attendee type could not be saved."); }
    finally { setSaving(false); }
  }

  async function updateType(row: AttendeeTypeRow, patch: Partial<AttendeeTypeRow>) {
    setSaving(true); setError("");
    try {
      const body = await responseJson(await fetch(`/api/events/${eventId}/attendee-types/${row.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...row, ...patch }),
      }));
      setTypes((current) => current.map((candidate) => candidate.id === row.id ? body.attendeeType : candidate));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The attendee type could not be updated."); }
    finally { setSaving(false); }
  }

  async function addClassification(form: FormData) {
    setSaving(true); setError("");
    try {
      const body = await responseJson(await fetch(`/api/events/${eventId}/attendee-classifications`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: form.get("kind"), code: form.get("code"), label: form.get("label"), description: "", sortOrder: 0, isActive: true }),
      }));
      setClassifications((current) => [...current, body.classification]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The classification could not be saved."); }
    finally { setSaving(false); }
  }

  async function updateClassification(row: ClassificationRow, patch: Partial<ClassificationRow>) {
    setSaving(true); setError("");
    try {
      const body = await responseJson(await fetch(`/api/events/${eventId}/attendee-classifications/${row.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...row, ...patch }),
      }));
      setClassifications((current) => current.map((candidate) => candidate.id === row.id ? body.classification : candidate));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The classification could not be updated."); }
    finally { setSaving(false); }
  }

  function toggleClassification(row: ClassificationRow) {
    return updateClassification(row, { isActive: !row.isActive });
  }

  return <div className="settings-stack">
    <div className="page-intro"><div><p className="eyebrow">Event configuration</p><h2>Attendee types and groupings</h2><p>Configure stable attendee identities and orthogonal categories, tracks, and departments for {eventName}.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="panel"><div className="section-heading"><div><h2>Attendee types</h2><p>Codes are permanent identities. Labels, descriptions, sort order, age bands, and active status may be edited; prior registration snapshots remain unchanged.</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>Code</th><th>Label</th><th>Description</th><th>Sort order</th><th>Age band</th><th>Status</th><th /></tr></thead><tbody>{types.map((row) => <tr key={row.id}>
        <td><code>{row.code}</code></td>
        <td><input aria-label={`Label for ${row.code}`} value={row.label} onChange={(event) => setTypes((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, label: event.target.value } : candidate))} /></td>
        <td><input aria-label={`Description for ${row.code}`} value={row.description} onChange={(event) => setTypes((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, description: event.target.value } : candidate))} /></td>
        <td><input aria-label={`Sort order for ${row.code}`} min="-10000" max="10000" type="number" value={row.sortOrder} onChange={(event) => setTypes((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, sortOrder: Number(event.target.value) } : candidate))} /></td>
        <td><span className="form-grid two-column"><input aria-label={`Minimum age for ${row.code}`} min="0" max="130" type="number" value={row.minimumAge ?? ""} onChange={(event) => setTypes((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, minimumAge: event.target.value === "" ? null : Number(event.target.value) } : candidate))} /><input aria-label={`Maximum age for ${row.code}`} min="0" max="130" type="number" value={row.maximumAge ?? ""} onChange={(event) => setTypes((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, maximumAge: event.target.value === "" ? null : Number(event.target.value) } : candidate))} /></span></td>
        <td>{row.isActive ? "Active" : "Inactive"}</td>
        <td><span className="form-actions"><button className="secondary-button" disabled={saving} type="button" onClick={() => updateType(row, {})}>Save</button><button className="secondary-button" disabled={saving} type="button" onClick={() => updateType(row, { isActive: !row.isActive })}>{row.isActive ? "Deactivate" : "Activate"}</button></span></td>
      </tr>)}</tbody></table></div>
      <form className="form-stack inset-form" action={addType}><div className="form-grid two-column"><label>Permanent code<input name="code" required placeholder="ADULT" /></label><label>Display label<input name="label" required placeholder="Adult" /></label></div><label>Description<input name="description" /></label><div className="form-grid three-column"><label>Minimum age<input name="minimumAge" min="0" max="130" type="number" /></label><label>Maximum age<input name="maximumAge" min="0" max="130" type="number" /></label><label>Sort order<input name="sortOrder" defaultValue="0" type="number" /></label></div><button className="primary-button" disabled={saving} type="submit">Add attendee type</button></form>
    </section>
    <section className="panel"><div className="section-heading"><div><h2>Categories, tracks, and departments</h2><p>These are independent of attendee type; an attendee may be assigned several. Codes and dimension are permanent once created.</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>Dimension</th><th>Code</th><th>Label</th><th>Description</th><th>Sort order</th><th>Status</th><th /></tr></thead><tbody>{classifications.map((row) => <tr key={row.id}>
        <td>{row.kind.toLowerCase()}</td>
        <td><code>{row.code}</code></td>
        <td><input aria-label={`Label for ${row.code}`} value={row.label} onChange={(event) => setClassifications((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, label: event.target.value } : candidate))} /></td>
        <td><input aria-label={`Description for ${row.code}`} value={row.description} onChange={(event) => setClassifications((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, description: event.target.value } : candidate))} /></td>
        <td><input aria-label={`Sort order for ${row.code}`} min="-10000" max="10000" type="number" value={row.sortOrder} onChange={(event) => setClassifications((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, sortOrder: Number(event.target.value) } : candidate))} /></td>
        <td>{row.isActive ? "Active" : "Inactive"}</td>
        <td><span className="form-actions"><button className="secondary-button" disabled={saving} type="button" onClick={() => updateClassification(row, {})}>Save</button><button className="secondary-button" disabled={saving} type="button" onClick={() => toggleClassification(row)}>{row.isActive ? "Deactivate" : "Activate"}</button></span></td>
      </tr>)}</tbody></table></div>
      <form className="form-stack inset-form" action={addClassification}><div className="form-grid three-column"><label>Dimension<select name="kind"><option value="CATEGORY">Category</option><option value="TRACK">Track</option><option value="DEPARTMENT">Department</option></select></label><label>Permanent code<input name="code" required placeholder="WORSHIP" /></label><label>Display label<input name="label" required placeholder="Worship" /></label></div><button className="primary-button" disabled={saving} type="submit">Add grouping</button></form>
    </section>
  </div>;
}
