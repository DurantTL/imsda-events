import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The honor history dialog used to sit on "Loading history…" forever when the
// request failed (round-2 audit). It now shows the error with a Retry button,
// and ignores replies for a member the dialog is no longer showing.
describe("honor history dialog failure state", () => {
  const source = readFileSync(path.join(process.cwd(), "components/club-honors-workspace.tsx"), "utf8");

  it("records a load failure instead of swallowing it", () => {
    expect(source).toContain("setHistoryError(");
    expect(source).not.toContain("The dialog just stays on");
  });

  it("shows the error with a Retry button that reloads the same member", () => {
    expect(source).toMatch(/historyError \? \(/);
    expect(source).toContain('role="alert">{historyError}');
    expect(source).toContain("onClick={() => void openHistory(historyFor)}");
  });

  it("drops stale replies from an earlier request", () => {
    expect(source).toContain("const request = ++historyRequest.current;");
    expect(source.match(/if \(request !== historyRequest\.current\) return;/g)?.length).toBe(2);
  });
});
