"use client";

import { useState } from "react";
import { Award, Pencil, Plus, Save, X } from "lucide-react";
import type { HonorRecord } from "@/modules/honors/repository";

type CatalogResponse = { honors?: HonorRecord[]; message?: string; issues?: Array<{ message?: string }> };

export function HonorCatalogWorkspace({ initialHonors }: { initialHonors: HonorRecord[] }) {
  const [honors, setHonors] = useState(initialHonors);
  const [editing, setEditing] = useState<HonorRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("");

  const query = filter.trim().toLowerCase();
  const visible = query
    ? honors.filter((honor) => `${honor.code} ${honor.name}`.toLowerCase().includes(query))
    : honors;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        editing ? `/api/admin/honors/${encodeURIComponent(editing.id)}` : "/api/admin/honors",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: String(form.get("code") ?? ""),
            name: String(form.get("name") ?? ""),
            description: String(form.get("description") ?? ""),
            isActive: form.get("isActive") === "on",
          }),
        },
      );
      const result = await response.json().catch(() => ({})) as CatalogResponse;
      if (!response.ok || !result.honors) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The honor could not be saved.");
      }
      setHonors(result.honors);
      setNotice(editing ? "Honor updated." : "Honor added to the catalog.");
      setEditing(null);
      formElement.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The honor could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Club ministries</p>
          <h2>Honor catalog</h2>
          <p>
            One list of honors that every Honors Weekend site offers from. Each
            site then chooses its sessions, classes, and seats under More → Honors
            Weekend classes.
          </p>
        </div>
      </div>

      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      <form className="panel form-stack" key={editing?.id ?? "new"} onSubmit={save}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">{editing ? "Edit honor" : "New honor"}</p>
            <h2>{editing ? editing.name : "Add an honor"}</h2>
          </div>
          {editing && (
            <button className="secondary-button" onClick={() => setEditing(null)} type="button">
              <X aria-hidden="true" size={14} /> Cancel
            </button>
          )}
        </div>
        <div className="form-grid two-column">
          <label>
            Code
            <input defaultValue={editing?.code ?? ""} maxLength={40} name="code" placeholder="e.g. AR-011" required />
          </label>
          <label>
            Name
            <input defaultValue={editing?.name ?? ""} maxLength={120} name="name" required />
          </label>
        </div>
        <label>
          Description (optional)
          <textarea defaultValue={editing?.description ?? ""} maxLength={2000} name="description" rows={2} />
        </label>
        <label className="checkbox-label">
          <input defaultChecked={editing?.isActive ?? true} name="isActive" type="checkbox" /> Active (can be offered at sites)
        </label>
        <div>
          <button className="primary-button" disabled={saving} type="submit">
            {editing ? <Save aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
            {editing ? " Save honor" : " Add honor"}
          </button>
        </div>
      </form>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Catalog</p>
            <h2>Honors</h2>
          </div>
          <span className="count-badge">{honors.length} honors</span>
        </div>
        {honors.length === 0 ? (
          <div className="empty-state">
            <Award aria-hidden="true" size={27} />
            <h3>No honors yet</h3>
            <p>Add the honors from last year&apos;s class list to get started.</p>
          </div>
        ) : (
          <>
            <label className="form-stack">
              <span className="sr-only">Filter honors</span>
              <input
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by code or name"
                type="search"
                value={filter}
              />
            </label>
            <div className="report-table-wrap">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Offered at sites</th>
                    <th><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((honor) => (
                    <tr key={honor.id}>
                      <td><code>{honor.code}</code></td>
                      <td>
                        <strong>{honor.name}</strong>
                        {honor.description && <><br /><small>{honor.description}</small></>}
                      </td>
                      <td>
                        <span className={`status-chip ${honor.isActive ? "green" : "gold"}`}>
                          {honor.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>{honor.offeringCount}</td>
                      <td>
                        <button
                          aria-label={`Edit ${honor.name}`}
                          className="secondary-button"
                          onClick={() => { setEditing(honor); setNotice(""); setError(""); }}
                          type="button"
                        >
                          <Pencil aria-hidden="true" size={14} /> Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </section>
  );
}
