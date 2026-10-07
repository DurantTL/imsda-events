import { Fragment, type ReactNode } from "react";
import { Mail, MapPin, Phone } from "lucide-react";
import { EventCountdown } from "@/components/event-countdown";
import { EventGallery } from "@/components/event-gallery";
import type { EventContentSectionRecord } from "@/modules/events/content-repository";
import type { SanitizedHtml } from "@/modules/events/content-html";
import { formatCountdownTarget, zonedLocalToDate } from "@/modules/events/content-countdown";
import { embedSrc } from "@/modules/events/content-embeds";
import {
  parseMarkdown,
  type MarkdownInline,
} from "@/modules/events/content-markdown";
import {
  canPlaceOnRegistrationForm,
  contentBlocks,
  parseBlockData,
  type EventContentKind,
} from "@/modules/events/content-schemas";

/**
 * The public-page blocks of #816: banner, photos, gallery, formatted text,
 * video or map, questions and answers, custom HTML, schedule, speakers,
 * contact cards and the countdown.
 *
 * Everything is rendered by React from validated plain values, so each string
 * is escaped. The two exceptions are named here: custom HTML is injected only
 * as `SanitizedHtml` (a type nothing but the sanitizer can produce), and an
 * embed's iframe address is built by `embedSrc` from a provider and id.
 */

export type EventBlockSection = Pick<
  EventContentSectionRecord,
  "id" | "kind" | "title" | "body" | "placement" | "data"
>;

/** Kinds this component renders; the info cards and older kinds have their own renderers. */
export const eventBlockKinds: readonly EventContentKind[] = [
  "HERO", "IMAGE", "GALLERY", "FORMATTED_TEXT", "EMBED", "FAQ",
  "CUSTOM_HTML", "SCHEDULE", "SPEAKERS", "CONTACT", "COUNTDOWN",
];

export function isEventBlockKind(kind: EventContentKind) {
  return eventBlockKinds.includes(kind);
}

/** Where a public visitor fetches an uploaded image of a published page. */
export function publicEventAssetUrl(eventSlug: string, assetId: string) {
  return `/api/public/events/${encodeURIComponent(eventSlug)}/assets/${encodeURIComponent(assetId)}`;
}

export type EventBlockEvent = { startsAt: string; endsAt: string; timezone: string };

function renderInline(nodes: MarkdownInline[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === "text") return <Fragment key={index}>{node.text}</Fragment>;
    if (node.type === "strong") return <strong key={index}>{renderInline(node.children)}</strong>;
    if (node.type === "em") return <em key={index}>{renderInline(node.children)}</em>;
    const isMail = node.href.toLowerCase().startsWith("mailto:");
    return (
      <a
        key={index}
        href={node.href}
        {...(isMail ? {} : { target: "_blank", rel: "noopener noreferrer" })}
      >
        {renderInline(node.children)}
      </a>
    );
  });
}

/** Formatted text. Headings sit under the section's own h2, so `##` is an h3. */
export function FormattedText({ source }: { source: string }) {
  return (
    <div className="event-block-body event-formatted-text">
      {parseMarkdown(source).map((block, index) => {
        if (block.type === "heading") {
          return block.level === 2
            ? <h3 key={index}>{renderInline(block.children)}</h3>
            : <h4 key={index}>{renderInline(block.children)}</h4>;
        }
        if (block.type === "ul") {
          return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>;
        }
        if (block.type === "ol") {
          return <ol key={index} start={block.start}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>;
        }
        return <p key={index}>{renderInline(block.children)}</p>;
      })}
    </div>
  );
}

