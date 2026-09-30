import {
  CalendarClock,
  CircleCheck,
  CircleHelp,
  ClipboardCheck,
  ExternalLink,
  FileDown,
  Info,
  Mail,
  SquareCheck,
} from "lucide-react";
import type { ComponentType } from "react";
import type { EventContentSectionRecord } from "@/modules/events/content-repository";
import {
  contentBlocks,
  isInfoCardKind,
  safeContentHref,
  type EventContentTone,
} from "@/modules/events/content-schemas";

/** Shown as text beside the icon, so a tone never depends on colour alone. */
export const eventContentToneLabels: Record<EventContentTone, string> = {
  INFO: "Good to know",
  DEADLINE: "Deadline",
  REQUIREMENT: "Requirement",
  SUCCESS: "Confirmation",
  HELP: "Need help?",
};

const toneIcons: Record<EventContentTone, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  INFO: Info,
  DEADLINE: CalendarClock,
  REQUIREMENT: ClipboardCheck,
  SUCCESS: CircleCheck,
  HELP: CircleHelp,
};

export type EventInfoCardSection = Pick<
  EventContentSectionRecord,
  "id" | "kind" | "title" | "body" | "tone" | "placement" | "items" | "links"
>;

/**
 * Info cards: notices, numbered steps, and checklists.
 *
 * Everything here is plain text. React escapes each string, there is no raw
 * HTML path, and a link only becomes an anchor when `safeContentHref` accepts
 * it (http, https, or mailto).
 */
export function EventInfoCards({
  sections,
  eventSlug,
  placement,
  preview = false,
}: {
  /** Staff preview: an uploaded file has no public address yet, so show its label as text. */
  preview?: boolean;
  sections: EventInfoCardSection[];
  eventSlug: string;
  /** Which surface is rendering, so a card placed elsewhere is left out. */
  placement: "page" | "registration";
}) {
  const cards = sections.filter((section) => (
    isInfoCardKind(section.kind)
    && (section.placement === "BOTH"
      || section.placement === (placement === "page" ? "PUBLIC_PAGE" : "REGISTRATION_FORM"))
  ));
  if (cards.length === 0) return null;

  return (
    <div className="event-info-cards" data-placement={placement}>
      {cards.map((card) => {
        const headingId = `event-info-card-${placement}-${card.id}`;
        if (card.kind === "NOTICE") {
          const tone = card.tone ?? "INFO";
          const Icon = toneIcons[tone];
          return (
            <section
              className={`event-info-card is-${tone.toLowerCase()}`}
              aria-labelledby={headingId}
              key={card.id}
            >
              <header className="event-info-card-heading">
                <span className="event-info-card-icon" aria-hidden="true"><Icon size={20} aria-hidden /></span>
                <div>
                  <p className="event-info-card-tone">{eventContentToneLabels[tone]}</p>
                  <h2 id={headingId}>{card.title}</h2>
                </div>
              </header>
              <div className="event-info-card-body">
                {contentBlocks(card.body).map((block, blockIndex) => {
                  if (block.kind === "UNORDERED_LIST") {
                    return <ul key={blockIndex}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>;
                  }
                  if (block.kind === "ORDERED_LIST") {
                    return (
                      <ol key={blockIndex}>
                        {block.items.map((item, itemIndex) => <li value={item.value} key={itemIndex}>{item.text}</li>)}
                      </ol>
                    );
                  }
                  return <p key={blockIndex}>{block.text}</p>;
                })}
              </div>
              {card.links.length > 0 && (
                <ul className="event-info-card-links">
                  {card.links.map((link, linkIndex) => {
                    if (preview && link.assetId) {
                      return (
                        <li key={linkIndex}>
                          <span className="event-info-card-file-text">
                            <FileDown size={16} aria-hidden="true" />
                            <span><strong>{link.label}</strong>{link.description && <small>{link.description}</small>}</span>
                          </span>
                        </li>
                      );
                    }
                    const href = link.assetId
                      ? `/api/public/events/${encodeURIComponent(eventSlug)}/assets/${encodeURIComponent(link.assetId)}`
                      : safeContentHref(link.url);
                    if (!href) return null;
                    const isMail = href.toLowerCase().startsWith("mailto:");
                    return (
                      <li key={linkIndex}>
                        <a
                          href={href}
                          {...(isMail ? {} : { target: "_blank", rel: "noopener noreferrer" })}
                        >
                          {link.assetId ? <FileDown size={16} aria-hidden="true" /> : isMail ? <Mail size={16} aria-hidden="true" /> : <ExternalLink size={16} aria-hidden="true" />}
                          <span>
                            <strong>{link.label}</strong>
                            {link.description && <small>{link.description}</small>}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        }

        if (card.items.length === 0) return null;
        const isSteps = card.kind === "STEPS";
        return (
          <section
            className={`event-info-card ${isSteps ? "is-steps" : "is-checklist"}`}
            aria-labelledby={headingId}
            key={card.id}
          >
            <header className="event-info-card-heading">
              <span className="event-info-card-icon" aria-hidden="true">
                {isSteps ? <ClipboardCheck size={20} aria-hidden /> : <SquareCheck size={20} aria-hidden />}
              </span>
              <div>
                <p className="event-info-card-tone">{isSteps ? "Steps" : "Have ready"}</p>
                <h2 id={headingId}>{card.title}</h2>
              </div>
            </header>
            {isSteps ? (
              <ol className="event-info-card-steps">
                {card.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <strong>{item.title}</strong>
                    {item.text && <span>{item.text}</span>}
                  </li>
                ))}
              </ol>
            ) : (
              <ul className="event-info-card-checklist">
                {card.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <SquareCheck size={16} aria-hidden="true" />
                    <span>{item.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
