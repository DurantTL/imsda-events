"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { EventTemplateRecord } from "@/modules/event-templates/repository";

type StartFromTemplateProps = {
  templates: EventTemplateRecord[];
};

function slugFromName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function StartFromTemplate({ templates }: StartFromTemplateProps) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [requestKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const selectedTemplate = useMemo(() => templates.find((template) => template.id === templateId), [templates, templateId]);

  function updateName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugFromName(value));
  }

  async function apply() {
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/event-templates/${templateId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug, startsOn, endsOn, requestKey }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The event could not be created from this template.");
      router.push(`/more/event-settings?event=${body.event.id}`);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "The event could not be created from this template.");
      setSubmitting(false);
    }
  }

  if (templates.length === 0) {
    return <p>No published templates are available yet. Publish a template first.</p>;
  }

  return (
    <div className="page-stack event-settings-workspace">
      {error ? <div className="inline-notice error" role="alert">{error}</div> : null}
      <section className="panel form-stack event-settings-panel">
        <label>Template
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>{template.name} ({template.audience === "CLUB" ? "Club" : "General"})</option>
            ))}
          </select>
        </label>
        {selectedTemplate?.description ? <p>{selectedTemplate.description}</p> : null}

        <div className="form-grid two-column">
          <label>Event name
            <input value={name} onChange={(event) => updateName(event.target.value)} />
          </label>
          <label>Web address
            <input value={slug} onChange={(event) => { setSlug(event.target.value); setSlugEdited(true); }} />
          </label>
          <label>Starts on
            <input type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
          </label>
          <label>Ends on
            <input type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
          </label>
        </div>

        <button
          type="button"
          className="primary-button"
          disabled={submitting || !templateId || name.trim().length < 3 || slug.trim().length < 3 || !startsOn || !endsOn}
          onClick={apply}
        >
          {submitting ? "Creating…" : "Create draft event"}
        </button>
      </section>
    </div>
  );
}
