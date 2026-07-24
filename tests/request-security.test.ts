import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetServerEnvCache } from "@/lib/env";
import {
  isSameOriginRequest,
  rejectCrossOriginRequest,
} from "@/modules/access/request-security";

const originalEnv = { ...process.env };

function requestFrom(origin: string | null, url = "https://events.imsda.org/api/check-in") {
  return new Request(url, {
    method: "POST",
    headers: origin ? { origin } : {},
  });
}

beforeEach(() => {
  resetServerEnvCache();
  process.env.DATABASE_URL = "postgresql://imsda:imsda@db:5432/imsda_events?schema=public";
  process.env.APP_BASE_URL = "https://events.imsda.org";
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetServerEnvCache();
});

describe("request origin checks", () => {
  it("accepts the request origin and the configured workspace origin", () => {
    expect(isSameOriginRequest(requestFrom("https://events.imsda.org"))).toBe(true);
    expect(isSameOriginRequest(
      requestFrom("https://events.imsda.org", "http://app:3000/api/check-in"),
    )).toBe(true);
  });

  it("rejects a different origin and a missing origin", () => {
    expect(isSameOriginRequest(requestFrom("https://attacker.test"))).toBe(false);
    expect(isSameOriginRequest(requestFrom(null))).toBe(false);
    expect(rejectCrossOriginRequest(requestFrom("https://attacker.test"))?.status).toBe(403);
  });

  it("rejects a malformed inbound Origin header without blaming configuration", () => {
    expect(isSameOriginRequest(requestFrom("not an origin"))).toBe(false);
  });

  it("answers a configuration fault with 500, not a misleading 403", async () => {
    process.env.APP_BASE_URL = "events.imsda.org";
    resetServerEnvCache();

    const response = rejectCrossOriginRequest(requestFrom("https://events.imsda.org"));
    expect(response?.status).toBe(500);
    await expect(response?.json()).resolves.toMatchObject({
      error: "SERVER_MISCONFIGURED",
    });
  });

  it("treats a broken DATABASE_URL as a server fault on every mutation route", () => {
    process.env.DATABASE_URL = "postgres://wrong-scheme/imsda";
    resetServerEnvCache();

    expect(rejectCrossOriginRequest(requestFrom("https://events.imsda.org"))?.status).toBe(500);
  });
});
