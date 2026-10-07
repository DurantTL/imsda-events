"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { EventAssetRecord } from "@/modules/events/asset-repository";
import type { SanitizedHtml } from "@/modules/events/content-html";
import {
  EventContentBlocks,
  EventHeroBanner,
  type EventBlockEvent,
} from "@/components/event-content-blocks";
import type { SectionDraft } from "@/components/event-content-asset-tiles";
import {
  embedProviderLabels,
  embedProviders,
  extractEmbedId,
  isEmbedProvider,
  type EmbedProvider,
} from "@/modules/events/content-embeds";
import { parseBlockData, type EventContentKind } from "@/modules/events/content-schemas";

/**
 * The editing forms and previews for the #816 blocks. The drafts hold loose
 * values (an empty string is a field not filled in yet); the server validates
 * them against the same schemas the renderer reads with, so nothing here is a
 * security boundary. It exists to make the right thing easy.
 */

type Data = Record<string, unknown>;
type UpdateSection = (index: number, patch: Partial<SectionDraft>) => void;

const isRecord = (value: unknown): value is Data => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const whole = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);
const rows = (value: unknown): Data[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** The new blocks, in the order the picker lists them. */
export const newBlockKinds = [
  "HERO", "IMAGE", "GALLERY", "FORMATTED_TEXT", "EMBED", "FAQ",
  "SCHEDULE", "SPEAKERS", "CONTACT", "COUNTDOWN", "CUSTOM_HTML",
] as const satisfies readonly EventContentKind[];

export const blockKindLabels: Record<(typeof newBlockKinds)[number], string> = {
  HERO: "Header banner",
  IMAGE: "Photo with text",
  GALLERY: "Photo gallery",
  FORMATTED_TEXT: "Formatted text",
  EMBED: "Video or map",
  FAQ: "Questions and answers",
  SCHEDULE: "Schedule",
  SPEAKERS: "Speaker cards",
  CONTACT: "Contact card",
  COUNTDOWN: "Countdown",
  CUSTOM_HTML: "Custom HTML",
};

export function isNewBlockKind(kind: EventContentKind): kind is (typeof newBlockKinds)[number] {
  return (newBlockKinds as readonly string[]).includes(kind);
}

/** Starting values for a freshly added block. */
export function defaultBlockData(kind: EventContentKind): Data | undefined {
  switch (kind) {
    case "HERO":
      return { assetId: "", alt: "", subtitle: "", button: null, focalX: 50, focalY: 50, overlay: 40 };
    case "IMAGE":
      return { assetId: "", alt: "", caption: "", imageSide: "LEFT" };
    case "GALLERY":
      return { images: [{ assetId: "", alt: "", caption: "" }] };
    case "EMBED":
      return { provider: "YOUTUBE", id: "", title: "" };
    case "FAQ":
      return { entries: [{ question: "", answer: "" }] };
    case "SCHEDULE":
      return { rows: [{ day: "", time: "", title: "", location: "", description: "" }] };
    case "SPEAKERS":
      return { speakers: [{ name: "", role: "", bio: "", assetId: "", alt: "" }] };
    case "CONTACT":
      return { contacts: [{ name: "", role: "", email: "", phone: "" }] };
    case "COUNTDOWN":
      return { target: "EVENT_START", customAt: "", label: "" };
    default:
      return undefined;
  }
}

function imageAssets(assets: EventAssetRecord[]) {
  return assets.filter((asset) => asset.contentType.startsWith("image/"));
}

function AssetImagePicker({
  label,
  assets,
  value,
  required = true,
  onChange,
}: {
  label: string;
  assets: EventAssetRecord[];
  value: string;
  required?: boolean;
  onChange: (assetId: string) => void;
}) {
  const images = imageAssets(assets);
  const chosen = images.find((asset) => asset.id === value);
  return (
    <div className="event-image-picker">
      <label>
        {label}
        <select value={value} required={required} onChange={(event) => onChange(event.target.value)}>
          <option value="">{required ? "Choose an uploaded image" : "No photo"}</option>
          {images.map((asset) => <option value={asset.id} key={asset.id}>{asset.displayName}</option>)}
        </select>
        {images.length === 0 && (
          <small>No images yet. Upload a PNG, JPEG, or WebP under Uploads above, then choose it here.</small>
        )}
      </label>
      {chosen && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="event-image-picker-thumb" src={chosen.url} alt="" loading="lazy" />
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  max,
  required,
  help,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  max: number;
  required?: boolean;
  help?: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label>
      {label}
      <input type={type} value={value} maxLength={max} required={required} onChange={(event) => onChange(event.target.value)} />
      {help && <small>{help}</small>}
    </label>
  );
}

function AreaField({
  label,
  value,
  max,
  rowsCount = 3,
  required,
  help,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  rowsCount?: number;
  required?: boolean;
  help?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <textarea rows={rowsCount} maxLength={max} value={value} required={required} onChange={(event) => onChange(event.target.value)} />
      {help && <small>{help}</small>}
    </label>
  );
}

/** Add, remove and reorder a list of rows. */
function RowList({
  label,
  rowsData,
  max,
  blank,
  onChange,
  children,
}: {
  label: string;
  rowsData: Data[];
  max: number;
  blank: Data;
  onChange: (next: Data[]) => void;
  children: (row: Data, set: (patch: Data) => void, position: number) => React.ReactNode;
}) {
  function move(position: number, delta: number) {
    const target = position + delta;
    if (target < 0 || target >= rowsData.length) return;
    const next = [...rowsData];
    [next[position], next[target]] = [next[target], next[position]];
    onChange(next);
  }
  return (
    <div className="form-stack">
      {rowsData.map((row, position) => (
        <fieldset className="event-block-row" key={position}>
          <legend>{label} {position + 1}</legend>
          {children(row, (patch) => onChange(rowsData.map((entry, at) => (at === position ? { ...entry, ...patch } : entry))), position)}
          <div className="form-actions">
            <button className="secondary-button" type="button" aria-label={`Move ${label.toLowerCase()} ${position + 1} up`} disabled={position === 0} onClick={() => move(position, -1)}>
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            <button className="secondary-button" type="button" aria-label={`Move ${label.toLowerCase()} ${position + 1} down`} disabled={position === rowsData.length - 1} onClick={() => move(position, 1)}>
              <ArrowDown size={15} aria-hidden="true" />
            </button>
            <button className="secondary-button" type="button" aria-label={`Remove ${label.toLowerCase()} ${position + 1}`} disabled={rowsData.length <= 1} onClick={() => onChange(rowsData.filter((_, at) => at !== position))}>
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </div>
        </fieldset>
      ))}
      {rowsData.length < max && (
        <button className="secondary-button" type="button" onClick={() => onChange([...rowsData, { ...blank }])}>
          <Plus size={15} aria-hidden="true" /> Add {label.toLowerCase()}
        </button>
      )}
    </div>
  );
}

function EmbedEditor({ data, set }: { data: Data; set: (patch: Data) => void }) {
  const provider: EmbedProvider = isEmbedProvider(data.provider) ? data.provider : "YOUTUBE";
  const [raw, setRaw] = useState(text(data.id));
  const [message, setMessage] = useState("");

  function readLink(value: string, nextProvider: EmbedProvider) {
    setRaw(value);
    if (!value.trim()) {
      setMessage("");
      set({ provider: nextProvider, id: "" });
      return;
    }
    const result = extractEmbedId(nextProvider, value);
    if (result.ok) {
      setMessage("");
      set({ provider: nextProvider, id: result.id });
    } else {
      setMessage(result.message);
      // An unreadable value is never stored; the save then asks for a valid one.
      set({ provider: nextProvider, id: "" });
    }
  }

  return (
    <div className="form-stack">
      <label>
        Kind of embed
        <select value={provider} onChange={(event) => readLink(raw, event.target.value as EmbedProvider)}>
          {embedProviders.map((entry) => <option value={entry} key={entry}>{embedProviderLabels[entry]}</option>)}
        </select>
      </label>
      <label>
        {provider === "GOOGLE_MAPS" ? "Embed address from Google Maps" : "Link or video id"}
        <input
          value={raw}
          required
          aria-invalid={message ? true : undefined}
          onChange={(event) => readLink(event.target.value, provider)}
        />
        <small>
          {provider === "GOOGLE_MAPS"
            ? "In Google Maps choose Share, then Embed a map, and paste the address that starts with https://www.google.com/maps/embed?pb="
            : "Paste the page link. Only the id is kept; the player is built from it."}
        </small>
      </label>
      {message && <p className="form-error" role="alert">{message}</p>}
      <TextField label="Title for screen readers" value={text(data.title)} max={120} required onChange={(title) => set({ title })} />
    </div>
  );
}

/** Shows HTML the server's sanitizer produced (the saved body, or the preview route's answer). */
function HtmlPreview({ html }: { html: string }) {
  return (
    <EventContentBlocks
      sections={[{ id: "html-preview", kind: "CUSTOM_HTML", title: "Custom HTML", body: "", placement: "BOTH", data: {} }]}
      placement="page"
      assetUrl={() => ""}
      sanitizedHtml={{ "html-preview": html as SanitizedHtml }}
      idPrefix="html-preview"
    />
  );
}

function CustomHtmlEditor({
  eventId,
  section,
  index,
  isSystemAdmin,
  updateSection,
}: {
  eventId: string;
  section: SectionDraft;
  index: number;
  isSystemAdmin: boolean;
  updateSection: UpdateSection;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function showSanitized() {
    setBusy(true);
    setProblem("");
    try {
      const response = await fetch(`/api/events/${eventId}/content/html-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: section.body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.html !== "string") {
        throw new Error(result.message ?? "The preview could not be built.");
      }
      setShown(result.html);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The preview could not be built.");
    } finally {
      setBusy(false);
    }
  }

  if (!isSystemAdmin) {
    return (
      <div className="form-stack">
        <p className="inline-notice" role="note">
          Custom HTML can only be added or changed by a system administrator. You can see what it says
          and reorder it; this is the sanitized HTML as it appears on the public page.
        </p>
        <label>
          HTML (read-only)
          <textarea rows={6} readOnly value={section.body} />
        </label>
        <HtmlPreview html={section.body} />
      </div>
    );
  }
  return (
    <div className="form-stack">
      <label>
        HTML
        <textarea
          rows={10}
          maxLength={20000}
          value={section.body}
          spellCheck={false}
          onChange={(event) => { updateSection(index, { body: event.target.value }); setShown(null); }}
        />
        <small>
          Paragraphs, headings, lists, tables, links and images from this event&apos;s uploads. Script,
          style, frames, forms, event handlers and other sites&apos; images are removed when you save
          and again when the page is shown.
        </small>
      </label>
      <div className="form-actions">
        <button className="secondary-button" type="button" disabled={busy || !section.body.trim()} onClick={() => void showSanitized()}>
          {busy ? "Checking…" : "Show sanitized output"}
        </button>
      </div>
      {problem && <p className="form-error" role="alert">{problem}</p>}
      {shown !== null && (
        <div className="form-stack">
          <p className="field-help">This is what will be saved and published:</p>
          <pre className="event-html-source" tabIndex={0}>{shown}</pre>
          <p className="field-help">And how it looks:</p>
          <HtmlPreview html={shown} />
        </div>
      )}
    </div>
  );
}

export function BlockEditor({
  eventId,
  section,
  index,
  assets,
  isSystemAdmin,
  updateSection,
}: {
  eventId: string;
  section: SectionDraft;
  index: number;
  assets: EventAssetRecord[];
  isSystemAdmin: boolean;
  updateSection: UpdateSection;
}) {
  const data: Data = isRecord(section.data) ? section.data : {};
  const set = (patch: Data) => updateSection(index, { data: { ...data, ...patch } });

  switch (section.kind) {
    case "HERO": {
      const button = isRecord(data.button) ? data.button : null;
      return (
        <div className="form-stack">
          <p className="field-help">The heading above is the large title on the banner. One banner per page, shown first.</p>
          <AssetImagePicker label="Banner image" assets={assets} value={text(data.assetId)} onChange={(assetId) => set({ assetId })} />
          <TextField label="Image description (alt text)" value={text(data.alt)} max={200} required onChange={(alt) => set({ alt })} help="Describe the photo for people who cannot see it." />
          <TextField label="Subtitle" value={text(data.subtitle)} max={200} onChange={(subtitle) => set({ subtitle })} />
          <label className="message-enabled-toggle">
            <input type="checkbox" checked={button !== null} onChange={(event) => set({ button: event.target.checked ? { label: "Register", target: "REGISTER", url: "" } : null })} />
            <span><strong>Show a button</strong></span>
          </label>
          {button && (
            <div className="form-stack">
              <TextField label="Button label" value={text(button.label)} max={40} required onChange={(label) => set({ button: { ...button, label } })} />
              <label>
                The button goes to
                <select value={text(button.target)} onChange={(event) => set({ button: { ...button, target: event.target.value, url: "" } })}>
                  <option value="REGISTER">The registration options on this page</option>
                  <option value="URL">A web address</option>
                </select>
              </label>
              {button.target === "URL" && (
                <TextField label="Web address" type="url" value={text(button.url)} max={500} required help="Must start with https://" onChange={(url) => set({ button: { ...button, url } })} />
              )}
            </div>
          )}
          <label>
            Overlay darkness: {whole(data.overlay, 40)}%
            <input type="range" min={0} max={80} step={5} value={whole(data.overlay, 40)} onChange={(event) => set({ overlay: Number(event.target.value) })} />
            <small>Darker makes the title easier to read on a busy photo.</small>
          </label>
          <label>
            Focal point, across: {whole(data.focalX, 50)}%
            <input type="range" min={0} max={100} step={5} value={whole(data.focalX, 50)} onChange={(event) => set({ focalX: Number(event.target.value) })} />
          </label>
          <label>
            Focal point, down: {whole(data.focalY, 50)}%
            <input type="range" min={0} max={100} step={5} value={whole(data.focalY, 50)} onChange={(event) => set({ focalY: Number(event.target.value) })} />
            <small>Where the photo stays centred when a phone crops it.</small>
          </label>
        </div>
      );
    }
    case "IMAGE":
      return (
        <div className="form-stack">
          <AssetImagePicker label="Photo" assets={assets} value={text(data.assetId)} onChange={(assetId) => set({ assetId })} />
          <TextField label="Image description (alt text)" value={text(data.alt)} max={200} required onChange={(alt) => set({ alt })} help="Describe the photo for people who cannot see it." />
          <TextField label="Caption" value={text(data.caption)} max={300} onChange={(caption) => set({ caption })} />
          <AreaField label="Text beside the photo" value={section.body} max={8000} rowsCount={5} onChange={(body) => updateSection(index, { body })} help="Optional. Plain text; a blank line starts a new paragraph." />
          <label>
            Photo sits on the
            <select value={text(data.imageSide) || "LEFT"} onChange={(event) => set({ imageSide: event.target.value })}>
              <option value="LEFT">Left</option>
              <option value="RIGHT">Right</option>
            </select>
            <small>On phones the photo stacks above the text.</small>
          </label>
        </div>
      );
    case "GALLERY":
      return (
        <RowList label="Photo" rowsData={rows(data.images)} max={24} blank={{ assetId: "", alt: "", caption: "" }} onChange={(images) => set({ images })}>
          {(row, setRow) => (
            <>
              <AssetImagePicker label="Image" assets={assets} value={text(row.assetId)} onChange={(assetId) => setRow({ assetId })} />
              <TextField label="Image description (alt text)" value={text(row.alt)} max={200} required onChange={(alt) => setRow({ alt })} />
              <TextField label="Caption" value={text(row.caption)} max={300} onChange={(caption) => setRow({ caption })} />
            </>
          )}
        </RowList>
      );
    case "FORMATTED_TEXT":
      return (
        <AreaField
          label="Text"
          value={section.body}
          max={8000}
          rowsCount={10}
          required
          onChange={(body) => updateSection(index, { body })}
          help="Markdown: ## Heading, ### Smaller heading, **bold**, *italic*, [link text](https://example.org), lines starting with - for bullets or 1. for numbers. HTML is not used."
        />
      );
    case "EMBED":
      return <EmbedEditor data={data} set={set} />;
    case "FAQ":
      return (
        <RowList label="Question" rowsData={rows(data.entries)} max={30} blank={{ question: "", answer: "" }} onChange={(entries) => set({ entries })}>
          {(row, setRow) => (
            <>
              <TextField label="Question" value={text(row.question)} max={200} required onChange={(question) => setRow({ question })} />
              <AreaField label="Answer" value={text(row.answer)} max={1500} required onChange={(answer) => setRow({ answer })} />
            </>
          )}
        </RowList>
      );
    case "SCHEDULE":
      return (
        <RowList label="Row" rowsData={rows(data.rows)} max={80} blank={{ day: "", time: "", title: "", location: "", description: "" }} onChange={(next) => set({ rows: next })}>
          {(row, setRow) => (
            <>
              <TextField label="Day" value={text(row.day)} max={40} required onChange={(day) => setRow({ day })} />
              <TextField label="Time" value={text(row.time)} max={40} required onChange={(time) => setRow({ time })} />
              <TextField label="Title" value={text(row.title)} max={150} required onChange={(title) => setRow({ title })} />
              <TextField label="Location" value={text(row.location)} max={100} onChange={(location) => setRow({ location })} />
              <AreaField label="Description" value={text(row.description)} max={400} rowsCount={2} onChange={(description) => setRow({ description })} />
            </>
          )}
        </RowList>
      );
    case "SPEAKERS":
      return (
        <RowList label="Speaker" rowsData={rows(data.speakers)} max={40} blank={{ name: "", role: "", bio: "", assetId: "", alt: "" }} onChange={(speakers) => set({ speakers })}>
          {(row, setRow) => (
            <>
              <TextField label="Name" value={text(row.name)} max={80} required onChange={(name) => setRow({ name })} />
              <TextField label="Role or title" value={text(row.role)} max={100} onChange={(role) => setRow({ role })} />
              <AreaField label="Short bio" value={text(row.bio)} max={600} onChange={(bio) => setRow({ bio })} />
              <AssetImagePicker label="Photo" required={false} assets={assets} value={text(row.assetId)} onChange={(assetId) => setRow({ assetId })} />
              {text(row.assetId) && (
                <TextField label="Photo description (alt text)" value={text(row.alt)} max={200} required onChange={(alt) => setRow({ alt })} />
              )}
            </>
          )}
        </RowList>
      );
    case "CONTACT":
      return (
        <RowList label="Contact" rowsData={rows(data.contacts)} max={12} blank={{ name: "", role: "", email: "", phone: "" }} onChange={(contacts) => set({ contacts })}>
          {(row, setRow) => (
            <>
              <TextField label="Name" value={text(row.name)} max={80} required onChange={(name) => setRow({ name })} />
              <TextField label="Role" value={text(row.role)} max={100} onChange={(role) => setRow({ role })} />
              <TextField label="Email" type="email" value={text(row.email)} max={200} onChange={(email) => setRow({ email })} />
              <TextField label="Phone" type="tel" value={text(row.phone)} max={30} onChange={(phone) => setRow({ phone })} help="Add an email address, a phone number, or both. Only what you enter is shown." />
            </>
          )}
        </RowList>
      );
    case "COUNTDOWN":
      return (
        <div className="form-stack">
          <label>
            Count down to
            <select value={text(data.target) || "EVENT_START"} onChange={(event) => set({ target: event.target.value })}>
              <option value="EVENT_START">The start of the event</option>
              <option value="CUSTOM">A date and time I choose</option>
            </select>
          </label>
          {data.target === "CUSTOM" && (
            <TextField label="Date and time (event time zone)" type="datetime-local" value={text(data.customAt)} max={16} required onChange={(customAt) => set({ customAt })} />
          )}
          <TextField label="Label" value={text(data.label)} max={80} onChange={(label) => set({ label })} help="Optional, such as “Until registration closes”." />
          <p className="field-help">After the start it says “Happening now”, then “This event has ended”.</p>
        </div>
      );
    case "CUSTOM_HTML":
      return <CustomHtmlEditor eventId={eventId} section={section} index={index} isSystemAdmin={isSystemAdmin} updateSection={updateSection} />;
    default:
      return null;
  }
}

/** What a block looks like, from the draft as it stands. Custom HTML previews itself, from the sanitizer's output. */
export function BlockPreview({
  section,
  index,
  assets,
  eventSlug,
  eventTiming,
}: {
  section: SectionDraft;
  index: number;
  assets: EventAssetRecord[];
  eventSlug: string;
  eventTiming: EventBlockEvent;
}) {
  const assetUrl = (assetId: string) => assets.find((asset) => asset.id === assetId)?.url ?? "";
  const previewSection = {
    id: `preview-${index}`,
    kind: section.kind,
    title: section.title || "Untitled block",
    body: section.body,
    placement: "BOTH" as const,
    data: section.data ?? {},
  };
  // The renderer reads with the same schemas the server saves with, so a
  // draft that is not valid yet shows a hint instead of a half-drawn block.
  const complete = section.kind === "FORMATTED_TEXT" || section.kind === "CUSTOM_HTML"
    ? true
    : parseBlockData(section.kind as never, section.data ?? {}) !== null;
  if (!complete) {
    return <p className="field-help">Fill in the required fields to see a preview.</p>;
  }
  if (section.kind === "HERO") {
    return parseBlockData("HERO", section.data ?? {})
      ? <EventHeroBanner section={previewSection} assetUrl={assetUrl} />
      : <p className="field-help">Choose an image and describe it to see the banner.</p>;
  }
  return (
    <EventContentBlocks
      sections={[previewSection]}
      placement="page"
      assetUrl={assetUrl}
      event={eventTiming}
      idPrefix={`preview-${eventSlug}`}
    />
  );
}
