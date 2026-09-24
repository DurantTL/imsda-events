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

  // Q1 (#412): a club's own QR is a distinct token; the scanner reads it the
  // same way it reads an attendee's, and just forwards it to the resolve
  // route, which tells the two token types apart.
  it("also accepts a club's own signed QR pass, compact or embedded in a URL", () => {
    expect(extractAttendeePassToken(
      "imsda-club-pass.v1.payload.signature",
    )).toBe("imsda-club-pass.v1.payload.signature");
    expect(extractAttendeePassToken(
      "https://events.imsda.org/check-in?event=event_123&pass=imsda-club-pass.v1.payload.signature",
    )).toBe("imsda-club-pass.v1.payload.signature");
  });
});

