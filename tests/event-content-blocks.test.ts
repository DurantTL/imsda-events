import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { EventContentBlocks, EventHeroBanner } from "@/components/event-content-blocks";
import { sanitizedHtmlBySection } from "@/modules/events/content-html";
import { parseMarkdown } from "@/modules/events/content-markdown";
import {
  canPlaceOnRegistrationForm,
  eventContentInputSchema,
  eventContentSectionInputSchema,
  eventContentKinds,
  isSystemAdminOnlyKind,
} from "@/modules/events/content-schemas";

const mapsId = `!1m18!1m12!1m3!1d3000.5!2d-93.6!3d41.6!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2sSynthetic!5e0!3m2!1sen!2sus!4v1700000000000`;
const assetUrl = (id: string) => `/api/public/events/synthetic-event/assets/${id}`;
const event = { startsAt: "2026-10-09T23:00:00.000Z", endsAt: "2026-10-11T17:00:00.000Z", timezone: "America/Chicago" };

type Section = Parameters<typeof EventContentBlocks>[0]["sections"][number];
const block = (kind: Section["kind"], title: string, data: Record<string, unknown>, extra: Partial<Section> = {}): Section => ({
  id: `id-${kind.toLowerCase()}`, kind, title, body: "", placement: "PUBLIC_PAGE", data, ...extra,
});

const everyBlock: Section[] = [
  block("IMAGE", "On site", { assetId: "a1", alt: "The chapel at dusk", caption: "Chapel", imageSide: "RIGHT" }, { body: "Text beside the photo." }),
  block("GALLERY", "Photos", { images: [{ assetId: "a2", alt: "Campfire", caption: "Friday night" }, { assetId: "a3", alt: "Lake", caption: "" }] }),
  block("FORMATTED_TEXT", "Welcome", {}, { body: "## Hello\n\nSome **bold**, *italic* and a [link](https://example.org).\n\n- One\n- Two\n\n1. First\n2. Second\n\n<script>alert(1)</script>" }),
  block("EMBED", "Video", { provider: "YOUTUBE", id: "dQw4w9WgXcQ", title: "Welcome video" }),
  block("EMBED", "Map", { provider: "GOOGLE_MAPS", id: mapsId, title: "Map of the camp" }, { id: "id-map" }),
  block("FAQ", "Questions", { entries: [{ question: "Where do I park?", answer: "North lot." }] }),
  block("CUSTOM_HTML", "Banner", {}, { body: `<p>Hi</p><script>alert(1)</script>` }),
  block("SCHEDULE", "Agenda", { rows: [{ day: "Friday", time: "7:00 PM", title: "Worship", location: "Chapel", description: "Singing" }] }),
  block("SPEAKERS", "Speakers", { speakers: [{ name: "Pat Example", role: "Pastor", bio: "Synthetic bio.", assetId: "a4", alt: "Pat smiling" }] }),
  block("CONTACT", "Contact", { contacts: [{ name: "Sam Example", role: "Director", email: "sam@example.org", phone: "(555) 010-0100" }] }),
  block("COUNTDOWN", "Starts in", { target: "EVENT_START", customAt: "", label: "" }),
];

function render(sections: Section[], placement: "page" | "registration" = "page") {
  return renderToStaticMarkup(createElement(EventContentBlocks, {
    sections,
    placement,
    assetUrl,
    event,
    nowMs: Date.parse("2026-10-01T00:00:00Z"),
    sanitizedHtml: sanitizedHtmlBySection(sections),
  }));
}

