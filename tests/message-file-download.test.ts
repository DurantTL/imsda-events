import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentSession: vi.fn(),
  getPrisma: vi.fn(),
  readAsset: vi.fn(),
}));

vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: class extends Error {},
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
// Only the disk read is replaced: the response helper that sets the headers is the real one.
vi.mock("@/modules/events/asset-storage", () => ({
  readAsset: mocks.readAsset,
  writeStoredFile: vi.fn(),
  deleteAsset: vi.fn(),
}));

import { GET } from "@/app/api/events/[eventId]/message-files/[fileId]/route";
import { contentDisposition } from "@/modules/events/asset-response";

const context = { params: Promise.resolve({ eventId: "event-1", fileId: "file-1" }) };

function storedFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1", eventId: "event-1", filename: "Agenda.pdf", contentType: "application/pdf",
    sizeBytes: 12, sha256: "x", storageKey: "message-files/event-1/x.pdf", isInlineImage: false,
    createdAt: new Date("2026-10-01T00:00:00Z"), ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.readAsset.mockResolvedValue(Buffer.from("%PDF-1.7 synthetic"));
});

describe("message file download headers (#824)", () => {
  it("serves a PDF as an attachment, sniff-proof and sandboxed, even when inline is requested", async () => {
    mocks.getPrisma.mockReturnValue({ messageFile: { findFirst: vi.fn(async () => storedFile()) } });
    const response = await GET(new Request("https://events.imsda.test/x?disposition=inline"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; /);
    expect(response.headers.get("Content-Disposition")).not.toMatch(/inline/);
  });

  it("serves a picture inline only when asked, and as an attachment otherwise", async () => {
    mocks.getPrisma.mockReturnValue({ messageFile: { findFirst: vi.fn(async () => storedFile({ filename: "map.png", contentType: "image/png", isInlineImage: true })) } });
    const inline = await GET(new Request("https://events.imsda.test/x?disposition=inline"), context);
    expect(inline.headers.get("Content-Disposition")).toMatch(/^inline; /);
    expect(inline.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const plain = await GET(new Request("https://events.imsda.test/x"), context);
    expect(plain.headers.get("Content-Disposition")).toMatch(/^attachment; /);
  });

  it("serves a name with a typographic apostrophe and an en dash instead of failing", async () => {
    mocks.getPrisma.mockReturnValue({ messageFile: { findFirst: vi.fn(async () => storedFile({ filename: "Women’s Retreat – Agenda.pdf" })) } });
    const response = await GET(new Request("https://events.imsda.test/x"), context);
    expect(response.status).toBe(200);
    const header = response.headers.get("Content-Disposition") ?? "";
    expect(header).toBe(`attachment; filename="Women's Retreat - Agenda.pdf"; filename*=UTF-8''Women%E2%80%99s%20Retreat%20%E2%80%93%20Agenda.pdf`);
    // Every character in the header is Latin-1, so setting it never throws.
    expect([...header].every((char) => char.charCodeAt(0) <= 0xff)).toBe(true);
  });
});

describe("contentDisposition (#824)", () => {
  it("cannot be broken out of by quotes, separators, control characters or non-ASCII text", () => {
    const header = contentDisposition("attachment", 'a"; filename="evil.exe\r\nX-Injected: 1 日本語 ö.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    const [, fallback] = /filename="([^"]*)"/.exec(header) ?? [];
    expect(fallback).not.toContain('"');
    expect(fallback).not.toContain(";");
    expect(/^[\x20-\x7e]*$/.test(fallback)).toBe(true);
    expect(header).toContain("filename*=UTF-8''");
    expect(header.split("filename*=UTF-8''")[1]).toMatch(/^[A-Za-z0-9%._~-]*$/);
  });

  it("falls back to a plain name for an all-non-ASCII name and keeps ordinary names unchanged", () => {
    expect(contentDisposition("attachment", "Agenda.pdf")).toBe(`attachment; filename="Agenda.pdf"; filename*=UTF-8''Agenda.pdf`);
    expect(contentDisposition("inline", "日本語.png")).toMatch(/^inline; filename="___\.png"; filename\*=UTF-8''/);
  });
});
