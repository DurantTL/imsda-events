import { describe, expect, it, vi } from "vitest";

import { embedFrameOrigins } from "@/modules/events/content-embeds";

// Next.js applies every matching header rule in order and, for a key set by
// more than one rule, sends the last value. This mirrors that for the `:name`
// and `:name*` patterns next.config.ts uses.
function sourceMatches(source: string, pathname: string) {
  const pattern = source
    .replace(/:[A-Za-z]+\*/g, ".*")
    .replace(/:[A-Za-z]+/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(pathname);
}

async function policyFor(pathname: string) {
  vi.resetModules();
  const nextConfig = (await import("../next.config")).default;
  const rules = (await nextConfig.headers?.()) ?? [];
  let policy = "";
  for (const rule of rules.filter((candidate) => sourceMatches(candidate.source, pathname))) {
    for (const header of rule.headers) {
      if (header.key.toLowerCase() === "content-security-policy") policy = header.value;
    }
  }
  return policy;
}

function frameSources(policy: string) {
  return (policy.split("; ").find((entry) => entry.startsWith("frame-src ")) ?? "").split(" ").slice(1);
}

describe("public event page: frame-src for embeds (#816)", () => {
  it("admits the three embed origins on the public event page, and nothing else new", async () => {
    const sources = frameSources(await policyFor("/events/synthetic-event"));
    for (const origin of embedFrameOrigins) expect(sources).toContain(origin);
    expect(sources).toContain("'self'");
    // The site policy's own entries plus exactly the embed origins.
    const baseline = frameSources(await policyFor("/events"));
    expect(sources.filter((source) => !baseline.includes(source)).sort()).toEqual([...embedFrameOrigins].sort());
  });

  it("keeps the rest of the policy on the event page as locked as everywhere else", async () => {
    const eventPolicy = await policyFor("/events/synthetic-event");
    const sitePolicy = await policyFor("/clubs-not-a-page");
    const withoutFrame = (policy: string) => policy.split("; ").filter((entry) => !entry.startsWith("frame-src ")).join("; ");
    expect(withoutFrame(eventPolicy)).toBe(withoutFrame(sitePolicy));
    expect(eventPolicy).toContain("default-src 'self'");
    expect(eventPolicy).toContain("frame-ancestors 'none'");
    expect(eventPolicy).toContain("object-src 'none'");
    expect(eventPolicy.match(/Content-Security-Policy/gi)).toBeNull();
  });

  it("does not admit the embed origins on any other page", async () => {
    for (const pathname of [
      "/",
      "/events",
      "/events/synthetic-event/extra",
      "/register/synthetic-event/general",
      "/register/synthetic-event/group",
      "/account",
      "/more/event-content",
      "/clubs",
      "/admin",
      "/embed/synthetic-event/general",
      "/manage/token",
    ]) {
      const sources = frameSources(await policyFor(pathname));
      for (const origin of embedFrameOrigins) {
        expect(sources, `${pathname} ${origin}`).not.toContain(origin);
      }
    }
  });

  it("sends one policy for the event page", async () => {
    vi.resetModules();
    const nextConfig = (await import("../next.config")).default;
    const rules = (await nextConfig.headers?.()) ?? [];
    const eventRules = rules.filter((rule) => sourceMatches(rule.source, "/events/synthetic-event")
      && rule.headers.some((header) => header.key === "Content-Security-Policy"));
    // Site-wide, then the event page's own; the later one replaces the earlier.
    expect(eventRules.map((rule) => rule.source)).toEqual(["/:path*", "/events/:eventSlug"]);
  });
});