describe("public page blocks render (#816)", () => {
  const markup = render(everyBlock);

  it("renders every block under its own heading, in order", () => {
    const headings = [...markup.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1]);
    expect(headings).toEqual(["On site", "Photos", "Welcome", "Video", "Map", "Questions", "Agenda", "Speakers", "Contact", "Starts in"]);
    // Custom HTML carries no extra heading of its own.
    expect(markup).toContain("<p>Hi</p>");
  });

  it("shows only images from the event's own uploads, with alt text, lazily", () => {
    const images = [...markup.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
    expect(images.length).toBeGreaterThanOrEqual(4);
    for (const image of images) {
      expect(image).toMatch(/src="\/api\/public\/events\/synthetic-event\/assets\/a\d"/);
      expect(image).toMatch(/alt="[^"]+"/);
      expect(image).toContain('loading="lazy"');
    }
    expect(markup).not.toMatch(/<img[^>]+src="https?:/);
  });

  it("builds iframes only from the provider allowlist", () => {
    const frames = [...markup.matchAll(/<iframe\b[^>]*>/g)].map((match) => match[0]);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0"');
    expect(frames[1]).toContain('src="https://www.google.com/maps/embed?pb=');
    for (const frame of frames) {
      expect(frame).toMatch(/title="[^"]+"/);
      expect(frame).toContain('loading="lazy"');
    }
  });

  it("skips an embed whose stored id is not valid, rather than framing it", () => {
    const html = render([block("EMBED", "Bad", { provider: "YOUTUBE", id: "https://evil.example/x", title: "x" })]);
    expect(html).not.toContain("<iframe");
  });

  it("never emits script from formatted text or custom HTML", () => {
    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).toContain("<em>italic</em>");
    expect(markup).toContain('href="https://example.org"');
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<ol>");
  });

  it("renders the FAQ as details and summary", () => {
    expect(markup).toMatch(/<details[^>]*><summary[^>]*>Where do I park\?<\/summary>/);
  });

  it("makes contact details clickable, from only what staff entered", () => {
    expect(markup).toContain('href="mailto:sam@example.org"');
    expect(markup).toContain('href="tel:5550100100"');
    const emailOnly = render([block("CONTACT", "Contact", { contacts: [{ name: "Sam", role: "", email: "sam@example.org", phone: "" }] })]);
    expect(emailOnly).not.toContain("tel:");
  });

  it("renders the countdown's date on the server, before any script runs", () => {
    expect(markup).toMatch(/event-countdown/);
    expect(markup).toMatch(/Friday, October 9|Oct(ober)? 9/);
  });

  it("renders nothing for a block that does not validate", () => {
    expect(render([block("GALLERY", "Photos", { images: [] })])).toBe("");
    expect(render([block("SCHEDULE", "Agenda", { rows: [{ day: "" }] })])).toBe("");
  });

  it("renders no custom HTML that was not sanitized for it", () => {
    const html = renderToStaticMarkup(createElement(EventContentBlocks, {
      sections: [block("CUSTOM_HTML", "Banner", {}, { body: "<script>alert(1)</script>" })],
      placement: "page",
      assetUrl,
    }));
    expect(html).toBe("");
  });

  it("puts the banner's title in the page's h1 with an eager, described image", () => {
    const html = renderToStaticMarkup(createElement(EventHeroBanner, {
      assetUrl,
      section: block("HERO", "Fall Retreat", { assetId: "h1", alt: "Pines at sunrise", subtitle: "Join us", button: { label: "Register", target: "REGISTER", url: null }, focalX: 30, focalY: 60, overlay: 50 }),
    }));
    expect(html).toContain("<h1");
    expect(html).toContain("Fall Retreat");
    expect(html).toContain('alt="Pines at sunrise"');
    expect(html).toContain('loading="eager"');
    expect(html).toContain('href="#registration-options-title"');
    expect(html).toContain("object-position:30% 60%");
  });

  it("shows placement: public page blocks stay off the registration form", () => {
    const forForm = (kind: Section["kind"], data: Record<string, unknown>, body = "text") => render(
      [block(kind, "X", data, { body, placement: "BOTH" })],
      "registration",
    );
    expect(forForm("FORMATTED_TEXT", {})).toContain("event-block-formatted-text");
    expect(forForm("FAQ", { entries: [{ question: "Q?", answer: "A." }] })).toContain("<details");
    expect(forForm("GALLERY", { images: [{ assetId: "a", alt: "x", caption: "" }] })).toBe("");
    expect(forForm("EMBED", { provider: "VIMEO", id: "76979871", title: "t" })).toBe("");
    // A block set to the registration form only is not on the public page.
    expect(render([block("FAQ", "X", { entries: [{ question: "Q?", answer: "A." }] }, { placement: "REGISTRATION_FORM" })])).toBe("");
  });
});

