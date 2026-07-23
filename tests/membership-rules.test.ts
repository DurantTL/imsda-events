import { describe, expect, it } from "vitest";
import { wouldRemoveLastActiveEventAdmin } from "@/modules/access/membership-rules";

describe("event administrator continuity", () => {
  const activeAdmin = { role: "EVENT_ADMIN" as const, status: "ACTIVE" as const };

  it("blocks demoting or deactivating the last active event administrator", () => {
    expect(wouldRemoveLastActiveEventAdmin(activeAdmin, { role: "READ_ONLY_STAFF", status: "ACTIVE" }, 0)).toBe(true);
    expect(wouldRemoveLastActiveEventAdmin(activeAdmin, { role: "EVENT_ADMIN", status: "INACTIVE" }, 0)).toBe(true);
  });

  it("allows the change after another active administrator exists", () => {
    expect(wouldRemoveLastActiveEventAdmin(activeAdmin, { role: "READ_ONLY_STAFF", status: "ACTIVE" }, 1)).toBe(false);
  });
});
