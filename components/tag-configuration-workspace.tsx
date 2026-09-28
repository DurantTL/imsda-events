"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import Link from "next/link";
import { Info } from "lucide-react";

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
  // Review before deactivating a tag (#471): this is the closest thing to
  // "removing" one — tags are never deleted, only taken out of new
  // assignments — so it gets the same confirm as the other removal actions.
  const [deactivateTarget, setDeactivateTarget] = useState<TagRow | null>(null);

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

  function openDeactivate(row: TagRow) {
    // A leftover page error must not appear inside the new dialog.
    setError("");
    setDeactivateTarget(row);
  }

  async function updateTag(row: TagRow, patch: Partial<TagRow>) {
    setSaving(true); setError("");
    try {
      const body = await responseJson(await fetch(`/api/events/${eventId}/tags/${row.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...row, ...patch }),
      }));
      setTags((current) => current.map((candidate) => candidate.id === row.id ? body.tag : candidate));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The tag could not be updated.");
      return false;
    } finally { setSaving(false); }
  }

  return <div className="settings-stack">
    <div className="page-intro"><div><p className="eyebrow">Event configuration</p><h2>Tags</h2><p>Configure the tag vocabulary staff can apply to registrations for {eventName}. Free-text tags are not supported — every tag is defined here first, so tagging stays consistent.</p></div></div>
    <p className="usage-note"><Info aria-hidden="true" size={16} /><span>Where this shows up: staff add or remove these tags from a registration&rsquo;s notes &amp; tags panel in <Link href={`/people?event=${eventId}`}>People</Link>.</span></p>
    {/* While the deactivate dialog is open, its own alert shows the error; one announcement, not two. */}
    {error && !deactivateTarget && <p className="form-error" role="alert">{error}</p>}
    <section className="panel">
      <div className="section-heading"><div><h2>Configured tags</h2><p>Deactivating a tag hides it from new assignments; it stays visible on anything already tagged.</p></div></div>
      <div className="table-wrap"><table className="editable-settings-table"><thead><tr><th>Color</th><th>Name</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead><tbody>{tags.map((row) => <tr key={row.id}>
        <td data-label="Color"><input aria-label={`Color for ${row.name}`} type="color" value={row.color} onChange={(event) => setTags((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, color: event.target.value } : candidate))} /></td>
        <td data-label="Name"><input aria-label={`Name for ${row.name}`} value={row.name} onChange={(event) => setTags((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, name: event.target.value } : candidate))} /></td>
        <td data-label="Description"><input aria-label={`Description for ${row.name}`} value={row.description} onChange={(event) => setTags((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, description: event.target.value } : candidate))} /></td>
        <td data-label="Status">{row.isActive ? "Active" : "Inactive"}</td>
        <td data-label="Actions"><span className="form-actions"><button className="secondary-button" disabled={saving} type="button" onClick={() => updateTag(row, {})}>Save</button><button className="secondary-button" disabled={saving} type="button" onClick={() => row.isActive ? openDeactivate(row) : updateTag(row, { isActive: true })}>{row.isActive ? "Deactivate" : "Activate"}</button></span></td>
      </tr>)}</tbody></table></div>
      <form className="form-stack inset-form" action={addTag}>
        <div className="form-grid two-column"><label>Name<input name="name" required placeholder="VIP" /></label><label>Color<input name="color" type="color" defaultValue="#4F46E5" /></label></div>
        <label>Description<input name="description" /></label>
        <button className="primary-button" disabled={saving} type="submit">Add tag</button>
      </form>
    </section>

    <ConfirmDialog
      busy={saving}
      busyLabel="Deactivating…"
      confirmLabel="Deactivate tag"
      error={error}
      onCancel={() => setDeactivateTarget(null)}
      onConfirm={() => {
        if (!deactivateTarget) return;
        void updateTag(deactivateTarget, { isActive: false }).then((ok) => {
          if (ok) setDeactivateTarget(null);
        });
      }}
      open={deactivateTarget !== null}
      title={deactivateTarget ? `Deactivate "${deactivateTarget.name}"?` : "Deactivate tag?"}
    >
      <p>
        This tag is removed from new assignments right away. It stays visible, unchanged, on every
        registration and attendee already tagged with it, and can be reactivated at any time.
      </p>
    </ConfirmDialog>
  </div>;
}
