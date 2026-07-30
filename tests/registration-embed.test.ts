import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET as getEmbedFrameScript } from "@/app/(public)/embed/embed.js/route";
import { GET as getEmbedHostScript } from "@/app/(public)/embed/embed-host.js/route";
import {
  EMBED_FRAME_SCRIPT,
  EMBED_HOST_SCRIPT,
} from "@/modules/forms/embed-scripts";
import { buildRegistrationEmbedCode } from "@/modules/forms/embed";

const root = process.cwd();
const globalsCss = readFileSync(path.join(root, "app/globals.css"), "utf8");
const nextConfig = readFileSync(path.join(root, "next.config.ts"), "utf8");
const registrationForm = readFileSync(
  path.join(root, "components/public-registration-form.tsx"),
  "utf8",
);
const registrationRoute = readFileSync(
  path.join(
    root,
    "app/api/public/events/[eventSlug]/forms/[formSlug]/registrations/route.ts",
  ),
  "utf8",
);

describe("registration embed", () => {
  it("generates the complete auto-sizing host block without lazy loading or clipping", () => {
    const code = buildRegistrationEmbedCode({
      origin: "https://events.imsda.org/admin",
      eventSlug: "womens-retreat-2026",
      formSlug: "women-s-retreat-2026-registration",
      eventName: 'Women’s "Colorful" Retreat',
    });

    expect(code).toContain('<iframe class="imsda-embed"');
    expect(code).toContain(
      'src="https://events.imsda.org/embed/womens-retreat-2026/women-s-retreat-2026-registration"',
    );
    expect(code).toContain(
      'title="Women’s &quot;Colorful&quot; Retreat registration"',
    );
    expect(code).toContain(
      'width="100%" height="900" style="border:0;display:block"',
    );
    expect(code).toContain(
      '<script src="https://events.imsda.org/embed/embed-host.js" async></script>',
    );
    expect(code).not.toContain('loading="lazy"');
    expect(code).not.toContain("scrolling=");
  });

  it("reports content height and asks the parent to reveal the frame", async () => {
    expect(EMBED_FRAME_SCRIPT).toContain('window.top === window.self');
    expect(EMBED_FRAME_SCRIPT).toContain('type: "imsda:embed"');
    expect(EMBED_FRAME_SCRIPT).toContain('event: "height"');
    expect(EMBED_FRAME_SCRIPT).toContain("new ResizeObserver(schedule)");
    expect(EMBED_FRAME_SCRIPT).toContain("new MutationObserver(schedule)");
    expect(EMBED_FRAME_SCRIPT).toContain("document.fonts.ready.then(schedule)");
    expect(EMBED_FRAME_SCRIPT).toContain("window.setInterval(schedule, 1000)");
    expect(EMBED_FRAME_SCRIPT).toContain("window.imsdaEmbedScrollTop");
    expect(EMBED_FRAME_SCRIPT).toContain('event: "scrollTop"');

    const response = getEmbedFrameScript();
    expect(response.headers.get("content-type")).toBe(
      "application/javascript; charset=utf-8",
    );
    expect(await response.text()).toContain(EMBED_FRAME_SCRIPT);
  });

  it("matches the sending frame and accepts messages only from the script origin", async () => {
    expect(EMBED_HOST_SCRIPT).toContain(
      "messageEvent.origin !== origin",
    );
    expect(EMBED_HOST_SCRIPT).toContain(
      "registeredOrigins.indexOf(origin) !== -1",
    );
    expect(EMBED_HOST_SCRIPT).toContain(
      "frame.contentWindow !== messageEvent.source",
    );
    expect(EMBED_HOST_SCRIPT).toContain(
      "Math.ceil(data.height + 16)",
    );
    expect(EMBED_HOST_SCRIPT).toContain(
      'frame.scrollIntoView({ behavior: "smooth", block: "start" })',
    );

    const response = getEmbedHostScript();
    expect(response.headers.get("content-type")).toBe(
      "application/javascript; charset=utf-8",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(await response.text()).toContain(EMBED_HOST_SCRIPT);
  });

  it("removes viewport constraints only when the embed layout is present", () => {
    expect(globalsCss).toContain("html:has(.imsda-embed-layout)");
    expect(globalsCss).toContain("html:has(.imsda-embed-layout) body");
    expect(globalsCss).toMatch(
      /\.public-registration-embed \{\s+min-height: 0;/,
    );
    expect(globalsCss).toMatch(
      /\.public-registration-embed \.public-registration-page \{\s+min-height: 0;/,
    );
    expect(globalsCss).toMatch(
      /\.public-registration-embed-state \{[\s\S]*?min-height: 0;/,
    );
  });

  it("requests parent scrolling for steps, validation, and completion", () => {
    expect(
      registrationForm.match(/window\.imsdaEmbedScrollTop\?\.\(\)/g),
    ).toHaveLength(5);
  });

  it("uses CSP frame ancestors without a conflicting X-Frame-Options header", () => {
    expect(nextConfig).toContain(
      `"'self' https://imsda.org https://*.imsda.org"`,
    );
    expect(nextConfig).toContain("frame-ancestors");
    expect(nextConfig).not.toContain("X-Frame-Options");
  });

  it("keeps embedded registration submission independent of third-party cookies", () => {
    expect(registrationRoute).not.toMatch(/\bcookies\s*\(/);
    expect(registrationRoute).not.toContain("Set-Cookie");
    expect(registrationRoute).toContain("submitPublicRegistration");
    expect(registrationForm).toContain("idempotencyKey: submissionKey");
  });
});
