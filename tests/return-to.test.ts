import { describe, expect, it } from "vitest";
import { allowedReturnTo, safeReturnTo } from "@/lib/return-to";

const FALLBACK = "/account/clubs/org_1";

describe("safeReturnTo", () => {
  it("accepts a plain same-site relative path", () => {
    expect(safeReturnTo("/admin/organizations", FALLBACK)).toBe("/admin/organizations");
  });

  it("accepts a relative path with a query string", () => {
    expect(safeReturnTo("/more/clubs?event=event_1", FALLBACK)).toBe("/more/clubs?event=event_1");
  });

  it("accepts a relative path with a dynamic segment", () => {
    expect(safeReturnTo("/admin/organizations/org_1/club", FALLBACK)).toBe("/admin/organizations/org_1/club");
  });

  it("accepts a bare root path", () => {
    expect(safeReturnTo("/", FALLBACK)).toBe("/");
  });

  it("falls back for null", () => {
    expect(safeReturnTo(null, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for undefined", () => {
    expect(safeReturnTo(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for an empty string", () => {
    expect(safeReturnTo("", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a protocol-relative URL", () => {
    expect(safeReturnTo("//evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a protocol-relative URL with a path", () => {
    expect(safeReturnTo("//evil.com/phish", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects an absolute https URL", () => {
    expect(safeReturnTo("https://evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects an absolute http URL", () => {
    expect(safeReturnTo("http://evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a backslash trick", () => {
    expect(safeReturnTo("/\\evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a backslash trick without a leading slash", () => {
    expect(safeReturnTo("\\evil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a javascript: URL", () => {
    expect(safeReturnTo("javascript:alert(1)", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a value with no leading slash", () => {
    expect(safeReturnTo("account/clubs/org_1", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a percent-encoded protocol-relative URL", () => {
    expect(safeReturnTo("/%2F%2Fevil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a percent-encoded backslash trick", () => {
    expect(safeReturnTo("/%5Cevil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a double-encoded protocol-relative URL", () => {
    expect(safeReturnTo("/%252F%252Fevil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects an embedded control character", () => {
    expect(safeReturnTo("/account\u0000/clubs", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a percent-encoded control character", () => {
    expect(safeReturnTo("/account%0aclubs", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a malformed percent-encoding", () => {
    expect(safeReturnTo("/account%%zzclubs", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a double slash later in the path", () => {
    expect(safeReturnTo("/account//clubs", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a four-times-encoded protocol-relative URL", () => {
    expect(safeReturnTo("/%2525252F%2525252Fevil.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects an API route", () => {
    expect(safeReturnTo("/api/admin/organizations/org_1", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects the bare /api route", () => {
    expect(safeReturnTo("/api", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects an API route with a query string", () => {
    expect(safeReturnTo("/api?x=1", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a percent-encoded API route", () => {
    expect(safeReturnTo("/%61pi/admin", FALLBACK)).toBe(FALLBACK);
  });

  it("accepts a path that merely contains \"api\" as a segment name, not a leading /api", () => {
    expect(safeReturnTo("/more/rapid-response", FALLBACK)).toBe("/more/rapid-response");
  });
});

describe("allowedReturnTo", () => {
  const CLUB_HREF = "/admin/organizations/org_1/club";
  const ALLOWED = [CLUB_HREF] as const;

  it("accepts a value that is exactly one of the allowed parents", () => {
    expect(allowedReturnTo(CLUB_HREF, ALLOWED, FALLBACK)).toBe(CLUB_HREF);
  });

  it("falls back for a safe relative path that isn't in the allowlist", () => {
    expect(allowedReturnTo("/admin/organizations/org_2/club", ALLOWED, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for an unsafe value even if it happens to prefix-match an allowed entry", () => {
    expect(allowedReturnTo(`${CLUB_HREF}//evil.com`, ALLOWED, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for null", () => {
    expect(allowedReturnTo(null, ALLOWED, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for an API route even if it were somehow allowlisted", () => {
    expect(allowedReturnTo("/api/admin/organizations/org_1", ["/api/admin/organizations/org_1"], FALLBACK)).toBe(FALLBACK);
  });
});
