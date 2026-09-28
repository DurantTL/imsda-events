"use client";

import Link from "next/link";
import { useState } from "react";
import type { EventTemplateRecord } from "@/modules/event-templates/repository";

type EventTemplateListProps = {
  initialTemplates: EventTemplateRecord[];
};

const statusLabel: Record<string, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export function EventTemplateList({ initialTemplates }: EventTemplateListProps) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [audience, setAudience] = useState<"GENERAL" | "CLUB">("GENERAL");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function createTemplate() {
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/event-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, audience }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The template could not be created.");
      setTemplates((current) => [body.template, ...current]);
      setName("");
      setDescription("");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The template could not be created.");
    } finally {
      setCreating(false);
    }
  }

  async function archiveTemplate(templateId: string) {
    setError("");
    try {
      const response = await fetch(`/api/event-templates/${templateId}/archive`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The template could not be archived.");
      setTemplates((current) => current.map((template) => (template.id === templateId ? body.template : template)));
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "The template could not be archived.");
    }
  }

  return (
    <div className="page-stack event-settings-workspace">
      {error ? <div className="inline-notice error" role="alert">{error}</div> : null}

      <section className="panel form-stack event-settings-panel">
        <div className="section-heading"><div><h2>New template</h2></div></div>
        <div className="form-grid two-column">
          <label>Name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Weekend retreat" />
          </label>
          <label>Audience
            <select value={audience} onChange={(event) => setAudience(event.target.value as "GENERAL" | "CLUB")}>
              <option value="GENERAL">General</option>
              <option value="CLUB">Club</option>
            </select>
          </label>
        </div>
        <label>Description
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
        </label>
        <button type="button" className="primary-button" disabled={creating || name.trim().length < 2} onClick={createTemplate}>
          {creating ? "Creating…" : "Create template"}
        </button>
      </section>

      <section className="panel form-stack event-settings-panel">
        <div className="section-heading"><div><h2>Templates</h2></div></div>
        {templates.length === 0 ? <p>No event templates yet.</p> : (
          <ul>
            {templates.map((template) => (
              <li key={template.id}>
                <div>
                  <strong>{template.name}</strong>{" "}
                  ({statusLabel[template.status] ?? template.status}, {template.audience === "CLUB" ? "Club" : "General"})
                </div>
                <p>{template.description || "No description."}</p>
                <Link className="secondary-button" href={`/admin/event-templates/${template.id}`}>Edit</Link>{" "}
                {template.status !== "ARCHIVED" ? (
                  <button type="button" className="secondary-button" onClick={() => archiveTemplate(template.id)}>Archive</button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
