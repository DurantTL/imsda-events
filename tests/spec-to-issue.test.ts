import { describe, expect, it } from "vitest";

import {
  issueBody,
  parseSpec,
  requiredSections,
  withGitHubIssueUrl,
} from "@/scripts/spec-to-issue";

function validSpec(overrides: Partial<Record<string, string>> = {}) {
  const frontmatter = {
    spec_id: "IMSDA-synthetic-example",
    status: "draft",
    milestone: "WR26",
    risk: "low",
    github_issue_url: "",
    ...overrides,
  };
  const sections = requiredSections
    .map((section) => `## ${section}\n\nSynthetic ${section.toLowerCase()} content.`)
    .join("\n\n");

  return [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    "# Synthetic specification",
    "",
    sections,
    "",
  ].join("\n");
}

describe("specification publication", () => {
  it("requires complete YAML frontmatter", () => {
    const markdown = validSpec({ milestone: "" });

    expect(() => parseSpec(markdown)).toThrow(
      "Frontmatter field 'milestone' is required.",
    );
  });

  it("rejects unstable or unsafe specification identifiers", () => {
    const markdown = validSpec({ spec_id: "../../participant export" });

    expect(() => parseSpec(markdown)).toThrow("Spec ID must be");
  });

  it("requires every issue section", () => {
    const markdown = validSpec().replace(
      "## Out of scope\n\nSynthetic out of scope content.",
      "",
    );

    expect(() => parseSpec(markdown)).toThrow(
      "Section '## Out of scope' is required",
    );
  });

  it("builds an issue body with a stable idempotency marker", () => {
    const spec = parseSpec(validSpec());

    expect(issueBody(spec)).toContain(
      "<!-- imsda-spec-id: IMSDA-synthetic-example -->",
    );
    expect(issueBody(spec)).toContain("Milestone: WR26");
    expect(issueBody(spec)).toContain("Risk: low");
  });

  it("records the issue URL without changing the specification ID", () => {
    const markdown = validSpec();
    const updated = withGitHubIssueUrl(
      markdown,
      "https://github.com/DurantTL/imsda-events/issues/123",
    );

    expect(updated).toContain(
      'github_issue_url: "https://github.com/DurantTL/imsda-events/issues/123"',
    );
    expect(parseSpec(updated).specId).toBe("IMSDA-synthetic-example");
  });

  it("refuses to replace a different recorded issue URL", () => {
    const markdown = validSpec({
      github_issue_url: '"https://github.com/DurantTL/imsda-events/issues/123"',
    });

    expect(() =>
      withGitHubIssueUrl(
        markdown,
        "https://github.com/DurantTL/imsda-events/issues/456",
      ),
    ).toThrow("already references a different GitHub issue");
  });
});
