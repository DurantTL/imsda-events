import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";

describe("private headers for the health record pages and link (#611)", () => {
  it("covers every health path with the private registration headers", async () => {
    const rules = await nextConfig.headers!();
    const bySource = new Map(rules.map((rule) => [rule.source, rule.headers]));
    const privateRules = bySource.get("/club-forms/:path*");
    expect(privateRules && privateRules.length).toBeGreaterThan(0);
    for (const source of [
      "/health-records/:path*",
      "/api/public/health-records/:path*",
      "/account/clubs/:organizationId/roster/:memberId/health",
      "/account/area-clubs/health/:path*",
      "/more/health-records/:path*",
    ]) {
      expect(bySource.get(source), source).toEqual(privateRules);
    }
  });

  it("keeps the health link pages out of crawlers", async () => {
    const robots = (await import("@/app/robots")).default();
    const rule = Array.isArray(robots.rules) ? robots.rules[0]! : robots.rules;
    expect(rule.disallow).toContain("/health-records/");
    expect(rule.disallow).toContain("/api/");
  });
});
