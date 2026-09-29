"use client";

import Link from "next/link";
import { useState } from "react";
import type { EventTemplateRecord } from "@/modules/event-templates/repository";
import type { StarterTemplatesResult } from "@/modules/event-templates/starter-repository";
import { pendingStarterEvents, starterEventTemplates } from "@/modules/event-templates/starters";

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
  const [addingStarters, setAddingStarters] = useState(false);
  const [starterResult, setStarterResult] = useState<StarterTemplatesResult | null>(null);

  async function addStarterTemplates() {
    setAddingStarters(true);
    setError("");
    try {
      const response = await fetch("/api/event-templates/starters", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The starter templates could not be added.");
      setStarterResult(body as StarterTemplatesResult);
      const listResponse = await fetch("/api/event-templates");
      const listBody = await listResponse.json();
      if (listResponse.ok) setTemplates(listBody.templates);
    } catch (startersError) {
      setError(startersError instanceof Error ? startersError.message : "The starter templates could not be added.");
    } finally {
      setAddingStarters(false);
    }
  }

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
        <div className="section-heading"><div><h2>Starter templates</h2></div></div>
        <p>
          Adds a draft template for each real event that has a built-in form. Nothing is published. Templates set no
          prices or capacity. The forms keep last year&apos;s prices, late-price dates and choice limits. Review them on
          the draft event before publishing. Templates that already exist (even renamed, edited, or archived) are left alone.
        </p>
        <ul>
          {starterEventTemplates.map((starter) => (
            <li key={starter.starterKey}>{starter.name}</li>
          ))}
          {pendingStarterEvents.map((pending) => (
            <li key={pending.starterKey}>{pending.name} ({pending.note})</li>
          ))}
        </ul>
        <button type="button" className="primary-button" disabled={addingStarters} onClick={addStarterTemplates}>
          {addingStarters ? "Adding…" : "Add starter templates"}
        </button>
        {starterResult ? (
          <div className="inline-notice" role="status">
            <p>Added {starterResult.added.length}: {starterResult.added.map((entry) => entry.name).join(", ") || "none"}.</p>
            <p>Skipped {starterResult.skipped.length} that already exist: {starterResult.skipped.map((entry) => `${entry.name}${entry.reason === "ARCHIVED" ? " (archived)" : ""}`).join(", ") || "none"}.</p>
            {starterResult.stillNeeded.length > 0 ? <p>Still needed: {starterResult.stillNeeded.map((entry) => `${entry.name} (${entry.note})`).join(", ")}.</p> : null}
          </div>
        ) : null}
      </section>

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
