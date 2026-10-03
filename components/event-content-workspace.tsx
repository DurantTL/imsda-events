"use client";

import { useCallback, useRef, useState } from "react";
import { FileText, FileUp, Info, Link2, ListOrdered, Plus, Save, Sparkles, SquareCheck, Trash2, X } from "lucide-react";
import type { EventAssetRecord } from "@/modules/events/asset-repository";
import type { EventContentSectionRecord } from "@/modules/events/content-repository";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EventInfoCards, eventContentToneLabels } from "@/components/event-info-cards";
import {
  eventContentTones,
  isInfoCardKind,
  type EventContentPlacement,
  type EventContentTone,
} from "@/modules/events/content-schemas";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { useUnsavedChangesGuard } from "@/components/use-unsaved-changes-guard";
import {
  localAssetImpact,
  quoteList,
  withoutAssetTiles,
  type SectionDraft,
} from "@/components/event-content-asset-tiles";

const assetTypeLabels: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

function assetTypeLabel(contentType: string) {
  return assetTypeLabels[contentType] ?? contentType;
}

function formatUploadDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Where-it's-used, for the file list: the same information the server's
 * delete check relies on, shown up front so staff aren't surprised by it. */
function usageSummary(usage: EventAssetRecord["usage"]) {
  const parts: string[] = [];
  if (usage.publishedSectionTitles.length > 0) {
    parts.push(`published in ${usage.publishedSectionTitles.join(", ")}`);
  }
  if (usage.draftSectionTitles.length > 0) {
    parts.push(`linked from ${usage.draftSectionTitles.length === 1 ? "a draft section" : "draft sections"}`);
  }
  if (usage.isBadgeBackground) {
    parts.push("badge background");
  }
  return parts.length > 0 ? parts.join(" · ") : "not used yet";
}

const retreatGuideStarterSections: SectionDraft[] = [
  {
    kind: "RICH_TEXT",
    title: "Weekend schedule",
    body: "Friday\nAdd arrival, registration, supper, worship, and evening activity times.\n\nSabbath\nAdd breakfast, worship, seminar, meal, and evening programme times.\n\nSunday\nAdd breakfast, final session, checkout, and departure times.",
    isPublished: false,
    links: [],
  },
  {
    kind: "RICH_TEXT",
    title: "Arrival, parking and check-in",
    body: "Add the arrival window, street address, parking instructions, check-in location, and what attendees should have ready.",
    isPublished: false,
    links: [],
  },
  {
    kind: "RICH_TEXT",
    title: "Meals, childcare and accessibility",
    body: "Add meal times and locations, childcare check-in details, accessibility guidance, and who to contact before or during the retreat.",
    isPublished: false,
    links: [],
  },
  {
    kind: "RICH_TEXT",
    title: "What to bring",
    body: "Add clothing, bedding, personal items, medications, activity supplies, and anything attendees should leave at home.",
    isPublished: false,
    links: [],
  },
  {
    kind: "RICH_TEXT",
    title: "Retreat resources",
    body: "Add the final programme, site map, packing list, speaker notes, recordings, and other files or web links attendees may need. Change this section to “Resource links” when the first resource is ready.",
    isPublished: false,
    links: [],
  },
];

const kindLabels: Record<SectionDraft["kind"], string> = {
  RICH_TEXT: "Text section",
  RESOURCE_LINKS: "Resource links",
  NOTICE: "Notice card",
  STEPS: "Steps card",
  CHECKLIST: "Checklist card",
};

type UpdateSection = (index: number, patch: Partial<SectionDraft>) => void;

