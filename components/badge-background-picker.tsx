"use client";

import { useRef, useState } from "react";
import { ImagePlus, LoaderCircle, Trash2 } from "lucide-react";

type BackgroundOption = {
  id: string;
  displayName: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  url: string;
};

type SelectedBackground = {
  id: string;
  displayName: string;
  url: string;
};

/**
 * Chooses the artwork printed behind every name badge, and uploads a new
 * image into the event's file library on the way.
 *
 * Uploading goes through the same endpoint the rest of the event's files use,
 * so a file that is not the kind of file it claims to be is refused before it
 * is ever stored — a badge background is not a reason for a second, looser
 * upload path.
 */
export function BadgeBackgroundPicker({
  eventId,
  initialBackground,
  initialOptions,
}: {
  eventId: string;
  initialBackground: SelectedBackground | null;
  initialOptions: BackgroundOption[];
}) {
  const [background, setBackground] = useState(initialBackground);
  const [options, setOptions] = useState(initialOptions);
  const [busy, setBusy] = useState<"upload" | "select" | null>(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function chooseBackground(assetId: string | null) {
    setBusy("select");
    setError("");
    try {
      const response = await fetch(`/api/events/${eventId}/badge-background`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message ?? "Unable to save the badge background.");
      }
      setBackground(result.background);
      setOptions(result.options);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the badge background.");
    } finally {
      setBusy(null);
    }
  }

  async function uploadBackground(file: File) {
    setBusy("upload");
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(`/api/events/${eventId}/assets`, {
        method: "POST",
        body,
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message ?? "Unable to upload that image.");
      }
      await chooseBackground(result.asset.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to upload that image.");
      setBusy(null);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <section className="panel badge-background-picker" aria-label="Name badge background">
      <div className="badge-background-heading">
        <div>
          <p className="eyebrow">Badge artwork</p>
          <h3>{background ? background.displayName : "No background selected"}</h3>
          <p className="quiet-copy">
            Printed behind every name on the sheet. Design it at the badge’s
            own proportions — it is scaled to cover each badge, so anything
            near an edge can be cropped. Turn on “background graphics” in the
            browser’s print dialog.
          </p>
        </div>
        <div className="badge-background-actions">
          <label className="secondary-button">
            {busy === "upload"
              ? <LoaderCircle aria-hidden="true" className="spin" size={16} />
              : <ImagePlus aria-hidden="true" size={16} />}
            {busy === "upload" ? "Uploading…" : "Upload artwork"}
            <input
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              disabled={busy !== null}
              onChange={(changeEvent) => {
                const file = changeEvent.target.files?.[0];
                if (file) void uploadBackground(file);
              }}
              ref={fileInputRef}
              type="file"
            />
          </label>
          {background && (
            <button
              className="text-button"
              disabled={busy !== null}
              onClick={() => void chooseBackground(null)}
              type="button"
            >
              <Trash2 aria-hidden="true" size={15} /> Print without artwork
            </button>
          )}
        </div>
      </div>

      {options.length > 0 && (
        <ul className="badge-background-options">
          {options.map((option) => (
            <li key={option.id}>
              <button
                aria-pressed={background?.id === option.id}
                className={background?.id === option.id ? "is-selected" : ""}
                disabled={busy !== null}
                onClick={() => void chooseBackground(option.id)}
                type="button"
              >
                {/* Served from a permission-checked route, so it bypasses the
                    optimizing image cache. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="" aria-hidden="true" src={option.url} />
                <small>{option.displayName}</small>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