describe("formatted text is parsed, never passed through as HTML", () => {
  it("keeps raw HTML as literal text and refuses unsafe links", () => {
    const tree = JSON.stringify(parseMarkdown(`[x](javascript:alert(1)) <img src=x onerror=alert(1)> [y](data:text/html,x)`));
    expect(tree).not.toContain('"type":"link"');
    expect(tree).toContain("onerror");
  });
});

describe("block schemas", () => {
  const base = { title: "Block", isPublished: true };

  it("requires alt text on every image", () => {
    const hero = { assetId: "a1", alt: "x" };
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "HERO", data: hero }).success).toBe(true);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "HERO", data: { ...hero, alt: "  " } }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "IMAGE", data: { assetId: "a1", alt: "" } }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "GALLERY", data: { images: [{ assetId: "a1", alt: "" }] } }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "SPEAKERS", data: { speakers: [{ name: "P", assetId: "a1", alt: "" }] } }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "SPEAKERS", data: { speakers: [{ name: "P" }] } }).success).toBe(true);
  });

  it("refuses an image given as an address instead of an uploaded file", () => {
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "IMAGE", data: { assetId: "a1", alt: "x", src: "https://evil.example/x.png" } }).success).toBe(false);
  });

  it("allows one banner per page and keeps it off the registration form", () => {
    const hero = { ...base, kind: "HERO", data: { assetId: "a1", alt: "x" } };
    expect(eventContentInputSchema.safeParse({ sections: [hero] }).success).toBe(true);
    expect(eventContentInputSchema.safeParse({ sections: [hero, hero] }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...hero, placement: "BOTH" }).success).toBe(false);
  });

  it("requires a button's address to be https when it is not the registration button", () => {
    const hero = (button: unknown) => ({ ...base, kind: "HERO", data: { assetId: "a1", alt: "x", button } });
    expect(eventContentSectionInputSchema.safeParse(hero({ label: "Go", target: "URL", url: "https://example.org" })).success).toBe(true);
    for (const url of ["javascript:alert(1)", "http://example.org", "data:text/html,x", ""]) {
      expect(eventContentSectionInputSchema.safeParse(hero({ label: "Go", target: "URL", url })).success, url).toBe(false);
    }
    expect(eventContentSectionInputSchema.safeParse(hero({ label: "Register", target: "REGISTER" })).success).toBe(true);
  });

  it("validates the other kinds' rows", () => {
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "FAQ", data: { entries: [{ question: "Q", answer: "A" }] } }).success).toBe(true);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "FAQ", data: { entries: [] } }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "SCHEDULE", data: { rows: [{ day: "Fri", time: "7pm", title: "Worship" }] } }).success).toBe(true);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "SCHEDULE", data: { rows: [{ day: "Fri", time: "", title: "Worship" }] } }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "CONTACT", data: { contacts: [{ name: "S", email: "s@example.org" }] } }).success).toBe(true);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "CONTACT", data: { contacts: [{ name: "S" }] } }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "CONTACT", data: { contacts: [{ name: "S", email: "javascript:x" }] } }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "COUNTDOWN", data: { target: "CUSTOM", customAt: "" } }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "COUNTDOWN", data: { target: "CUSTOM", customAt: "2026-10-09T18:00" } }).success).toBe(true);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "FORMATTED_TEXT", body: "" }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...base, kind: "FORMATTED_TEXT", body: "**hi**" }).success).toBe(true);
  });

  it("knows which kinds are system-administrator only and which can go on the form", () => {
    expect(eventContentKinds.filter(isSystemAdminOnlyKind)).toEqual(["CUSTOM_HTML"]);
    expect(eventContentKinds.filter(canPlaceOnRegistrationForm).sort()).toEqual(["CHECKLIST", "CONTACT", "FAQ", "FORMATTED_TEXT", "NOTICE", "STEPS"]);
  });
});
