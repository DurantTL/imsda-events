import { describe, expect, it } from "vitest";
import { extractAttendeePassToken } from "@/components/check-in-scanner";

describe("attendee pass scanner input", () => {
  it("accepts the compact signed token used by generated QR images", () => {
    expect(extractAttendeePassToken(
      "imsda-pass.v1.payload.signature",
    )).toBe("imsda-pass.v1.payload.signature");
  });

  it("accepts a check-in URL but rejects unrelated QR content", () => {
    expect(extractAttendeePassToken(
      "https://events.imsda.org/check-in?event=event_123&pass=imsda-pass.v1.payload.signature",
    )).toBe("imsda-pass.v1.payload.signature");
    expect(extractAttendeePassToken(
      "https://untrusted.example/promotion",
    )).toBeNull();
    expect(extractAttendeePassToken("plain attendee name")).toBeNull();
  });
});