function PlainText({ text }: { text: string }) {
  return (
    <>
      {contentBlocks(text).map((block, index) => {
        if (block.kind === "UNORDERED_LIST") {
          return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>;
        }
        if (block.kind === "ORDERED_LIST") {
          return <ol key={index}>{block.items.map((item, itemIndex) => <li value={item.value} key={itemIndex}>{item.text}</li>)}</ol>;
        }
        return <p key={index}>{block.text}</p>;
      })}
    </>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("");
}

/**
 * The header banner. One per page, shown first. The title is the page's h1
 * (the page demotes its own heading when a banner is present). The image loads
 * eagerly because it is the largest thing above the fold.
 */
export function EventHeroBanner({
  section,
  assetUrl,
}: {
  section: EventBlockSection;
  assetUrl: (assetId: string) => string;
}) {
  const data = parseBlockData("HERO", section.data);
  if (!data) return null;
  const titleId = `event-hero-title-${section.id}`;
  const buttonHref = data.button
    ? data.button.target === "REGISTER" ? "#registration-options-title" : data.button.url
    : null;
  return (
    <section className="event-hero-banner" aria-labelledby={titleId}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="event-hero-image"
        src={assetUrl(data.assetId)}
        alt={data.alt}
        loading="eager"
        fetchPriority="high"
        decoding="async"
        style={{ objectPosition: `${data.focalX}% ${data.focalY}%` }}
      />
      <div className="event-hero-scrim" style={{ backgroundColor: `rgba(8, 20, 33, ${data.overlay / 100})` }} aria-hidden="true" />
      <div className="event-hero-copy">
        <h1 id={titleId}>{section.title}</h1>
        {data.subtitle && <p>{data.subtitle}</p>}
        {data.button && buttonHref && (
          data.button.target === "REGISTER"
            ? <a className="event-hero-button" href={buttonHref}>{data.button.label}</a>
            : <a className="event-hero-button" href={buttonHref} target="_blank" rel="noopener noreferrer">{data.button.label}</a>
        )}
      </div>
    </section>
  );
}

/**
 * Every block except the banner, in the order staff set. `placement` picks the
 * surface: the public page shows PUBLIC_PAGE and BOTH, the registration form
 * shows REGISTRATION_FORM and BOTH (and only the text-style kinds).
 */
export function EventContentBlocks({
  sections,
  placement,
  assetUrl,
  event,
  nowMs,
  sanitizedHtml,
  idPrefix = "event-block",
}: {
  sections: EventBlockSection[];
  placement: "page" | "registration";
  assetUrl: (assetId: string) => string;
  /** Needed by the countdown. */
  event?: EventBlockEvent;
  /** The server's clock at render, so the countdown's first client paint matches. */
  nowMs?: number;
  /** Custom HTML, already sanitized, by section id. A section missing here renders nothing. */
  sanitizedHtml?: Record<string, SanitizedHtml>;
  idPrefix?: string;
}) {
  const visible = sections.filter((section) => (
    isEventBlockKind(section.kind)
    && section.kind !== "HERO"
    && (placement === "registration" ? canPlaceOnRegistrationForm(section.kind) : true)
    && (section.placement === "BOTH"
      || section.placement === (placement === "page" ? "PUBLIC_PAGE" : "REGISTRATION_FORM"))
  ));
  if (visible.length === 0) return null;

  const rendered = visible.map((section) => {
    const headingId = `${idPrefix}-${placement}-${section.id}`;
    const heading = <h2 id={headingId}>{section.title}</h2>;
    const className = `event-block event-block-${section.kind.toLowerCase().replace(/_/g, "-")}`;

    if (section.kind === "FORMATTED_TEXT") {
      if (!section.body.trim()) return null;
      return (
        <section className={className} aria-labelledby={headingId} key={section.id}>
          {heading}
          <FormattedText source={section.body} />
        </section>
      );
    }

    if (section.kind === "CUSTOM_HTML") {
      const html = sanitizedHtml?.[section.id];
      if (!html) return null;
      return (
        <section className={className} aria-label={section.title} key={section.id}>
          <div className="event-custom-html" dangerouslySetInnerHTML={{ __html: html }} />
        </section>
      );
    }

    if (section.kind === "IMAGE") {
      const data = parseBlockData("IMAGE", section.data);
      if (!data) return null;
      return (
        <section className={`${className} is-${data.imageSide.toLowerCase()}`} aria-labelledby={headingId} key={section.id}>
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={assetUrl(data.assetId)} alt={data.alt} loading="lazy" decoding="async" />
            {data.caption && <figcaption>{data.caption}</figcaption>}
          </figure>
          <div className="event-block-image-text">
            {heading}
            {section.body.trim() && <div className="event-block-body"><PlainText text={section.body} /></div>}
          </div>
        </section>
      );
    }

    if (section.kind === "GALLERY") {
      const data = parseBlockData("GALLERY", section.data);
      if (!data) return null;
      return (
        <section className={className} aria-labelledby={headingId} key={section.id}>
          {heading}
          <EventGallery
            labelId={headingId}
            images={data.images.map((image) => ({ src: assetUrl(image.assetId), alt: image.alt, caption: image.caption }))}
          />
        </section>
      );
    }

    if (section.kind === "EMBED") {
      const data = parseBlockData("EMBED", section.data);
      const src = data ? embedSrc(data.provider, data.id) : null;
      if (!data || !src) return null;
      return (
        <section className={className} aria-labelledby={headingId} key={section.id}>
          {heading}
          <div className={`event-embed-frame is-${data.provider === "GOOGLE_MAPS" ? "map" : "video"}`}>
            <iframe
              src={src}
              title={data.title}
              loading="lazy"
              allowFullScreen={data.provider !== "GOOGLE_MAPS"}
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            />
          </div>
        </section>
      );
    }

    if (section.kind === "FAQ") {
      const data = parseBlockData("FAQ", section.data);
      if (!data) return null;
      return (
        <section className={className} aria-labelledby={headingId} key={section.id}>
          {heading}
          <div className="event-faq-list">
            {data.entries.map((entry, index) => (
              <details key={index}>
                <summary>{entry.question}</summary>
                <div className="event-faq-answer"><PlainText text={entry.answer} /></div>
              </details>
            ))}
          </div>
        </section>
      );
    }

    if (section.kind === "SCHEDULE") {
      const data = parseBlockData("SCHEDULE", section.data);
      if (!data) return null;
      // Days in the order staff first wrote them, rows in the order given.
      const days = new Map<string, typeof data.rows>();
      for (const row of data.rows) days.set(row.day, [...(days.get(row.day) ?? []), row]);
      return (
        <section className={className} aria-labelledby={headingId} key={section.id}>
          {heading}
          {[...days.entries()].map(([day, rows]) => (
            <div className="event-schedule-day" key={day}>
              <h3>{day}</h3>
              <ol>
                {rows.map((row, index) => (
                  <li key={index}>
                    <span className="event-schedule-time">{row.time}</span>
                    <div>
                      <strong>{row.title}</strong>
                      {row.location && <span className="event-schedule-location"><MapPin size={14} aria-hidden="true" /> {row.location}</span>}
                      {row.description && <p>{row.description}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      );
    }

    if (section.kind === "SPEAKERS") {
      const data = parseBlockData("SPEAKERS", section.data);
      if (!data) return null;
      return (
        <section className={className} aria-labelledby={headingId} key={section.id}>
          {heading}
          <ul className="event-speaker-grid">
            {data.speakers.map((speaker, index) => (
              <li key={index}>
                <article className="event-speaker-card">
                  {speaker.assetId
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={assetUrl(speaker.assetId)} alt={speaker.alt} loading="lazy" decoding="async" />
                    : <span className="event-speaker-initials" aria-hidden="true">{initials(speaker.name)}</span>}
                  <h3>{speaker.name}</h3>
                  {speaker.role && <p className="event-speaker-role">{speaker.role}</p>}
                  {speaker.bio && <p>{speaker.bio}</p>}
                </article>
              </li>
            ))}
          </ul>
        </section>
      );
    }

    if (section.kind === "CONTACT") {
      const data = parseBlockData("CONTACT", section.data);
      if (!data) return null;
      return (
        <section className={className} aria-labelledby={headingId} key={section.id}>
          {heading}
          <ul className="event-contact-grid">
            {data.contacts.map((contact, index) => (
              <li key={index}>
                <article className="event-contact-card">
                  <h3>{contact.name}</h3>
                  {contact.role && <p className="event-contact-role">{contact.role}</p>}
                  {contact.email && (
                    <a href={`mailto:${contact.email}`}><Mail size={16} aria-hidden="true" /> {contact.email}</a>
                  )}
                  {contact.phone && (
                    <a href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}><Phone size={16} aria-hidden="true" /> {contact.phone}</a>
                  )}
                </article>
              </li>
            ))}
          </ul>
        </section>
      );
    }

    if (section.kind === "COUNTDOWN") {
      const data = parseBlockData("COUNTDOWN", section.data);
      if (!data || !event) return null;
      const isEventStart = data.target === "EVENT_START";
      const target = isEventStart
        ? new Date(event.startsAt)
        : zonedLocalToDate(data.customAt, event.timezone);
      if (!target || Number.isNaN(target.getTime())) return null;
      return (
        <section className={className} aria-labelledby={headingId} key={section.id}>
          {heading}
          {data.label && <p className="event-countdown-label">{data.label}</p>}
          <EventCountdown
            targetMs={target.getTime()}
            endMs={isEventStart ? new Date(event.endsAt).getTime() : null}
            targetLabel={formatCountdownTarget(target, event.timezone)}
            isEventStart={isEventStart}
            initialNowMs={nowMs ?? target.getTime()}
          />
        </section>
      );
    }

    return null;
  });

  if (rendered.every((node) => node === null)) return null;
  return <div className="event-blocks" data-placement={placement}>{rendered}</div>;
}
