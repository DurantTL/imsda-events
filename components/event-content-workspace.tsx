"use client";

import { useState } from "react";
import { FileText, Link2, Plus, Save, Trash2 } from "lucide-react";
import type { EventAssetRecord } from "@/modules/events/asset-repository";
import type { EventContentSectionRecord } from "@/modules/events/content-repository";
import { useUnsavedChangesGuard } from "@/components/use-unsaved-changes-guard";

type LinkDraft = { label: string; description: string; url: string | null; assetId: string | null };
type SectionDraft = {
  kind: "RICH_TEXT" | "RESOURCE_LINKS";
  title: string;
  body: string;
  isPublished: boolean;
  links: LinkDraft[];
};

function draftsFrom(sections: EventContentSectionRecord[]): SectionDraft[] {
  return sections.map((section) => ({
    kind: section.kind,
    title: section.title,
    body: section.body,
    isPublished: section.isPublished,
    links: section.links.map((link) => ({ ...link })),
  }));
}

export function EventContentWorkspace({
  eventId,
  eventName,
  initialSections,
  initialAssets,
}: {
  eventId: string;
  eventName: string;
  initialSections: EventContentSectionRecord[];
  initialAssets: EventAssetRecord[];
}) {
  const [assets, setAssets] = useState(initialAssets);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(() => draftsFrom(initialSections));
  const [sections, setSections] = useState(() => draftsFrom(initialSections));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const dirty = JSON.stringify(sections) !== JSON.stringify(saved);
  const allowNextNavigation = useUnsavedChangesGuard(
    dirty,
    "This event page has unsaved changes. Leave and discard them?",
  );

  function updateSection(index: number, patch: Partial<SectionDraft>) {
    setSections((current) => current.map((section, position) => (
      position === index ? { ...section, ...patch } : section
    )));
    setError("");
    setNotice("");
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= sections.length) return;
    setSections((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addSection(kind: SectionDraft["kind"]) {
    setSections((current) => [...current, {
      kind,
      title: "",
      body: "",
      isPublished: false,
      links: kind === "RESOURCE_LINKS" ? [{ label: "", description: "", url: "", assetId: null }] : [],
    }]);
  }

  async function uploadAsset(file: File) {
    setUploading(true);
    setError("");
    setNotice("");
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(`/api/events/${eventId}/assets`, { method: "POST", body });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.assets) {
        throw new Error(result.message ?? "That file could not be uploaded.");
      }
      setAssets(result.assets);
      setNotice(`Uploaded ${result.asset?.displayName ?? "the file"}. Choose it on a tile below.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That file could not be uploaded.");
    } finally {
      setUploading(false);
    }
  }

  async function save(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/events/${eventId}/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.sections) {
        throw new Error(result.message ?? "The event page could not be saved.");
      }
      const next = draftsFrom(result.sections);
      setSections(next);
      setSaved(next);
      allowNextNavigation();
      const published = next.filter((section) => section.isPublished).length;
      setNotice(`Saved. ${published} section${published === 1 ? "" : "s"} visible on the public event page.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The event page could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Event page</p>
          <h2>Public content</h2>
          <p>
            Speaker bios, seminar descriptions, lodging, schedules, and downloads for {eventName}.
            Each section publishes on its own, so a half-written one can wait while the rest goes live.
          </p>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="inline-notice" role="status">{notice}</p>}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Files</p>
            <h2>Uploads for this event</h2>
            <p>PDF, PNG, JPEG, or WebP, up to 25 MB. A file is only reachable publicly while a published tile links to it.</p>
          </div>
        </div>
        <label>
          Add a file
          <input
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadAsset(file);
            }}
          />
        </label>
        {assets.length > 0 && (
          <ul className="event-asset-list">
            {assets.map((asset) => (
              <li key={asset.id}>
                <a href={`/api/events/${eventId}/assets/${asset.id}`} target="_blank" rel="noreferrer">
                  {asset.displayName}
                </a>
                <small>
                  {(asset.byteSize / 1024).toFixed(0)} KB ·{" "}
                  {asset.linkCount === 0 ? "not used yet" : `used on ${asset.linkCount} tile${asset.linkCount === 1 ? "" : "s"}`}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form className="form-stack" onSubmit={save}>
        {sections.map((section, index) => (
          <section
            className={`panel event-content-section ${section.isPublished ? "" : "is-draft"}`}
            key={index}
          >
            <div className="message-delivery-toolbar">
              <div>
                <p className="eyebrow">
                  {section.kind === "RICH_TEXT" ? "Text section" : "Resource links"}
                  {section.isPublished ? "" : " · draft"}
                </p>
              </div>
              <div className="form-actions">
                <button className="secondary-button" type="button" onClick={() => move(index, -1)} disabled={index === 0}>Up</button>
                <button className="secondary-button" type="button" onClick={() => move(index, 1)} disabled={index === sections.length - 1}>Down</button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setSections((current) => current.filter((_, position) => position !== index))}
                >
                  <Trash2 size={15} aria-hidden="true" /> Remove
                </button>
              </div>
            </div>

            <label>
              Heading
              <input
                value={section.title}
                maxLength={120}
                required
                onChange={(event) => updateSection(index, { title: event.target.value })}
              />
            </label>

            {section.kind === "RICH_TEXT" ? (
              <label>
                Text
                <textarea
                  rows={6}
                  maxLength={8000}
                  value={section.body}
                  onChange={(event) => updateSection(index, { body: event.target.value })}
                />
                <small>Leave a blank line between paragraphs. Formatting and links are not carried through.</small>
              </label>
            ) : (
              <div className="form-stack">
                {section.links.map((link, linkIndex) => (
                  <div className="event-content-link-row" key={linkIndex}>
                    <label>Label<input value={link.label} maxLength={80} onChange={(event) => updateSection(index, {
                      links: section.links.map((entry, position) => position === linkIndex ? { ...entry, label: event.target.value } : entry),
                    })} /></label>
                    <label>Note<input value={link.description} maxLength={120} placeholder="Full weekend · PDF" onChange={(event) => updateSection(index, {
                      links: section.links.map((entry, position) => position === linkIndex ? { ...entry, description: event.target.value } : entry),
                    })} /></label>
                    <label>
                      Destination
                      <select
                        value={link.assetId ?? ""}
                        onChange={(event) => updateSection(index, {
                          links: section.links.map((entry, position) => position === linkIndex
                            // A tile points at one thing, so choosing a file
                            // clears the address and vice versa.
                            ? { ...entry, assetId: event.target.value || null, url: event.target.value ? null : entry.url ?? "" }
                            : entry),
                        })}
                      >
                        <option value="">A web address</option>
                        {assets.map((asset) => (
                          <option value={asset.id} key={asset.id}>{asset.displayName}</option>
                        ))}
                      </select>
                      {!link.assetId && (
                        <input type="url" value={link.url ?? ""} placeholder="https://imsda.org/flyer.pdf" onChange={(event) => updateSection(index, {
                          links: section.links.map((entry, position) => position === linkIndex ? { ...entry, url: event.target.value } : entry),
                        })} />
                      )}
                    </label>
                    <button className="secondary-button" type="button" onClick={() => updateSection(index, {
                      links: section.links.filter((_, position) => position !== linkIndex),
                    })}>
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                ))}
                <button className="secondary-button" type="button" onClick={() => updateSection(index, {
                  links: [...section.links, { label: "", description: "", url: "", assetId: null }],
                })}>
                  <Plus size={15} aria-hidden="true" /> Add a link
                </button>
              </div>
            )}

            <label className="message-enabled-toggle">
              <input
                type="checkbox"
                checked={section.isPublished}
                onChange={(event) => updateSection(index, { isPublished: event.target.checked })}
              />
              <span>
                <strong>Show this section on the public event page</strong>
                <small>Unpublished sections are kept here and are never sent to a visitor.</small>
              </span>
            </label>
          </section>
        ))}

        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={() => addSection("RICH_TEXT")}>
            <FileText size={15} aria-hidden="true" /> Add a text section
          </button>
          <button className="secondary-button" type="button" onClick={() => addSection("RESOURCE_LINKS")}>
            <Link2 size={15} aria-hidden="true" /> Add resource links
          </button>
        </div>

        <div className="form-actions">
          {dirty && <span className="unsaved-dot" role="status">Unsaved changes</span>}
          <button className="primary-button" type="submit" disabled={saving || !dirty}>
            <Save size={16} aria-hidden="true" /> {saving ? "Saving…" : "Save event page"}
          </button>
        </div>
      </form>
    </section>
  );
}
