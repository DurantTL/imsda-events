import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  bytesMatchType,
  isAllowedAssetType,
  safeDisplayName,
} from "@/modules/events/asset-storage";
import { eventContentLinkInputSchema } from "@/modules/events/content-schemas";

function bytesFrom(hex: string, length = 16) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index * 2 < hex.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const pdf = bytesFrom("255044462d312e37");
const png = bytesFrom("89504e470d0a1a0a");

describe("allowed upload types", () => {
  it("accepts the formats an event page actually needs", () => {
    for (const type of ["application/pdf", "image/png", "image/jpeg", "image/webp"]) {
      expect(isAllowedAssetType(type)).toBe(true);
    }
  });

  it("refuses formats a browser would execute or that can carry script", () => {
    // SVG is the notable exclusion: it is a document that can contain script,
    // so serving one from this origin would hand an uploader a way to run code.
    for (const type of [
      "image/svg+xml",
      "text/html",
      "application/javascript",
      "application/x-httpd-php",
      "",
    ]) {
      expect(isAllowedAssetType(type)).toBe(false);
    }
  });
});

describe("verifying bytes against the declared type", () => {
  it("accepts a file whose contents match what it claims", () => {
    expect(bytesMatchType(pdf, "application/pdf")).toBe(true);
    expect(bytesMatchType(png, "image/png")).toBe(true);
  });

  it("refuses HTML wearing a PDF's content type", () => {
    // The multipart Content-Type is a claim by the uploader. Trusting it would
    // let this be stored and later served back as a PDF.
    const html = new TextEncoder().encode("<html><script>alert(1)</script>");
    expect(bytesMatchType(html, "application/pdf")).toBe(false);
  });

  it("refuses a PNG renamed as a PDF, and the reverse", () => {
    expect(bytesMatchType(png, "application/pdf")).toBe(false);
    expect(bytesMatchType(pdf, "image/png")).toBe(false);
  });

  it("refuses a file too short to carry a signature", () => {
    expect(bytesMatchType(new Uint8Array([0x25]), "application/pdf")).toBe(false);
    expect(bytesMatchType(new Uint8Array(), "image/png")).toBe(false);
  });
});

describe("display names", () => {
  it("strips the parts of a filename that give it power", () => {
    // Never used as a path — but it is echoed into a Content-Disposition
    // header, so separators and leading dots go.
    expect(safeDisplayName("../../../etc/passwd", "application/pdf")).not.toContain("/");
    expect(safeDisplayName("../../secrets.pdf", "application/pdf")).not.toContain("..");
    expect(safeDisplayName(".hidden", "application/pdf")).not.toMatch(/^\./);
  });

  it("keeps an ordinary name readable", () => {
    expect(safeDisplayName("Women's Retreat flyer.pdf", "application/pdf"))
      .toBe("Women's Retreat flyer.pdf");
  });

  it("falls back when nothing usable is left", () => {
    expect(safeDisplayName("///", "application/pdf")).toBe("upload.pdf");
    expect(safeDisplayName("", "image/png")).toBe("upload.png");
  });
});

describe("a tile points at exactly one thing", () => {
  it("accepts an address alone, or a file alone", () => {
    expect(eventContentLinkInputSchema.safeParse({
      label: "Flyer", url: "https://imsda.org/flyer.pdf",
    }).success).toBe(true);
    expect(eventContentLinkInputSchema.safeParse({
      label: "Flyer", assetId: "asset_1",
    }).success).toBe(true);
  });

  it("refuses both at once, and neither", () => {
    // The database carries the same rule as a CHECK. This is here so staff get
    // a sentence instead of a constraint violation.
    expect(eventContentLinkInputSchema.safeParse({
      label: "Flyer", url: "https://imsda.org/flyer.pdf", assetId: "asset_1",
    }).success).toBe(false);
    expect(eventContentLinkInputSchema.safeParse({ label: "Flyer" }).success).toBe(false);
  });

  it("still refuses a dangerous scheme when an address is used", () => {
    expect(eventContentLinkInputSchema.safeParse({
      label: "Flyer", url: "javascript:alert(1)",
    }).success).toBe(false);
  });
});
