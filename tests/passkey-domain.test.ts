import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  PASSKEY_CHANGE_WINDOW_HOURS,
  hasRecentSecondFactor,
  isValidRelyingPartyId,
  matchRelyingParty,
  passkeyNameFrom,
} from "@/modules/attendee-accounts/passkey-domain";
import { platformSettingsInputSchema } from "@/modules/system-admin/platform-settings";

describe("passkey relying party", () => {
  it("accepts bare domains only", () => {
    expect(isValidRelyingPartyId("events.imsda.test")).toBe(true);
    expect(isValidRelyingPartyId("localhost")).toBe(true);
    expect(isValidRelyingPartyId("https://events.imsda.test")).toBe(false);
    expect(isValidRelyingPartyId("events.imsda.test/path")).toBe(false);
    expect(isValidRelyingPartyId("EVENTS.imsda.test")).toBe(false);
  });

  it("matches the page's own host or a subdomain, over HTTPS", () => {
    expect(matchRelyingParty("imsda.test", "https://events.imsda.test")).toEqual({ rpId: "imsda.test", origin: "https://events.imsda.test" });
    expect(matchRelyingParty("events.imsda.test", "https://events.imsda.test")).toMatchObject({ origin: "https://events.imsda.test" });
    expect(matchRelyingParty("events.imsda.test", "http://events.imsda.test")).toBeNull();
    expect(matchRelyingParty("events.imsda.test", "https://evil-events.imsda.test.example")).toBeNull();
    expect(matchRelyingParty("imsda.test", "https://notimsda.test")).toBeNull();
    expect(matchRelyingParty("localhost", "http://localhost:3000")).toEqual({ rpId: "localhost", origin: "http://localhost:3000" });
  });

  it("stays off when unset or when the origin is missing", () => {
    expect(matchRelyingParty(null, "https://events.imsda.test")).toBeNull();
    expect(matchRelyingParty("events.imsda.test", null)).toBeNull();
    expect(matchRelyingParty("events.imsda.test", "not a url")).toBeNull();
  });

  it("is saved lower-case from platform settings, and blank means off", () => {
    const base = { organizationName: "IMSDA Events", defaultTimezone: "America/Chicago", defaultSenderName: "IMSDA Events" };
    expect(platformSettingsInputSchema.parse({ ...base, passkeyRpId: " Events.IMSDA.test " }).passkeyRpId).toBe("events.imsda.test");
    expect(platformSettingsInputSchema.parse({ ...base, passkeyRpId: "" }).passkeyRpId).toBeNull();
    expect(platformSettingsInputSchema.safeParse({ ...base, passkeyRpId: "https://events.imsda.test" }).success).toBe(false);
  });
});

describe("passkey changes", () => {
  it("need a second step within the window", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    expect(hasRecentSecondFactor(null, now)).toBe(false);
    expect(hasRecentSecondFactor(new Date(now.getTime() - 60_000), now)).toBe(true);
    expect(hasRecentSecondFactor(new Date(now.getTime() - PASSKEY_CHANGE_WINDOW_HOURS * 3_600_000 - 1), now)).toBe(false);
  });

  it("names a passkey sensibly", () => {
    expect(passkeyNameFrom("  My phone ")).toBe("My phone");
    expect(passkeyNameFrom("")).toBe("Passkey");
    expect(passkeyNameFrom(undefined)).toBe("Passkey");
    expect(passkeyNameFrom("x".repeat(80))).toHaveLength(60);
  });
});
