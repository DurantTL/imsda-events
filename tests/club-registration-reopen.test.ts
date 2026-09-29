import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { REOPEN_NOTICE, revealRosterSection } from "@/components/club-registration-editor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

/** F-23 (#571): reopening confirms itself and brings the roster section into view. */

describe("reopen confirmation", () => {
  it("scrolls to and focuses the roster section", () => {
    const element = { scrollIntoView: vi.fn(), focus: vi.fn() };
    revealRosterSection(element, false);
    expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(element.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does not animate for reduced motion, and tolerates a missing element", () => {
    const element = { scrollIntoView: vi.fn(), focus: vi.fn() };
    revealRosterSection(element, true);
    expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(() => revealRosterSection(null, false)).not.toThrow();
  });

  it("states the new state in a status message and highlights the section", () => {
    expect(REOPEN_NOTICE).toMatch(/reopened/i);
    const source = readFileSync("components/club-registration-editor.tsx", "utf8");
    expect(source).toContain('role="status"');
    // Only right after a reopen, not on every render of Step 1.
    expect(source).toContain("{justReopened && <div");
    expect(source).toContain("club-roster-highlight");
    expect(readFileSync("app/globals.css", "utf8")).toContain(".club-roster-highlight");
  });
});
