"use client";

import { useMemo, useState } from "react";
import type { EventTemplateRecord } from "@/modules/event-templates/repository";

type EventTemplateEditorProps = {
  initialTemplate: EventTemplateRecord;
};

function currentVersion(template: EventTemplateRecord) {
  return template.versions.find((version) => version.status === "DRAFT")
    ?? template.versions.find((version) => version.status === "PUBLISHED")
    ?? template.versions[0]
    ?? null;
}

/**
 * The payload (form templates, attendee types, module toggles, message and
 * branding defaults, report selections — see `eventTemplatePayloadSchema`)
 * is edited as JSON. It is structured, technical configuration rather than
 * prose, and every field in it is validated server-side on save, publish,
 * and apply regardless of what produced it.
 */
export function EventTemplateEditor({ initialTemplate }: EventTemplateEditorProps) {
  const [template, setTemplate] = useState(initialTemplate);
  const version = useMemo(() => currentVersion(template), [template]);
  const isDraft = version?.status === "DRAFT";
  const isArchived = template.status === "ARCHIVED";
  const nextVersionNumber = (template.versions[0]?.versionNumber ?? 0) + 1;

  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(version?.payload ?? {}, null, 2));
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function saveDraft() {
    setSaving(true);
    setError("");
    setNotice("");
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payloadText);
    } catch {
      setError("The payload is not valid JSON.");
      setSaving(false);
      return;
    }
    try {
      const response = await fetch(`/api/event-templates/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          payload: parsedPayload,
          expectedUpdatedAt: version?.updatedAt,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The draft could not be saved.");
      setTemplate(body.template);
      setNotice("Draft saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The draft could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    setPublishing(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/event-templates/${template.id}/publish`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The template could not be published.");
      setTemplate(body.template);
      setNotice("Published. Existing events made from an earlier version are unaffected.");
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "The template could not be published.");
    } finally {
      setPublishing(false);
    }
  }

  async function archive() {
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/event-templates/${template.id}/archive`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The template could not be archived.");
      setTemplate(body.template);
      setNotice("Archived. It no longer appears in “Start from template.”");
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "The template could not be archived.");
    }
  }

  return (
    <div className="page-stack event-settings-workspace">
      {error ? <div className="inline-notice error" role="alert">{error}</div> : null}
      {notice ? <div className="inline-notice success" role="status">{notice}</div> : null}

      <section className="panel form-stack event-settings-panel">
        <div className="form-grid two-column">
          <label>Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <p>Status: {template.status} — version {version?.versionNumber ?? "—"} ({version?.status ?? "none"})</p>
        </div>
        <label>Description
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
        </label>
        <label>Payload (JSON)
          <textarea
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
            rows={20}
            spellCheck={false}
            disabled={isArchived}
          />
        </label>
        {version && version.payloadIssues.length > 0 ? (
          <div className="inline-notice error" role="alert">
            This version no longer passes validation and cannot be published or applied until it is fixed:
            <ul>{version.payloadIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
          </div>
        ) : null}
        {isArchived ? <p>This template is archived. It can no longer be edited, published, or used to create events.</p> : null}
        {!isArchived && !isDraft ? (
          <p>
            You are viewing the published version, which never changes. Saving your edits opens version {nextVersionNumber} as a new draft;
            events already created from this template are unaffected.
          </p>
        ) : null}
        <p>
          <button type="button" className="secondary-button" disabled={saving || isArchived} onClick={saveDraft}>
            {saving ? "Saving…" : isDraft ? "Save draft" : "Save as new draft"}
          </button>{" "}
          <button type="button" className="primary-button" disabled={publishing || !isDraft || isArchived} onClick={publish}>
            {publishing ? "Publishing…" : "Publish"}
          </button>{" "}
          {template.status !== "ARCHIVED" ? (
            <button type="button" className="secondary-button" onClick={archive}>Archive template</button>
          ) : null}
        </p>
      </section>

      <section className="panel form-stack event-settings-panel">
        <div className="section-heading"><div><h2>Versions</h2></div></div>
        <ul>
          {template.versions.map((entry) => (
            <li key={entry.id}>
              Version {entry.versionNumber} — {entry.status}
              {entry.publishedAt ? ` — published ${new Date(entry.publishedAt).toLocaleString()}` : ""}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
