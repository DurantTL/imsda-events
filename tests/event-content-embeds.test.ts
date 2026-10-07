import { describe, expect, it } from "vitest";

import {
  embedFrameOrigins,
  embedSrc,
  extractEmbedId,
  isValidEmbedId,
} from "@/modules/events/content-embeds";
import { embedDataSchema } from "@/modules/events/content-schemas";

const mapsId = `!1m18!1m12!1m3!1d3000.5!2d-93.6!3d41.6!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2sSynthetic!5e0!3m2!1sen!2sus!4v1700000000000`;

describe("embeds are built from a provider and an id only (#816)", () => {
  it("builds the iframe address on the provider's own origin", () => {
    expect(embedSrc("YOUTUBE", "dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0");
    expect(embedSrc("VIMEO", "76979871")).toBe("https://player.vimeo.com/video/76979871?dnt=1");
    expect(embedSrc("GOOGLE_MAPS", mapsId)).toBe(`https://www.google.com/maps/embed?pb=${mapsId}`);
  });

  it("only ever builds addresses on the three allowed origins", () => {
    for (const src of [
      embedSrc("YOUTUBE", "dQw4w9WgXcQ"),
      embedSrc("VIMEO", "76979871"),
      embedSrc("GOOGLE_MAPS", mapsId),
    ]) {
      expect(embedFrameOrigins.some((origin) => src?.startsWith(`${origin}/`))).toBe(true);
    }
  });

  it("rejects ids that are really something else", () => {
    for (const id of [
      "https://evil.example/embed",
      "//evil.example",
      "javascript:alert(1)",
      "dQw4w9WgXcQ&autoplay=1",
      "dQw4w9WgXcQ/../x",
      '"><script>',
      "short",
      "",
    ]) {
      expect(isValidEmbedId("YOUTUBE", id), id).toBe(false);
      expect(embedSrc("YOUTUBE", id), id).toBeNull();
    }
    expect(embedSrc("VIMEO", "12ab")).toBeNull();
    expect(embedSrc("VIMEO", "123456 7")).toBeNull();
    expect(embedSrc("GOOGLE_MAPS", `${mapsId}&output=embed`)).toBeNull();
    expect(embedSrc("GOOGLE_MAPS", `${mapsId}"onload="x`)).toBeNull();
    // An unknown provider never produces an address.
    expect(embedSrc("EVIL" as never, "dQw4w9WgXcQ")).toBeNull();
  });

  it("reads a pasted link only on the provider's own host", () => {
    expect(extractEmbedId("YOUTUBE", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ ok: true, id: "dQw4w9WgXcQ" });
    expect(extractEmbedId("YOUTUBE", "https://youtu.be/dQw4w9WgXcQ")).toEqual({ ok: true, id: "dQw4w9WgXcQ" });
    expect(extractEmbedId("YOUTUBE", "dQw4w9WgXcQ")).toEqual({ ok: true, id: "dQw4w9WgXcQ" });
    expect(extractEmbedId("VIMEO", "https://vimeo.com/76979871")).toEqual({ ok: true, id: "76979871" });
    expect(extractEmbedId("GOOGLE_MAPS", `https://www.google.com/maps/embed?pb=${mapsId}`)).toEqual({ ok: true, id: mapsId });
  });

  it("rejects arbitrary URLs, look-alike hosts and pasted embed code", () => {
    for (const [provider, input] of [
      ["YOUTUBE", "https://evil.example/watch?v=dQw4w9WgXcQ"],
      ["YOUTUBE", "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ"],
      ["YOUTUBE", "https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ"],
      ["YOUTUBE", "http://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      ["YOUTUBE", "https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ"],
      ["YOUTUBE", "javascript:alert(1)"],
      ["YOUTUBE", "data:text/html,<script>alert(1)</script>"],
      ["YOUTUBE", `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`],
      ["VIMEO", "https://vimeo.evil.example/76979871"],
      ["VIMEO", "https://evil.example/video/76979871"],
      ["GOOGLE_MAPS", "https://evil.example/maps/embed?pb=" + mapsId],
      ["GOOGLE_MAPS", "https://www.google.com/search?pb=" + mapsId],
      ["GOOGLE_MAPS", "https://www.google.com/maps/embed?pb=!1evil&x=y"],
    ] as const) {
      expect(extractEmbedId(provider, input).ok, `${provider} ${input}`).toBe(false);
    }
  });

  it("the block schema refuses a stored value that is not a valid id", () => {
    const good = { provider: "YOUTUBE", id: "dQw4w9WgXcQ", title: "Welcome video" };
    expect(embedDataSchema.safeParse(good).success).toBe(true);
    expect(embedDataSchema.safeParse({ ...good, id: "https://evil.example/x" }).success).toBe(false);
    expect(embedDataSchema.safeParse({ ...good, provider: "EVIL" }).success).toBe(false);
    expect(embedDataSchema.safeParse({ ...good, title: "" }).success).toBe(false);
    expect(embedDataSchema.safeParse({ ...good, src: "https://evil.example" }).success).toBe(false);
    expect(embedDataSchema.safeParse({ ...good, html: "<iframe>" }).success).toBe(false);
  });
});
