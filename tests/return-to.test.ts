import { describe, expect, it } from "vitest";
import { safeReturnTo } from "@/lib/return-to";

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
});
