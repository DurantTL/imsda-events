import { readFileSync } from "node:fs";
import path from "node:path";
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

describe("registration recovery UI request contract", () => {
  it("keeps one request UUID for uncertain retries of unchanged input", () => {
    const source = readFileSync(path.join(
      process.cwd(),
      "components/public-registration-recovery-form.tsx",
    ), "utf8");

    expect(source).toContain("const requestIds = useRef");
    expect(source).toContain("requestIds.current[action]?.fingerprint !== fingerprint");
    expect(source).toContain("id: crypto.randomUUID()");
    expect(source).toContain("const clientRequestId = requestIds.current[action]!.id");
    expect(source).not.toContain("clientRequestId: crypto.randomUUID()");
  });

  it("carries the page return destination only with direct access", () => {
    const formSource = readFileSync(path.join(
      process.cwd(),
      "components/public-registration-recovery-form.tsx",
    ), "utf8");
    const pageSource = readFileSync(path.join(
      process.cwd(),
      "app/(public)/recover-registration/page.tsx",
    ), "utf8");

    expect(pageSource).toContain("<PublicRegistrationRecoveryForm returnTo={returnTo} />");
    expect(formSource).toContain("...(returnTo ? { returnTo } : {})");
  });
});
