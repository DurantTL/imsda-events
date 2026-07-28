import { describe, expect, it } from "vitest";
import {
  contentParagraphs,
  eventContentInputSchema,
  eventContentSectionInputSchema,
} from "@/modules/events/content-schemas";

function textSection(overrides: Record<string, unknown> = {}) {
  return {
    kind: "RICH_TEXT",
    title: "Lodging",
    body: "Rooms are held until 1 September.",
    ...overrides,
  };
}

function linkSection(overrides: Record<string, unknown> = {}) {
  return {
    kind: "RESOURCE_LINKS",
    title: "Downloads",
    links: [{ label: "Event flyer", description: "PDF", url: "https://imsda.org/flyer.pdf" }],
    ...overrides,
  };
}

describe("event content sections", () => {
  it("accepts the shapes the current event page uses", () => {
    expect(eventContentSectionInputSchema.safeParse(textSection()).success).toBe(true);
    expect(eventContentSectionInputSchema.safeParse(linkSection()).success).toBe(true);
  });

  it("refuses a link whose scheme could execute", () => {
    // An anchor on a public page. Anything but http(s) here is script delivery
    // dressed as a download, so the scheme is checked rather than assumed.
    for (const url of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox",
    ]) {
      expect(eventContentSectionInputSchema.safeParse(
        linkSection({ links: [{ label: "Flyer", description: "", url }] }),
      ).success).toBe(false);
    }
  });

  it("refuses a section that would publish an empty heading", () => {
    expect(eventContentSectionInputSchema.safeParse(
      textSection({ body: "" }),
    ).success).toBe(false);
    expect(eventContentSectionInputSchema.safeParse(
      linkSection({ links: [] }),
    ).success).toBe(false);
  });

  it("defaults a new section to unpublished", () => {
    const parsed = eventContentSectionInputSchema.parse(textSection());
    // A section someone is midway through writing must not appear publicly
    // because they forgot to say otherwise.
    expect(parsed.isPublished).toBe(false);
  });

  it("rejects unknown fields rather than dropping them", () => {
    expect(eventContentSectionInputSchema.safeParse(
      textSection({ html: "<script>alert(1)</script>" }),
    ).success).toBe(false);
  });

  it("bounds how much a page can carry", () => {
    expect(eventContentInputSchema.safeParse({
      sections: Array.from({ length: 31 }, () => textSection()),
    }).success).toBe(false);
  });
});

describe("rendering stored text", () => {
  it("splits on blank lines and drops the gaps", () => {
    expect(contentParagraphs("One.\n\nTwo.\n\n\n  Three.  ")).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
  });

  it("keeps a single newline inside one paragraph", () => {
    // Only a blank line starts a new paragraph, so an address or a list of
    // times stays together rather than scattering.
    expect(contentParagraphs("Line one\nLine two")).toEqual(["Line one\nLine two"]);
  });

  it("returns nothing for text that is only whitespace", () => {
    expect(contentParagraphs("   \n\n  ")).toEqual([]);
  });
});
