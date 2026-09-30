import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { EventInfoCards, type EventInfoCardSection } from "@/components/event-info-cards";
import { replaceEventContent } from "@/modules/events/content-repository";
import {
  eventContentInputSchema,
  eventContentSectionInputSchema,
  safeContentHref,
} from "@/modules/events/content-schemas";

const notice = {
  kind: "NOTICE",
  title: "Registration deadline",
  body: "Register by the closing date.\n- Bring your form\n- Pay online",
  tone: "DEADLINE",
  isPublished: true,
  links: [{ label: "Email the office", description: "", url: "mailto:office@example.org" }],
};

describe("info card schemas", () => {
  it("accepts a notice with a tone, plain text, and a mailto link", () => {
    const parsed = eventContentSectionInputSchema.parse(notice);
    expect(parsed.tone).toBe("DEADLINE");
    expect(parsed.placement).toBe("PUBLIC_PAGE");
    expect(parsed.links[0].url).toBe("mailto:office@example.org");
  });

  it("requires a tone and some content for a notice", () => {
    expect(eventContentSectionInputSchema.safeParse({ ...notice, tone: null }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...notice, body: "", links: [] }).success).toBe(false);
  });

  it("requires entries for steps and checklists, and titles on each entry", () => {
    const steps = { kind: "STEPS", title: "How to register", items: [{ title: "Choose a form", text: "Pick one." }] };
    expect(eventContentSectionInputSchema.safeParse(steps).success).toBe(true);
    expect(eventContentSectionInputSchema.safeParse({ ...steps, items: [] }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...steps, items: [{ title: "  ", text: "x" }] }).success).toBe(false);
    const checklist = { kind: "CHECKLIST", title: "Have ready", items: [{ title: "Roster" }, { title: "Payment method" }] };
    expect(eventContentSectionInputSchema.safeParse(checklist).success).toBe(true);
    expect(eventContentSectionInputSchema.safeParse({ ...checklist, items: [] }).success).toBe(false);
  });

  it("rejects javascript:, data:, and protocol-relative links in a notice", () => {
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "//evil.example", "mailto:", "mailto:not an address", "vbscript:x"]) {
      const result = eventContentSectionInputSchema.safeParse({
        ...notice,
        links: [{ label: "Bad", description: "", url }],
      });
      expect(result.success, url).toBe(false);
    }
  });

  it("keeps mailto and placement on the info card kinds only", () => {
    const resource = {
      kind: "RESOURCE_LINKS",
      title: "Downloads",
      links: [{ label: "Mail", description: "", url: "mailto:office@example.org" }],
    };
    expect(eventContentSectionInputSchema.safeParse(resource).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({
      kind: "RICH_TEXT", title: "Lodging", body: "Rooms.", placement: "BOTH",
    }).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse({ ...notice, placement: "BOTH" }).success).toBe(true);
  });

  it("rejects unknown fields so raw markup has nowhere to ride in", () => {
    expect(eventContentInputSchema.safeParse({ sections: [{ ...notice, html: "<b>x</b>" }] }).success).toBe(false);
  });

  it("only turns http, https, and mailto values into hrefs", () => {
    expect(safeContentHref("https://example.org/a")).toBe("https://example.org/a");
    expect(safeContentHref("mailto:office@example.org")).toBe("mailto:office@example.org");
    expect(safeContentHref("javascript:alert(1)")).toBeNull();
    expect(safeContentHref(null)).toBeNull();
  });
});

function card(overrides: Partial<EventInfoCardSection>): EventInfoCardSection {
  return {
    id: "card-1",
    kind: "NOTICE",
    title: "Title",
    body: "",
    tone: "INFO",
    placement: "PUBLIC_PAGE",
    items: [],
    links: [],
    ...overrides,
  };
}

function render(sections: EventInfoCardSection[], placement: "page" | "registration" = "page") {
  return renderToStaticMarkup(createElement(EventInfoCards, { sections, eventSlug: "synthetic-event", placement }));
}

describe("EventInfoCards rendering", () => {
  const payload = `<script>alert("x")</script><img src=x onerror=alert(1)>`;

  it("renders HTML in any field as text", () => {
    const html = render([
      card({ title: payload, body: payload, links: [{ label: payload, description: payload, url: "https://example.org", assetId: null }] }),
      card({ id: "c2", kind: "STEPS", title: payload, tone: null, items: [{ title: payload, text: payload }] }),
      card({ id: "c3", kind: "CHECKLIST", title: payload, tone: null, items: [{ title: payload, text: "" }] }),
    ]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("never renders a javascript: link, even if one reached storage", () => {
    const html = render([card({
      body: "Text",
      links: [
        { label: "Bad", description: "", url: "javascript:alert(1)", assetId: null },
        { label: "Good", description: "", url: "https://example.org", assetId: null },
      ],
    })]);
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("labels each tone in text and shows steps and checklist entries", () => {
    const html = render([
      card({ tone: "REQUIREMENT", body: "Bring ID." }),
      card({ id: "s", kind: "STEPS", tone: null, items: [{ title: "First", text: "Do this" }] }),
      card({ id: "k", kind: "CHECKLIST", tone: null, items: [{ title: "Roster", text: "" }] }),
    ]);
    expect(html).toContain("Requirement");
    expect(html).toContain("is-requirement");
    expect(html).toContain("<ol");
    expect(html).toContain("Do this");
    expect(html).toContain("Have ready");
    expect(html).toContain("Roster");
  });

  it("places a card only where it was placed", () => {
    const sections = [
      card({ id: "a", title: "Page only", placement: "PUBLIC_PAGE", body: "x" }),
      card({ id: "b", title: "Form only", placement: "REGISTRATION_FORM", body: "x" }),
      card({ id: "c", title: "Both", placement: "BOTH", body: "x" }),
    ];
    const page = render(sections, "page");
    expect(page).toContain("Page only");
    expect(page).not.toContain("Form only");
    expect(page).toContain("Both");
    const form = render(sections, "registration");
    expect(form).not.toContain("Page only");
    expect(form).toContain("Form only");
  });

  it("renders nothing for ordinary sections", () => {
    expect(render([card({ kind: "RICH_TEXT", body: "Prose" })])).toBe("");
  });
});

describe("replaceEventContent with info cards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores tone, placement, and items for the right kinds", async () => {
    const create = vi.fn().mockResolvedValue({});
    const tx = {
      eventAsset: { findMany: vi.fn().mockResolvedValue([]) },
      eventContentSection: { deleteMany: vi.fn(), create },
      auditLog: { create: vi.fn() },
    };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
      eventContentSection: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const input = eventContentInputSchema.parse({
      sections: [
        notice,
        { kind: "STEPS", title: "Steps", placement: "BOTH", items: [{ title: "One", text: "Two" }] },
        { kind: "CHECKLIST", title: "Ready", items: [{ title: "Roster", text: "ignored" }] },
      ],
    });

    await replaceEventContent("event_a", input, "user_1");

    const data = create.mock.calls.map((call) => call[0].data);
    expect(data[0]).toMatchObject({ kind: "NOTICE", tone: "DEADLINE", items: [], body: notice.body });
    expect(data[0].links.create).toHaveLength(1);
    expect(data[1]).toMatchObject({ kind: "STEPS", tone: null, placement: "BOTH", items: [{ title: "One", text: "Two" }], body: "" });
    expect(data[2]).toMatchObject({ kind: "CHECKLIST", items: [{ title: "Roster", text: "" }] });
  });
});