function LinksEditor({
  section,
  index,
  assets,
  updateSection,
  allowMail = false,
}: {
  section: SectionDraft;
  index: number;
  assets: EventAssetRecord[];
  updateSection: UpdateSection;
  allowMail?: boolean;
}) {
  return (
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
                        <input type={allowMail ? "text" : "url"} value={link.url ?? ""} placeholder={allowMail ? "https://… or mailto:office@example.org" : "https://imsda.org/flyer.pdf"} onChange={(event) => updateSection(index, {
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
  );
}

function ItemsEditor({
  section,
  index,
  updateSection,
}: {
  section: SectionDraft;
  index: number;
  updateSection: UpdateSection;
}) {
  const items = section.items ?? [];
  const isSteps = section.kind === "STEPS";
  function setItem(position: number, patch: Partial<{ title: string; text: string }>) {
    updateSection(index, {
      items: items.map((item, at) => (at === position ? { ...item, ...patch } : item)),
    });
  }
  return (
    <div className="form-stack">
      {items.map((item, position) => (
        <div className="event-content-link-row" key={position}>
          <label>
            {isSteps ? `Step ${position + 1} title` : `Item ${position + 1}`}
            <input value={item.title} maxLength={120} onChange={(event) => setItem(position, { title: event.target.value })} />
          </label>
          {isSteps && (
            <label>
              Text
              <textarea rows={2} maxLength={600} value={item.text} onChange={(event) => setItem(position, { text: event.target.value })} />
            </label>
          )}
          <button
            className="secondary-button"
            type="button"
            aria-label={`Remove ${isSteps ? "step" : "item"} ${position + 1}`}
            onClick={() => updateSection(index, { items: items.filter((_, at) => at !== position) })}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
      {items.length < 20 && (
        <button
          className="secondary-button"
          type="button"
          onClick={() => updateSection(index, { items: [...items, { title: "", text: "" }] })}
        >
          <Plus size={15} aria-hidden="true" /> {isSteps ? "Add a step" : "Add an item"}
        </button>
      )}
    </div>
  );
}

function draftsFrom(sections: EventContentSectionRecord[]): SectionDraft[] {
  return sections.map((section) => ({
    kind: section.kind,
    title: section.title,
    body: section.body,
    tone: section.tone,
    placement: section.placement,
    items: section.items.map((item) => ({ ...item })),
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
  const [dragging, setDragging] = useState(false);
  // Entering and leaving the label's own children fires dragleave on the
  // label too, so count enters and leaves instead of flickering (#424).
  const dragDepth = useRef(0);
  const [pendingDelete, setPendingDelete] = useState<EventAssetRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const closeDeleteDialog = useCallback(() => {
    setPendingDelete(null);
    setDeleteError("");
  }, []);
  // Escape goes through here too: while the delete is in flight the dialog
  // stays open, so staff always see how it turned out.
  const dismissDeleteDialog = useCallback(() => {
    if (deleting) return;
    closeDeleteDialog();
  }, [closeDeleteDialog, deleting]);
  const deleteDialogRef = useAccessibleDialog<HTMLElement>(pendingDelete !== null, dismissDeleteDialog);
  const [saved, setSaved] = useState(() => draftsFrom(initialSections));
  const [sections, setSections] = useState(() => draftsFrom(initialSections));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Review before removing a public-content section (#471): what's removed
  // and what stays, before the click that will only take effect once the
  // page is saved.
  const [removeSectionIndex, setRemoveSectionIndex] = useState<number | null>(null);

  const dirty = JSON.stringify(sections) !== JSON.stringify(saved);
  const pendingImpact = pendingDelete ? localAssetImpact(sections, pendingDelete.id) : null;
  // The server only knows the saved page; an unsaved resource-links section
  // whose only tile is this file would be left unsaveable, so wait for the
  // editor to fix it rather than strip it to nothing.
  const deleteBlockedLocally = dirty && (pendingImpact?.emptiedTitles.length ?? 0) > 0;
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

  function addSection(kind: SectionDraft["kind"], tone?: EventContentTone) {
    setSections((current) => [...current, {
      kind,
      title: "",
      body: "",
      tone: kind === "NOTICE" ? tone ?? "INFO" : null,
      placement: "PUBLIC_PAGE",
      items: kind === "STEPS" || kind === "CHECKLIST" ? [{ title: "", text: "" }] : [],
      isPublished: false,
      links: kind === "RESOURCE_LINKS" ? [{ label: "", description: "", url: "", assetId: null }] : [],
    }]);
  }

  function addRetreatGuideStarter() {
    setSections((current) => [
      ...current,
      ...retreatGuideStarterSections.map((section) => ({
        ...section,
        links: section.links.map((link) => ({ ...link })),
      })),
    ]);
    setError("");
    setNotice("Added five unpublished retreat-guide sections. Replace the prompts, then publish each section when it is ready.");
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

  function onDragEnter(dragEvent: React.DragEvent<HTMLLabelElement>) {
    dragEvent.preventDefault();
    dragDepth.current += 1;
    if (!uploading) setDragging(true);
  }

  function onDragOver(dragEvent: React.DragEvent<HTMLLabelElement>) {
    dragEvent.preventDefault();
    if (!uploading) setDragging(true);
  }

  function onDragLeave(dragEvent: React.DragEvent<HTMLLabelElement>) {
    dragEvent.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(dragEvent: React.DragEvent<HTMLLabelElement>) {
    dragEvent.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (uploading) return;
    const files = dragEvent.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      setError("Drop one file at a time.");
      return;
    }
    void uploadAsset(files[0]);
  }

  async function confirmDeleteAsset(asset: EventAssetRecord) {
    setDeleting(true);
    setDeleteError("");
    try {
      const savedAtStart = saved;
      const response = await fetch(`/api/events/${eventId}/assets/${asset.id}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.assets || !result.sections) {
        throw new Error(result.message ?? "That file could not be deleted.");
      }
      setAssets(result.assets);
      // The delete may have removed draft tiles on the server. `saved` always
      // follows the server so the next save can't re-link the deleted file.
      // With no unsaved edits the editor takes the server copy too; with
      // unsaved edits it keeps them and strips only this file's tiles, so no
      // edit is lost (the dialog said which sections would change).
      const serverDrafts = draftsFrom(result.sections);
      setSaved(serverDrafts);
      setSections((current) => (
        JSON.stringify(current) === JSON.stringify(savedAtStart)
          ? serverDrafts
          : withoutAssetTiles(current, asset.id)
      ));
      setPendingDelete(null);
      const removedFrom: string[] = Array.isArray(result.removedFromDraftSectionTitles)
        ? result.removedFromDraftSectionTitles
        : [];
      setNotice(removedFrom.length > 0
        ? `Deleted ${asset.displayName} and removed its tile from ${quoteList(removedFrom)}.`
        : `Deleted ${asset.displayName}.`);
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "That file could not be deleted.");
    } finally {
      setDeleting(false);
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
      // Where each file is used just changed; refresh it for the file list and
      // delete dialog. Best effort: the server re-checks on delete anyway.
      void fetch(`/api/events/${eventId}/assets`)
        .then((assetsResponse) => (assetsResponse.ok ? assetsResponse.json() : null))
        .then((assetsResult) => { if (assetsResult?.assets) setAssets(assetsResult.assets); })
        .catch(() => undefined);
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
        <button className="secondary-button" type="button" onClick={addRetreatGuideStarter}>
          <Sparkles size={16} aria-hidden="true" /> Add retreat guide starter
        </button>
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
        <label
          className={`club-import-upload${dragging ? " club-import-upload-dragging" : ""}`}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <FileUp aria-hidden="true" size={24} />
          <strong>{uploading ? "Uploading…" : dragging ? "Drop the file here" : "Drag a file here, or choose one"}</strong>
          <small>PDF, PNG, JPEG, or WebP, up to 25 MB.</small>
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
                  {assetTypeLabel(asset.contentType)} · {(asset.byteSize / 1024).toFixed(0)} KB · Uploaded {formatUploadDate(asset.createdAt)} · {usageSummary(asset.usage)}
                </small>
                <button
                  aria-label={`Delete ${asset.displayName}`}
                  className="icon-button danger"
                  onClick={() => { setDeleteError(""); setPendingDelete(asset); }}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
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
                  {kindLabels[section.kind]}
                  {section.isPublished ? "" : " · draft"}
                </p>
              </div>
              <div className="form-actions">
                <button className="secondary-button" type="button" onClick={() => move(index, -1)} disabled={index === 0}>Up</button>
                <button className="secondary-button" type="button" onClick={() => move(index, 1)} disabled={index === sections.length - 1}>Down</button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setRemoveSectionIndex(index)}
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
            ) : section.kind === "RESOURCE_LINKS" ? (
              <LinksEditor section={section} index={index} assets={assets} updateSection={updateSection} />
            ) : section.kind === "NOTICE" ? (
              <>
                <label>
                  Tone
                  <select
                    value={section.tone ?? "INFO"}
                    onChange={(event) => updateSection(index, { tone: event.target.value as EventContentTone })}
                  >
                    {eventContentTones.map((tone) => (
                      <option value={tone} key={tone}>{eventContentToneLabels[tone]}</option>
                    ))}
                  </select>
                  <small>Shown as a coloured card with an icon and this label.</small>
                </label>
                <label>
                  Text
                  <textarea
                    rows={5}
                    maxLength={8000}
                    value={section.body}
                    onChange={(event) => updateSection(index, { body: event.target.value })}
                  />
                  <small>Plain text. Start lines with - for bullets or 1. for numbers. HTML and formatting are not carried through.</small>
                </label>
                <LinksEditor section={section} index={index} assets={assets} updateSection={updateSection} allowMail />
              </>
            ) : (
              <ItemsEditor section={section} index={index} updateSection={updateSection} />
            )}

            {isInfoCardKind(section.kind) && (
              <>
                <label>
                  Show this card
                  <select
                    value={section.placement ?? "PUBLIC_PAGE"}
                    onChange={(event) => updateSection(index, { placement: event.target.value as EventContentPlacement })}
                  >
                    <option value="PUBLIC_PAGE">On the public event page</option>
                    <option value="REGISTRATION_FORM">At the top of the registration form</option>
                    <option value="BOTH">On both</option>
                  </select>
                </label>
                <details className="event-info-card-preview">
                  <summary>Preview this card</summary>
                  <EventInfoCards
                    sections={[{
                      id: `preview-${index}`,
                      kind: section.kind,
                      title: section.title || "Untitled card",
                      body: section.body,
                      tone: section.tone ?? (section.kind === "NOTICE" ? "INFO" : null),
                      placement: "BOTH",
                      items: section.items ?? [],
                      links: section.links,
                    }]}
                    eventSlug="preview"
                    placement="page"
                    preview
                  />
                </details>
              </>
            )}

            <label className="message-enabled-toggle">
              <input
                type="checkbox"
                checked={section.isPublished}
                onChange={(event) => updateSection(index, { isPublished: event.target.checked })}
              />
              <span>
                <strong>Publish this section</strong>
                <small>Unpublished sections are kept here and are never sent to a visitor. Where it appears depends on its placement.</small>
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
          <button className="secondary-button" type="button" onClick={() => addSection("NOTICE")}>
            <Info size={15} aria-hidden="true" /> Add a notice card
          </button>
          <button className="secondary-button" type="button" onClick={() => addSection("STEPS")}>
            <ListOrdered size={15} aria-hidden="true" /> Add a steps card
          </button>
          <button className="secondary-button" type="button" onClick={() => addSection("CHECKLIST")}>
            <SquareCheck size={15} aria-hidden="true" /> Add a checklist card
          </button>
        </div>

        <div className="form-actions">
          {dirty && <span className="unsaved-dot" role="status">Unsaved changes</span>}
          <button className="primary-button" type="submit" disabled={saving || !dirty}>
            <Save size={16} aria-hidden="true" /> {saving ? "Saving…" : "Save event page"}
          </button>
        </div>
      </form>

      <ConfirmDialog
        busy={false}
        confirmLabel={removeSectionIndex !== null ? `Remove "${sections[removeSectionIndex]?.title || "this section"}"` : "Remove section"}
        destructive
        error=""
        onCancel={() => setRemoveSectionIndex(null)}
        onConfirm={() => {
          if (removeSectionIndex === null) return;
          setSections((current) => current.filter((_, position) => position !== removeSectionIndex));
          setRemoveSectionIndex(null);
        }}
        open={removeSectionIndex !== null}
        title={removeSectionIndex !== null ? `Remove "${sections[removeSectionIndex]?.title || "this section"}"?` : "Remove section?"}
      >
        <p>
          This section is removed from the draft page. Nothing takes effect until you save — if it
          was already published, visitors stop seeing it the moment you save. No registration or
          attendee data is attached to a content section, so nothing else is affected.
        </p>
      </ConfirmDialog>
      {pendingDelete && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => { if (event.target === event.currentTarget) dismissDeleteDialog(); }}
          role="presentation"
        >
          <section aria-labelledby="delete-asset-title" aria-modal="true" className="modal-card" ref={deleteDialogRef} role="dialog" tabIndex={-1}>
            <div className="modal-head">
              <div>
                <p className="eyebrow">Files</p>
                <h2 id="delete-asset-title">Delete {pendingDelete.displayName}?</h2>
              </div>
              <button aria-label="Close" className="icon-button modal-close-button" disabled={deleting} onClick={closeDeleteDialog} type="button">
                <X aria-hidden="true" size={18} />
              </button>
            </div>
            {deleteError && <div className="inline-notice error" role="alert">{deleteError}</div>}
            <p className="field-help">This removes the file and its stored copy. This can&apos;t be undone.</p>
            {pendingDelete.usage.draftSectionTitles.length > 0 && (
              <p className="field-help">
                Its tile will also be removed from the draft {pendingDelete.usage.draftSectionTitles.length === 1 ? "section" : "sections"} {quoteList(pendingDelete.usage.draftSectionTitles)}.
              </p>
            )}
            {dirty && pendingImpact && pendingImpact.emptiedTitles.length > 0 && (
              <div className="inline-notice error" role="alert">
                In your unsaved edits this file is the only link in {quoteList(pendingImpact.emptiedTitles)}. Remove its tile from that section first, or add another link there.
              </div>
            )}
            {dirty && (
              <p className="field-help">
                You have unsaved page edits. They are kept
                {pendingImpact && pendingImpact.affectedTitles.length > 0
                  ? <>; only this file&apos;s tiles are removed from {quoteList(pendingImpact.affectedTitles)}.</>
                  : "."}
              </p>
            )}
            <div className="form-actions">
              <button className="secondary-button" disabled={deleting} onClick={closeDeleteDialog} type="button">Cancel</button>
              <button className="primary-button" disabled={deleting || deleteBlockedLocally} onClick={() => void confirmDeleteAsset(pendingDelete)} type="button">
                <Trash2 aria-hidden="true" size={16} /> {deleting ? "Deleting…" : "Delete file"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
