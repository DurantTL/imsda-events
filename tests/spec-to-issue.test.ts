import { describe, expect, it } from "vitest";
import { issueBody, parseSpec, requiredSections } from "@/scripts/spec-to-issue";

function specification() {
  return `# Repeat-event blueprint

Status: Approved

Spec ID: IMSDA-repeat-blueprint

${requiredSections.map((name) => `## ${name}\n\nSynthetic ${name}.\n`).join("\n")}`;
}

describe("approved specification issue helper", () => {
  it("parses every required issue section and builds a stable marker", () => {
    const parsed = parseSpec(specification());

    expect(parsed.title).toBe("Repeat-event blueprint");
    expect(parsed.status).toBe("Approved");
    expect(issueBody(parsed)).toContain("<!-- imsda-spec-id: IMSDA-repeat-blueprint -->");
    expect(issueBody(parsed)).toContain("## Verification required");
  });

  it("rejects a missing required section", () => {
    const incomplete = specification().replace(
      "## Out of scope\n\nSynthetic Out of scope.",
      "",
    );

    expect(() => parseSpec(incomplete)).toThrow("Section '## Out of scope' is required");
  });

  it("rejects unstable or unsafe spec identifiers", () => {
    const invalid = specification().replace(
      "Spec ID: IMSDA-repeat-blueprint",
      "Spec ID: ../../participant export",
    );

    expect(() => parseSpec(invalid)).toThrow("Spec ID must be");
  });
});
