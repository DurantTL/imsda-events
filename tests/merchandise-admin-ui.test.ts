import { describe, expect, it } from "vitest";
import {
  assetEndpoint,
  formatMerchandiseMoney,
  merchandiseAdminStatus,
  merchandiseEndpoint,
} from "@/components/merchandise-admin-ui";

describe("merchandise admin UI contracts", () => {
  it("builds event-scoped merchandise and asset endpoints safely", () => {
    expect(merchandiseEndpoint("event/one")).toBe("/api/events/event%2Fone/merchandise");
    expect(assetEndpoint("event/one", "/asset-1")).toBe("/api/events/event%2Fone/assets/asset-1");
  });

  it("formats cents for staff-facing prices", () => {
    expect(formatMerchandiseMoney(1250)).toBe("$12.50");
  });

  it("keeps archived and disabled products out of an active state", () => {
    expect(merchandiseAdminStatus({ isEnabled: true, isArchived: true })).toBe("archived");
    expect(merchandiseAdminStatus({ isEnabled: false })).toBe("disabled");
    expect(merchandiseAdminStatus({ isEnabled: true, startsAt: "2030-01-01T00:00:00Z", now: new Date("2029-01-01T00:00:00Z") })).toBe("scheduled");
  });
});
