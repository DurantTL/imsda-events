import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { RosterUnlockForm } from "@/components/roster-unlock-form";
import { squareTestModeNotice } from "@/modules/payments/square-sandbox-notice";

describe("square test-mode notice (#700)", () => {
  it("is hidden from the public, including in sandbox", () => {
    expect(squareTestModeNotice({ environment: "sandbox", staffPreview: false })).toBeNull();
    expect(squareTestModeNotice({ environment: "production", staffPreview: false })).toBeNull();
  });

  it("shows Test mode wording only to a staff preview in sandbox", () => {
    expect(squareTestModeNotice({ environment: "sandbox", staffPreview: true })).toBe("Test mode — no real charge will be made");
    expect(squareTestModeNotice({ environment: "production", staffPreview: true })).toBeNull();
  });
});

describe("authenticator code input (#700)", () => {
  it("has a visible label, not only a placeholder", () => {
    const html = renderToStaticMarkup(createElement(RosterUnlockForm));
    expect(html).toContain("Authenticator code");
    expect(html).not.toContain("sr-only");
  });
});
