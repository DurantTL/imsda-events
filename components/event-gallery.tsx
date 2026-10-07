"use client";

import { useCallback, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";

export type EventGalleryImage = { src: string; alt: string; caption: string };

/**
 * A grid of event photos. Tapping one opens a larger view in an accessible
 * dialog: Escape closes it, the arrow keys move between photos, Tab stays
 * inside, and focus goes back to the photo that opened it. Every image has the
 * alt text staff wrote, and the grid works without script as plain images.
 */
export function EventGallery({
  images,
  labelId,
}: {
  images: EventGalleryImage[];
  /** Id of the section heading, so the dialog is named after it. */
  labelId: string;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const close = useCallback(() => setOpenIndex(null), []);
  const dialogRef = useAccessibleDialog<HTMLDivElement>(openIndex !== null, close);

  const move = (step: number) => {
    setOpenIndex((current) => (
      current === null ? current : (current + step + images.length) % images.length
    ));
  };
  const current = openIndex === null ? null : images[openIndex];

  return (
    <>
      <ul className="event-gallery-grid">
        {images.map((image, index) => (
          <li key={`${image.src}:${index}`}>
            <button
              type="button"
              className="event-gallery-thumb"
              onClick={() => setOpenIndex(index)}
              aria-haspopup="dialog"
              aria-label={`Open larger view: ${image.alt}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.src} alt={image.alt} loading="lazy" decoding="async" />
            </button>
            {image.caption && <p className="event-gallery-caption">{image.caption}</p>}
          </li>
        ))}
      </ul>
      {current && openIndex !== null && (
        <div className="event-gallery-backdrop" onClick={close}>
          <div
            ref={dialogRef}
            className="event-gallery-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelId}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                move(-1);
              }
            }}
          >
            <div className="event-gallery-dialog-bar">
              <p aria-live="polite">Photo {openIndex + 1} of {images.length}</p>
              <button type="button" onClick={close} aria-label="Close larger view">
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={current.src} alt={current.alt} decoding="async" />
              {current.caption && <figcaption>{current.caption}</figcaption>}
            </figure>
            {images.length > 1 && (
              <div className="event-gallery-dialog-nav">
                <button type="button" onClick={() => move(-1)} aria-label="Previous photo">
                  <ChevronLeft size={22} aria-hidden="true" />
                </button>
                <button type="button" onClick={() => move(1)} aria-label="Next photo">
                  <ChevronRight size={22} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
