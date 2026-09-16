"use client";

import { useState } from "react";

type TagRow = { id: string; name: string; color: string; description: string; isActive: boolean };

async function responseJson(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? "The tag could not be saved.");
  return body;
}

export function TagConfigurationWorkspace({
  eventId,
  eventName,
  initialTags,
}: {
  eventId: string;
  eventName: string;
  initialTags: TagRow[];
}) {
  const [tags, setTags] = useState(initialTags);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function addTag(form: FormData) {
    setSaving(true); setError("");
    try {
      const body = await responseJson(await fetch(`/api/events/${eventId}/tags`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          color: form.get("color"),
          description: form.get("description") ?? "",
          isActive: true,
        }),
      }));
      setTags((current) => [...current, body.tag].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The tag could not be saved."); }
    finally { setSaving(false); }
  }

  async function updateTag(row: TagRow, patch: Partial<TagRow>) {
    setSaving(true); setError("");
    try {
      const body = await responseJson(await fetch(`/api/events/${eventId}/tags/${row.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...row, ...patch }),
      }));
      setTags((current) => current.map((candidate) => candidate.id === row.id ? body.tag : candidate));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The tag could not be updated."); }
    finally { setSaving(false); }
  }

  return <div className="settings-stack">
    <div className="page-intro"><div><p className="eyebrow">Event configuration</p><h2>Tags</h2><p>Configure the tag vocabulary staff can apply to registrations and attendees for {eventName}. Free-text tags are not supported — every tag is defined here first, so filters and reports stay consistent.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="panel">
      <div className="section-heading"><div><h2>Configured tags</h2><p>Deactivating a tag hides it from new assignments; it stays visible on anything already tagged.</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>Color</th><th>Name</th><th>Description</th><th>Status</th><th /></tr></thead><tbody>{tags.map((row) => <tr key={row.id}>
        <td><input aria-label={`Color for ${row.name}`} type="color" value={row.color} onChange={(event) => setTags((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, color: event.target.value } : candidate))} /></td>
        <td><input aria-label={`Name for ${row.name}`} value={row.name} onChange={(event) => setTags((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, name: event.target.value } : candidate))} /></td>
        <td><input aria-label={`Description for ${row.name}`} value={row.description} onChange={(event) => setTags((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, description: event.target.value } : candidate))} /></td>
        <td>{row.isActive ? "Active" : "Inactive"}</td>
        <td><span className="form-actions"><button className="secondary-button" disabled={saving} type="button" onClick={() => updateTag(row, {})}>Save</button><button className="secondary-button" disabled={saving} type="button" onClick={() => updateTag(row, { isActive: !row.isActive })}>{row.isActive ? "Deactivate" : "Activate"}</button></span></td>
      </tr>)}</tbody></table></div>
      <form className="form-stack inset-form" action={addTag}>
        <div className="form-grid two-column"><label>Name<input name="name" required placeholder="VIP" /></label><label>Color<input name="color" type="color" defaultValue="#4F46E5" /></label></div>
        <label>Description<input name="description" /></label>
        <button className="primary-button" disabled={saving} type="submit">Add tag</button>
      </form>
    </section>
  </div>;
}
