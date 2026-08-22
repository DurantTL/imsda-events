import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/events/asset-storage", () => ({
  readAsset: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

import { eventAssetResponse } from "@/modules/events/asset-response";

describe("eventAssetResponse", () => {
  it("only honors an inline disposition request for an image content type", async () => {
    const image = await eventAssetResponse({ displayName: "shirt.png", contentType: "image/png", storageKey: "key_1" }, "inline");
    expect(image.headers.get("Content-Disposition")).toMatch(/^inline;/);

    const pdf = await eventAssetResponse({ displayName: "waiver.pdf", contentType: "application/pdf", storageKey: "key_2" }, "inline");
    expect(pdf.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it("defaults to attachment when no disposition is requested", async () => {
    const response = await eventAssetResponse({ displayName: "shirt.png", contentType: "image/png", storageKey: "key_1" });
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });
});
