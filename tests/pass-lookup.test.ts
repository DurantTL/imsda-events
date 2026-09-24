import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  resolveAttendeePassForEvent: vi.fn(),
  resolveClubPassForEvent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/checkin/attendee-pass-repository", () => ({
  resolveAttendeePassForEvent: dependencies.resolveAttendeePassForEvent,
}));
vi.mock("@/modules/checkin/club-pass-repository", () => ({
  resolveClubPassForEvent: dependencies.resolveClubPassForEvent,
}));

import { resolvePassLookupForEvent } from "@/modules/checkin/pass-lookup";

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.resolveAttendeePassForEvent.mockResolvedValue({ source: "QR_PASS" });
  dependencies.resolveClubPassForEvent.mockResolvedValue({ source: "QR_PASS" });
});

describe("scan/lookup dispatch between attendee and club passes (#412)", () => {
  it("routes a club pass token to the club resolver, not the attendee resolver", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    await resolvePassLookupForEvent(
      "event_123",
      { kind: "pass", value: "imsda-club-pass.v1.payload.signature" },
      now,
    );

    expect(dependencies.resolveClubPassForEvent).toHaveBeenCalledWith(
      "event_123",
      "imsda-club-pass.v1.payload.signature",
      now,
    );
    expect(dependencies.resolveAttendeePassForEvent).not.toHaveBeenCalled();
  });

  it("routes an attendee pass token to the attendee resolver, unchanged from before club passes existed", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const lookup = { kind: "pass" as const, value: "imsda-pass.v1.payload.signature" };
    await resolvePassLookupForEvent("event_123", lookup, now);

    expect(dependencies.resolveAttendeePassForEvent).toHaveBeenCalledWith(
      "event_123",
      lookup,
      now,
    );
    expect(dependencies.resolveClubPassForEvent).not.toHaveBeenCalled();
  });

  it("routes a confirmation-code lookup to the attendee resolver, exactly as before", async () => {
    const lookup = { kind: "confirmation" as const, value: "REG-ABC12345" };
    await resolvePassLookupForEvent("event_123", lookup);

    expect(dependencies.resolveAttendeePassForEvent).toHaveBeenCalledWith(
      "event_123",
      lookup,
      expect.any(Date),
    );
    expect(dependencies.resolveClubPassForEvent).not.toHaveBeenCalled();
  });
});
