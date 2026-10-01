import { afterEach, describe, expect, it } from "vitest";
import {
  clubFormIsDirty,
  clubFormUnsavedMessage,
  dropStaleRankedChoices,
  notePreview,
  rankLabel,
  rankedMaximum,
  toggleRankedChoice,
} from "@/components/club-form-state";
import { hasRegisteredUnsavedChanges, registerUnsavedChanges, unsavedChangesMessage } from "@/components/unsaved-changes-registry";
import { noSubmittedReportMessage } from "@/modules/club-reports/domain";

const saved = { answers: { a: "x", picks: ["One", "Two"] }, rosterMemberId: "", subjectName: "" };

describe("club form unsaved-changes guard (#703)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("is clean when answers match the saved state, ignoring key order and blanks", () => {
    expect(clubFormIsDirty({ ...saved, answers: { picks: ["One", "Two"], a: "x", b: "" } }, saved)).toBe(false);
  });

  it("is dirty after an edit, a re-rank, or a changed subject", () => {
    expect(clubFormIsDirty({ ...saved, answers: { ...saved.answers, a: "y" } }, saved)).toBe(true);
    expect(clubFormIsDirty({ ...saved, answers: { ...saved.answers, picks: ["Two", "One"] } }, saved)).toBe(true);
    expect(clubFormIsDirty({ ...saved, subjectName: "Pat" }, saved)).toBe(true);
  });

  it("treats a checkbox checked then unchecked as unchanged", () => {
    expect(clubFormIsDirty({ ...saved, answers: { ...saved.answers, agree: false } }, saved)).toBe(false);
    expect(clubFormIsDirty({ ...saved, answers: { ...saved.answers, agree: true } }, saved)).toBe(true);
  });

  it("registers while dirty and clears once saved", () => {
    const dirty = { ...saved, answers: { a: "changed" } };
    expect(hasRegisteredUnsavedChanges()).toBe(false);
    if (clubFormIsDirty(dirty, saved)) cleanups.push(registerUnsavedChanges(clubFormUnsavedMessage));
    expect(unsavedChangesMessage()).toBe(clubFormUnsavedMessage);
    // After a successful save the saved snapshot equals the current one: no longer dirty, the guard unregisters.
    expect(clubFormIsDirty(dirty, dirty)).toBe(false);
    cleanups.pop()!();
    expect(hasRegisteredUnsavedChanges()).toBe(false);
  });
});

describe("club form ranked choice (#703)", () => {
  const field = { options: ["A", "B", "C"], maxSelections: 2 };

  it("saves choices in tap order with rank labels", () => {
    const max = rankedMaximum(field);
    let picks: string[] = [];
    picks = toggleRankedChoice(picks, "C", max);
    picks = toggleRankedChoice(picks, "A", max);
    expect(picks).toEqual(["C", "A"]);
    expect(picks.map((option) => rankLabel(picks.indexOf(option)))).toEqual(["1st choice", "2nd choice"]);
    expect(rankLabel(-1)).toBe("Choose");
    expect(rankLabel(2)).toBe("#3");
  });

  it("stops at the maximum, and deselecting lets the rest move up and re-rank", () => {
    const max = rankedMaximum(field);
    expect(toggleRankedChoice(["C", "A"], "B", max)).toEqual(["C", "A"]);
    const dropped = toggleRankedChoice(["C", "A"], "C", max);
    expect(dropped).toEqual(["A"]);
    expect(toggleRankedChoice(dropped, "C", max)).toEqual(["A", "C"]);
  });

  it("defaults the maximum to two and never exceeds the options", () => {
    expect(rankedMaximum({ options: ["A", "B", "C"] })).toBe(2);
    expect(rankedMaximum({ options: ["A"] })).toBe(1);
  });
});

describe("meeting note preview (#703)", () => {
  it("shows short single-line notes whole", () => {
    expect(notePreview("Worked on knots.")).toBeNull();
  });

  it("truncates long notes at a word boundary", () => {
    const preview = notePreview("word ".repeat(80))!;
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(141);
  });

  it("previews multi-line notes on one line", () => {
    expect(notePreview("Line one\nLine two")).toBe("Line one…");
    expect(notePreview("Line one\n\n")).toBeNull();
  });
});

describe("area report not-submitted message (#703)", () => {
  it("names the month", () => {
    expect(noSubmittedReportMessage("2026-09")).toBe("No submitted report for September 2026 yet.");
  });
});

describe("stale ranked choices (#703)", () => {
  const definition = { sections: [{ fields: [{ key: "picks", type: "RANKED_CHOICE", options: ["A", "B"] }, { key: "t", type: "TEXT", options: [] }] }] };

  it("drops saved choices that are no longer offered, keeping order", () => {
    expect(dropStaleRankedChoices(definition, { picks: ["Gone", "B", "A"], t: "x" })).toEqual({ picks: ["B", "A"], t: "x" });
  });

  it("returns the same answers when nothing is stale", () => {
    const answers = { picks: ["A"] };
    expect(dropStaleRankedChoices(definition, answers)).toBe(answers);
  });
});
