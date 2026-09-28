import { describe, expect, it } from "vitest";
import {
  ACKNOWLEDGE_WINDOW_DAYS,
  acknowledgeDueAt,
  isOverdueForStaffQueue,
  transferOrganizationsProblem,
  transferReasonProblem,
} from "@/modules/club-transfers/domain";

describe("club member transfer rules (#489)", () => {
  it("puts the acknowledge deadline exactly 14 days after initiation", () => {
    expect(ACKNOWLEDGE_WINDOW_DAYS).toBe(14);
    const initiatedAt = new Date("2026-09-28T12:00:00Z");
    expect(acknowledgeDueAt(initiatedAt).toISOString()).toBe("2026-10-12T12:00:00.000Z");
  });

  it("flags a pending transfer for the staff queue once the 14 days have passed, never before, and never once resolved", () => {
    const due = new Date("2026-10-12T12:00:00Z");
    expect(isOverdueForStaffQueue({ status: "PENDING", acknowledgeDueAt: due }, new Date("2026-10-11T00:00:00Z"))).toBe(false);
    expect(isOverdueForStaffQueue({ status: "PENDING", acknowledgeDueAt: due }, new Date("2026-10-12T12:00:00Z"))).toBe(true);
    expect(isOverdueForStaffQueue({ status: "PENDING", acknowledgeDueAt: due }, new Date("2026-11-01T00:00:00Z"))).toBe(true);
    expect(isOverdueForStaffQueue({ status: "COMPLETED", acknowledgeDueAt: due }, new Date("2026-11-01T00:00:00Z"))).toBe(false);
  });

  it("requires a written reason, bounded so it stays a reason", () => {
    expect(transferReasonProblem("")).toBeTruthy();
    expect(transferReasonProblem("   ")).toBeTruthy();
    expect(transferReasonProblem("a".repeat(501))).toBeTruthy();
    expect(transferReasonProblem("The family moved across town, closer to the receiving club.")).toBeNull();
  });

  it("refuses a transfer to the same club", () => {
    expect(transferOrganizationsProblem("club-1", "club-1")).toBeTruthy();
    expect(transferOrganizationsProblem("club-1", "club-2")).toBeNull();
  });
});
