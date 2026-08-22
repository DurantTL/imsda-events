import { describe, expect, it } from "vitest";
import {
  artworkPreviewUrl,
  assetEndpoint,
  formatMerchandiseMoney,
  merchandiseAdminStatus,
  merchandiseEndpoint,
  resequenceAfterMove,
  toIsoOrNull,
  toLocalInputValue,
} from "@/components/merchandise-admin-ui";

describe("merchandise admin UI contracts", () => {
  it("builds event-scoped merchandise and asset endpoints safely", () => {
    expect(merchandiseEndpoint("event/one")).toBe("/api/events/event%2Fone/merchandise");
    expect(assetEndpoint("event/one", "/asset-1")).toBe("/api/events/event%2Fone/assets/asset-1");
  });

  it("builds the staff-only inline artwork preview URL through the same event-asset route the staff picker uses", () => {
    expect(artworkPreviewUrl("event/one", "asset/1")).toBe("/api/events/event%2Fone/assets/asset%2F1?disposition=inline");
  });

  it("formats cents for staff-facing prices", () => {
    expect(formatMerchandiseMoney(1250)).toBe("$12.50");
  });

  it("keeps archived and disabled products out of an active state", () => {
    expect(merchandiseAdminStatus({ isEnabled: true, isArchived: true })).toBe("archived");
    expect(merchandiseAdminStatus({ isEnabled: false })).toBe("disabled");
    expect(merchandiseAdminStatus({ isEnabled: true, startsAt: "2030-01-01T00:00:00Z", now: new Date("2029-01-01T00:00:00Z") })).toBe("scheduled");
  });

  it("converts a sales-window ISO timestamp to and from a datetime-local input value", () => {
    const iso = "2026-08-08T12:30:00.000Z";
    const local = toLocalInputValue(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(toIsoOrNull(local)).toBe(new Date(local).toISOString());
  });

  it("treats a blank or invalid sales-window input as no bound rather than a parsed garbage date", () => {
    expect(toIsoOrNull("")).toBeNull();
    expect(toIsoOrNull("   ")).toBeNull();
    expect(toIsoOrNull("not-a-date")).toBeNull();
    expect(toLocalInputValue(null)).toBe("");
    expect(toLocalInputValue(undefined)).toBe("");
  });

  describe("resequenceAfterMove", () => {
    it("swaps exactly the two neighbors when positions are already unique", () => {
      const items = [{ id: "a", position: 0 }, { id: "b", position: 1 }, { id: "c", position: 2 }];
      expect(resequenceAfterMove(items, "b", -1)).toEqual(expect.arrayContaining([{ id: "a", position: 1 }, { id: "b", position: 0 }]));
      expect(resequenceAfterMove(items, "b", -1)).toHaveLength(2);
      expect(resequenceAfterMove(items, "b", 1)).toEqual(expect.arrayContaining([{ id: "b", position: 2 }, { id: "c", position: 1 }]));
      expect(resequenceAfterMove(items, "b", 1)).toHaveLength(2);
    });

    it("resolves a move even when every item shares position 0, the state every product/variant starts in", () => {
      const items = [{ id: "a", position: 0 }, { id: "b", position: 0 }, { id: "c", position: 0 }];

      const changes = resequenceAfterMove(items, "b", -1);

      expect(changes).toEqual([{ id: "a", position: 1 }, { id: "c", position: 2 }]);
      // Applying the changes must actually reorder b ahead of a.
      const next = items.map((item) => ({ ...item, position: changes!.find((c) => c.id === item.id)?.position ?? item.position }));
      const order = [...next].sort((x, y) => x.position - y.position).map((item) => item.id);
      expect(order).toEqual(["b", "a", "c"]);
    });

    it("refuses to move the first item up or the last item down", () => {
      const items = [{ id: "a", position: 0 }, { id: "b", position: 1 }];
      expect(resequenceAfterMove(items, "a", -1)).toBeNull();
      expect(resequenceAfterMove(items, "b", 1)).toBeNull();
    });

    it("treats a missing position the same as position 0", () => {
      const items = [{ id: "a" }, { id: "b", position: 1 }];
      expect(resequenceAfterMove(items, "b", -1)).toEqual(expect.arrayContaining([{ id: "a", position: 1 }, { id: "b", position: 0 }]));
    });
  });
});
