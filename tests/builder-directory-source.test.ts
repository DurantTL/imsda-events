import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Field settings only render once a field is expanded (client state), so this
// checks the builder source: a directory-sourced field shows a note instead of
// the hand-typed choices, per-choice descriptions, and per-choice prices.
const builder = readFileSync(path.join(process.cwd(), "components/registration-builder-workspace.tsx"), "utf8");

describe("builder directory-sourced fields (#482)", () => {
  it("replaces the choices and description editors with a note for a directory-sourced field", () => {
    const note = builder.indexOf("{isDirectoryOptionSource(field.optionSource) ? <p className=\"field-full inline-notice\"");
    expect(note).toBeGreaterThan(-1);
    expect(builder).toContain("Options come from the live {directorySourceNoun(field.optionSource)} directory.");
    const choices = builder.indexOf("Choices — one per line", note);
    const descriptions = builder.indexOf("choice-description-editor", note);
    const close = builder.indexOf("</>}", note);
    // Both editors sit inside the non-directory branch.
    expect(choices).toBeGreaterThan(note);
    expect(descriptions).toBeGreaterThan(choices);
    expect(close).toBeGreaterThan(descriptions);
    // Per-choice prices would reference choices a directory field never stores.
    expect(builder).toContain("{!isDirectoryOptionSource(field.optionSource) && <div className={`field-full choice-limit-editor");
  });
});
