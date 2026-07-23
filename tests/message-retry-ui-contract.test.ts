import { describe, expect, it } from "vitest";
import { messageRetryRequestPayload } from "@/modules/communications/message-retry-client";

describe("message-retry UI request contract", () => {
  it("reuses the caller-owned UUID and server fingerprint without private content", () => {
    const payload = messageRetryRequestPayload(
      { retryRequestFingerprint: "d".repeat(64) },
      "2e406463-3951-47dc-942b-b29437ffb0fd",
    );
    expect(payload).toEqual({
      clientRequestId: "2e406463-3951-47dc-942b-b29437ffb0fd",
      requestFingerprint: "d".repeat(64),
    });
    expect(payload).not.toHaveProperty("recipientEmail");
    expect(payload).not.toHaveProperty("bodyText");
    expect(payload).not.toHaveProperty("token");
  });
});
