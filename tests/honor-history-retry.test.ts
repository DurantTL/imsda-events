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
    expect(source).toContain("dialogRef.current?.focus(); void loadHistory(historyFor.memberId, ++historyRequest.current);");
  });

  it("loads history through one helper on every path", () => {
    expect(source).toContain("async function loadHistory(memberId: string, request: number)");
    expect(source).not.toContain("setHistory(reloaded.ok");
    expect(source).toContain("await loadHistory(memberId, request)");
  });

  it("closes the void dialog and clears its error before reloading, and clears stale history errors", () => {
    const voidBody = source.slice(source.indexOf("async function submitVoid"));
    expect(voidBody.indexOf("closeVoid();")).toBeLessThan(voidBody.indexOf("await loadHistory"));
    expect(voidBody).toContain('setVoidError("");');
    expect(source.match(/setHistory\(result\);\s+setHistoryError\(""\);/g)?.length).toBe(2);
  });

  it("guards recordSingle and submitVoid against stale replies and closing", () => {
    expect(source.match(/const request = historyRequest\.current;/g)?.length).toBe(2);
    expect(source.match(/if \(request === historyRequest\.current\)/g)?.length).toBe(3);
    expect(source).toContain("historyRequest.current += 1; setHistoryFor(null);");
  });

  it("separates server and network messages structurally and rejects malformed bodies", () => {
    expect(source).not.toContain("Failed to fetch");
    expect(source).toContain('setHistoryError(result.message ?? "Honor history could not be loaded.");');
    expect(source).toContain("Array.isArray(result.history)");
    expect(source).toContain("Check your connection and try again.");
  });

  it("announces loading and resets the form element captured before awaiting", () => {
    expect(source).toContain('role="status">Loading history…');
    expect(source).toContain("const formElement = event.currentTarget;");
    expect(source).toContain("formElement.reset();");
    expect(source).not.toContain("event.currentTarget.reset()");
  });

  it("drops stale replies from an earlier request", () => {
    expect(source).toContain("const request = ++historyRequest.current;");
    expect(source.match(/if \(request !== historyRequest\.current\) return;/g)?.length).toBe(2);
  });
});
