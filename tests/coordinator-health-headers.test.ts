import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("health pages are never cached or indexed (#658)", () => {
  it("sets the private headers on all three health routes", async () => {
    const rules = await nextConfig.headers!();
    for (const source of ["/account/area/health/:path*", "/account/clubs/:organizationId/health/:path*", "/more/event-health/:path*"]) {
      const headers = Object.fromEntries((rules.find((rule) => rule.source === source)?.headers ?? []).map((header) => [header.key, header.value]));
      expect(headers["Cache-Control"], source).toBe("private, no-store, max-age=0");
      expect(headers["Referrer-Policy"], source).toBe("no-referrer");
      expect(headers["X-Robots-Tag"], source).toContain("noindex");
    }
  });
});
