import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { EventContentWorkspace } from "@/components/event-content-workspace";
import { defaultBlockData, newBlockKinds } from "@/components/event-block-editors";
import { canMoveSection, moveSection, sectionPayload } from "@/components/event-content-asset-tiles";
import { readFileSync } from "node:fs";
import { eventContentSectionInputSchema } from "@/modules/events/content-schemas";

const section = (kind: string, title: string, extra: Record<string, unknown> = {}) => ({
  id: `s-${title}`, kind, title, body: "", tone: null, placement: "PUBLIC_PAGE", items: [], data: {}, isPublished: true, links: [], ...extra,
});

function render(isSystemAdmin: boolean, sections: unknown[], sanitized: Record<string, never> = {}) {
  return renderToStaticMarkup(createElement(EventContentWorkspace, {
    eventId: "event-1",
    eventName: "Synthetic Event",
    eventSlug: "synthetic-event",
    eventTiming: { startsAt: "2026-10-09T23:00:00.000Z", endsAt: "2026-10-11T17:00:00.000Z", timezone: "America/Chicago" },
    isSystemAdmin,
    initialSections: sections as never,
    initialSanitizedHtml: sanitized,
    initialAssets: [{
      id: "a1", displayName: "Chapel photo", filename: "chapel.jpg", contentType: "image/jpeg", byteSize: 2048,
      createdAt: "2026-10-01T00:00:00.000Z", url: "/api/events/event-1/assets/a1?disposition=inline",
      usage: { publishedSectionTitles: [], draftSectionTitles: [], isBadgeBackground: false },
    }, {
      id: "a2", displayName: "Flyer", filename: "flyer.pdf", contentType: "application/pdf", byteSize: 2048,
      createdAt: "2026-10-01T00:00:00.000Z", url: "/api/events/event-1/assets/a2",
      usage: { publishedSectionTitles: [], draftSectionTitles: [], isBadgeBackground: false },
    }] as never,
  }));
}

describe("content block editor (#816)", () => {
  it("offers all eleven kinds in the Add block picker", () => {
    const markup = render(true, []);
    for (const label of ["Header banner", "Photo with text", "Photo gallery", "Formatted text", "Video or map", "Questions and answers", "Schedule", "Speaker cards", "Contact card", "Countdown", "Custom HTML"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Add block");
    expect(newBlockKinds).toHaveLength(11);
  });

  it("starts every new block's data in a shape the form can edit", () => {
    for (const kind of newBlockKinds) {
      const draft = { kind, title: "Block", body: "x", isPublished: false, ...(defaultBlockData(kind) ? { data: defaultBlockData(kind) } : {}) };
      // Blank on purpose, so saving without filling it in is refused with a sentence, not a crash.
      const result = eventContentSectionInputSchema.safeParse(draft);
      if (kind === "COUNTDOWN" || kind === "FORMATTED_TEXT" || kind === "CUSTOM_HTML") expect(result.success, kind).toBe(true);
      else expect(result.success, kind).toBe(false);
    }
  });

  it("lets a system administrator edit custom HTML", () => {
    const markup = render(true, [section("CUSTOM_HTML", "Welcome banner", { body: "<p>Hi</p>" })]);
    expect(markup).toContain("Show sanitized output");
    expect(markup).not.toContain("readOnly");
    expect(markup).not.toMatch(/<option value="CUSTOM_HTML" disabled/);
  });

  it("shows custom HTML read-only to an event admin, and does not offer to add it", () => {
    const markup = render(false, [section("CUSTOM_HTML", "Welcome banner", { body: "<p>Hi</p>" })]);
    expect(markup).toContain("system administrator");
    expect(markup).toMatch(/<textarea[^>]*readOnly/);
    expect(markup).not.toContain("Show sanitized output");
    expect(markup).toMatch(/<option value="CUSTOM_HTML" disabled/);
  });

  it("offers only uploaded images for a photo, and asks for alt text", () => {
    const markup = render(true, [section("IMAGE", "Chapel", { data: { assetId: "a1", alt: "", caption: "", imageSide: "LEFT" } })]);
    expect(markup).toContain("Chapel photo");
    expect(markup).not.toMatch(/<option value="a2"[^>]*>Flyer/);
    expect(markup).toMatch(/alt text\)[^]*?<input[^>]*required/);
  });

  it("keeps the older section kinds' editors", () => {
    const markup = render(true, [section("RICH_TEXT", "About", { body: "Hello" }), section("STEPS", "How", { items: [{ title: "One", text: "" }] })]);
    expect(markup).toContain("Add a text section");
    expect(markup).toContain("Add a steps card");
    expect(markup).toContain("Preview this card");
  });

  it("never renders a stored script or handler in the editor, only the server's sanitized copy (#816)", () => {
    const body = `<p>Hi</p><script>alert(1)</script><img src="x" onerror="alert(2)">`;
    const stored = section("CUSTOM_HTML", "Banner", { body });
    // No sanitized copy supplied: nothing is rendered as HTML.
    const without = render(false, [stored]);
    expect(without).not.toContain("<script");
    expect(without).not.toContain("<img");
    expect(without).not.toContain("event-custom-html");
    // The sanitized copy is what appears.
    const withCopy = render(false, [stored], { [stored.id]: "<p>Hi</p>" as never });
    expect(withCopy).toContain('<div class="event-custom-html"><p>Hi</p></div>');
    expect(withCopy).not.toContain("<script");
    expect(withCopy).not.toContain("<img");
    expect(render(true, [stored])).not.toContain("<script");
  });

  it("has no cast that makes SanitizedHtml outside the sanitizer", () => {
    for (const file of ["components/event-block-editors.tsx", "components/event-content-workspace.tsx"]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/as SanitizedHtml/);
    }
  });

  it("keys each block by its own id, so its editor state follows it when reordered", () => {
    const source = readFileSync("components/event-content-workspace.tsx", "utf8");
    expect(source).toContain("key={section.cid ?? index}");
    // Adding a block resets the picker.
    expect(source).toMatch(/setBlockToAdd\("FORMATTED_TEXT"\);\n\s+setError/);
    const drafts = [
      { cid: "a", kind: "RICH_TEXT" }, { cid: "b", kind: "EMBED" }, { cid: "c", kind: "FAQ" },
    ];
    expect(moveSection(drafts, 1, 1).map((draft) => draft.cid)).toEqual(["a", "c", "b"]);
    expect(moveSection(drafts, 1, -1).map((draft) => draft.cid)).toEqual(["b", "a", "c"]);
    // The client ids never reach the server.
    expect(sectionPayload({ cid: "a", serverId: "s", kind: "RICH_TEXT", title: "x", body: "", isPublished: true, links: [] })).not.toHaveProperty("cid");
  });

  it("pins the header banner at the top: it cannot move and nothing moves above it", () => {
    const drafts = [{ cid: "h", kind: "HERO" }, { cid: "a", kind: "RICH_TEXT" }, { cid: "b", kind: "FAQ" }];
    expect(canMoveSection(drafts, 0, 1)).toBe(false);
    expect(canMoveSection(drafts, 1, -1)).toBe(false);
    expect(canMoveSection(drafts, 1, 1)).toBe(true);
    expect(moveSection(drafts, 1, -1)).toBe(drafts);
    expect(moveSection(drafts, 0, 1)).toBe(drafts);
    const markup = render(true, [section("HERO", "Banner", { data: { assetId: "a1", alt: "x" } }), section("RICH_TEXT", "About")]);
    // Only the second block has Up and Down buttons.
    expect((markup.match(/>Up<\/button>/g) ?? []).length).toBe(1);
  });
});
