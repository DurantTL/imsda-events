"use client";

import { useMemo, useRef, useState } from "react";
import { ArchiveTemplateDialog } from "@/components/archive-template-dialog";
import { hasUnsavedTemplateEdits, publishDisabledReason, saveDisabledReason, UNSAVED_PUBLISH_MESSAGE, validateTemplateEdits, type TemplateFieldError } from "@/modules/event-templates/editor-guards";
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
  const [fieldErrors, setFieldErrors] = useState<TemplateFieldError[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [unarchiving, setUnarchiving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const payloadRef = useRef<HTMLTextAreaElement>(null);
  const nameErrors = fieldErrors.filter((entry) => entry.field === "name");
  const descriptionErrors = fieldErrors.filter((entry) => entry.field === "description");
  const payloadErrors = fieldErrors.filter((entry) => entry.field === "payload");

  const hasUnsavedEdits = hasUnsavedTemplateEdits(
    { name, description, payloadText },
    { name: template.name, description: template.description, payload: version?.payload ?? {} },
  );
  const saveReason = saveDisabledReason({ isArchived, saving });
  const publishReason = publishDisabledReason({ isArchived, isDraft, publishing });

  async function saveDraft() {
    setSaving(true);
    setError("");
    setNotice("");
    // Validate the same schema the server uses, so a malformed or invalid payload never leaves the page.
    const checked = validateTemplateEdits({ name, description, payloadText });
    if (!checked.ok) {
      setFieldErrors(checked.errors);
      setSaving(false);
      // A fresh key remounts the summary so it is announced again even when the errors are unchanged.
      setAttempt((current) => current + 1);
      setTimeout(() => summaryRef.current?.focus(), 0);
      return;
    }
    setFieldErrors([]);
    const parsedPayload = checked.payload;
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
      setName(body.template.name);
      setDescription(body.template.description);
      const savedVersion = currentVersion(body.template as EventTemplateRecord);
      if (savedVersion) setPayloadText(JSON.stringify(savedVersion.payload ?? {}, null, 2));
      setNotice("Draft saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The draft could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    setError("");
    setNotice("");
    // The publish route publishes what is stored, not what is in this editor.
    if (hasUnsavedEdits) {
      setError(UNSAVED_PUBLISH_MESSAGE);
      return;
    }
    setPublishing(true);
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
    setArchiveBusy(true);
    setArchiveError("");
    try {
      const response = await fetch(`/api/event-templates/${template.id}/archive`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The template could not be archived.");
      setTemplate(body.template);
      setArchiveOpen(false);
      setNotice("Archived. It no longer appears in “Start from template.”");
    } catch (archiveFailure) {
      setArchiveError(archiveFailure instanceof Error ? archiveFailure.message : "The template could not be archived.");
    } finally {
      setArchiveBusy(false);
    }
  }

  async function unarchive() {
    if (unarchiving) return;
    setUnarchiving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/event-templates/${template.id}/unarchive`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The template could not be unarchived.");
      setTemplate(body.template);
      setNotice("Unarchived. It can be edited again.");
    } catch (unarchiveError) {
      setError(unarchiveError instanceof Error ? unarchiveError.message : "The template could not be unarchived.");
    } finally {
      setUnarchiving(false);
    }
  }

  return (
    <div className="page-stack event-settings-workspace">
      <p className="muted">For administrators comfortable editing JSON.</p>
      {error ? <div className="inline-notice error" role="alert">{error}</div> : null}
      {notice ? <div className="inline-notice success" role="status">{notice}</div> : null}
      {fieldErrors.length > 0 ? (
        <div className="inline-notice error" role="alert" id="template-error-summary" key={attempt} ref={summaryRef} tabIndex={-1}>
          Fix {fieldErrors.length === 1 ? "this problem" : `these ${fieldErrors.length} problems`} before saving:
          <ul>
            {fieldErrors.map((entry, index) => (
              <li key={`${entry.path}-${index}`}>
                <a
                  href={`#template-${entry.field}`}
                  onClick={(event) => {
                    event.preventDefault();
                    (entry.field === "name" ? nameRef : entry.field === "description" ? descriptionRef : payloadRef).current?.focus();
                  }}
                >{entry.path}</a>: {entry.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="panel form-stack event-settings-panel">
        <div className="form-grid two-column">
          <div>
          <label>Name
            <input
              id="template-name"
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={nameErrors.length > 0 || undefined}
              aria-describedby={nameErrors.length > 0 ? "template-name-error" : undefined}
            />
          </label>
          {nameErrors.length > 0 ? <span id="template-name-error" className="form-error">{nameErrors.map((entry) => entry.message).join(" ")}</span> : null}
          </div>
          <p>Status: {template.status} — version {version?.versionNumber ?? "—"} ({version?.status ?? "none"})</p>
        </div>
        <label>Description
          <textarea
            id="template-description"
            ref={descriptionRef}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            aria-invalid={descriptionErrors.length > 0 || undefined}
            aria-describedby={descriptionErrors.length > 0 ? "template-description-error" : undefined}
          />
        </label>
        {descriptionErrors.length > 0 ? <span id="template-description-error" className="form-error">{descriptionErrors.map((entry) => entry.message).join(" ")}</span> : null}
        <label>Payload (JSON)
          <textarea
            id="template-payload"
            ref={payloadRef}
            aria-invalid={payloadErrors.length > 0 || undefined}
            aria-describedby={payloadErrors.length > 0 ? "template-payload-error" : undefined}
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
            rows={20}
            spellCheck={false}
            disabled={isArchived}
          />
        </label>
        {payloadErrors.length > 0 ? (
          <ul id="template-payload-error" className="form-error">
            {payloadErrors.map((entry, index) => <li key={`${entry.path}-${index}`}><code>{entry.path}</code>: {entry.message}</li>)}
          </ul>
        ) : null}
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
        {saveReason || publishReason ? (
          <ul id="template-action-hints" className="muted">
            {saveReason ? <li>{isDraft ? "Save draft" : "Save as new draft"}: {saveReason}</li> : null}
            {publishReason ? <li>Publish: {publishReason}</li> : null}
          </ul>
        ) : null}
        {hasUnsavedEdits && !isArchived ? <p className="muted">You have unsaved changes. Save them before publishing.</p> : null}
        <p>
          <button type="button" className="secondary-button" disabled={Boolean(saveReason)} title={saveReason || undefined} aria-describedby={saveReason ? "template-action-hints" : undefined} onClick={saveDraft}>
            {saving ? "Saving…" : isDraft ? "Save draft" : "Save as new draft"}
          </button>{" "}
          <button type="button" className="primary-button" disabled={Boolean(publishReason)} title={publishReason || undefined} aria-describedby={publishReason ? "template-action-hints" : undefined} onClick={publish}>
            {publishing ? "Publishing…" : "Publish"}
          </button>{" "}
          {template.status !== "ARCHIVED" ? (
            <button type="button" className="secondary-button" onClick={() => { setArchiveError(""); setArchiveOpen(true); }}>Archive template</button>
          ) : (
            <button type="button" className="secondary-button" disabled={unarchiving} onClick={unarchive}>{unarchiving ? "Unarchiving…" : "Unarchive template"}</button>
          )}
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

      <ArchiveTemplateDialog
        busy={archiveBusy}
        error={archiveError}
        name={template.name}
        onCancel={() => setArchiveOpen(false)}
        onConfirm={() => void archive()}
        open={archiveOpen}
      />
    </div>
  );
}
