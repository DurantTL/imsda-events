import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "components/communications-workspace.tsx"), "utf8");

describe("Retry failed UI contract (#860)", () => {
  it("retries only from the confirm button, after a preview, and never from an effect", () => {
    const calls = source.match(/confirmRetryFailed\(/g) ?? [];
    // The definition and the one onClick={confirmRetryFailed} reference; no call site in an effect or timer.
    expect(calls).toHaveLength(1);
    expect(source).toContain("onClick={confirmRetryFailed}");
    expect(source).toContain("previewFingerprint: retryFailedPreview.fingerprint");
    expect(source).toContain("retryFailedRequestRef");
    expect(source).not.toMatch(/setInterval\([^)]*confirmRetryFailed/);
  });

  it("refreshes the delivery log every 15 to 30 seconds only while messages are queued, and offers a Refresh button", () => {
    const interval = Number(source.match(/DELIVERY_REFRESH_INTERVAL_MS = ([\d_]+)/)?.[1]?.replaceAll("_", ""));
    expect(interval).toBeGreaterThanOrEqual(15_000);
    expect(interval).toBeLessThanOrEqual(30_000);
    expect(source).toContain('document.visibilityState !== "visible"');
    expect(source).toContain("queuedOrSending === 0) return;");
    expect(source).toContain("onClick={refreshDeliveries}");
  });
});
