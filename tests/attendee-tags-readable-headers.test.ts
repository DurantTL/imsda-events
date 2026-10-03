import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttendeeConfigurationWorkspace } from "@/components/attendee-configuration-workspace";
import { TagConfigurationWorkspace } from "@/components/tag-configuration-workspace";

const root = process.cwd();
const globalsCss = readFileSync(path.join(root, "app/globals.css"), "utf8");

const attendeeType = {
  id: "type_1", code: "ADULT", label: "Adult", description: "18 and over",
  sortOrder: 0, isActive: true, minimumAge: 18, maximumAge: null,
};
const classification = {
  id: "class_1", kind: "CATEGORY" as const, code: "WORSHIP", label: "Worship",
  description: "", sortOrder: 0, isActive: true,
};
const tag = { id: "tag_1", name: "VIP", color: "#4F46E5", description: "Priority seating", isActive: true };

describe("attendee configuration: readable table headers and where-this-shows-up (#474)", () => {
  it("renders a real header cell per column, not a single run-together string", () => {
    const markup = renderToStaticMarkup(createElement(AttendeeConfigurationWorkspace, {
      eventId: "event_1", eventName: "Fall Retreat", initialTypes: [attendeeType], initialClassifications: [classification],
    }));
    for (const heading of ["Code", "Label", "Description", "Sort order", "Age band", "Status", "Actions"]) {
      expect(markup).toContain(`<th>${heading}</th>`);
    }
    for (const heading of ["Dimension", "Code", "Label", "Description", "Sort order", "Status", "Actions"]) {
      expect(markup).toContain(`<th>${heading}</th>`);
    }
    // Column headers are distinct DOM cells, never concatenated into one string.
    expect(markup).not.toContain("CodeLabelDescription");
  });

  it("renders a per-field data-label on every record card cell, for the narrow-screen card layout", () => {
    const markup = renderToStaticMarkup(createElement(AttendeeConfigurationWorkspace, {
      eventId: "event_1", eventName: "Fall Retreat", initialTypes: [attendeeType], initialClassifications: [classification],
    }));
    for (const label of ["Code", "Label", "Description", "Sort order", "Age band", "Status", "Actions"]) {
      expect(markup).toContain(`data-label="${label}"`);
    }
    expect(markup).toContain('data-label="Dimension"');
  });

  it("renders headers even with an empty table (no rows yet)", () => {
    const markup = renderToStaticMarkup(createElement(AttendeeConfigurationWorkspace, {
      eventId: "event_1", eventName: "Fall Retreat", initialTypes: [], initialClassifications: [],
    }));
    expect(markup).toContain("<th>Code</th><th>Label</th>");
    expect(markup).toContain("<th>Dimension</th><th>Code</th>");
  });

  it("gives the editable table a shared class with real desktop header styling and a narrow-screen card layout", () => {
    expect(globalsCss).toMatch(/\.editable-settings-table\s*\{[^}]*width: 100%;[^}]*\}/);
    expect(globalsCss).toMatch(/\.editable-settings-table thead th\s*\{[^}]*text-transform: uppercase;[^}]*\}/);
    expect(globalsCss).toContain(".editable-settings-table thead { display: none; }");
    expect(globalsCss).toMatch(/\.editable-settings-table td\[data-label\]::before\s*\{[^}]*content: attr\(data-label\);/);
  });

  it("tells staff in plain language where attendee types and groupings show up, with links", () => {
    const markup = renderToStaticMarkup(createElement(AttendeeConfigurationWorkspace, {
      eventId: "event_42", eventName: "Fall Retreat", initialTypes: [attendeeType], initialClassifications: [classification],
    }));
    expect(markup).toContain("Where this shows up");
    expect(markup).toContain('href="/registration-builder?event=event_42"');
    expect(markup).toContain('href="/more/reports?event=event_42"');
    expect(markup).toContain('href="/check-in?event=event_42"');
  });

  it("replaces system wording ('orthogonal categories') with plain language", () => {
    const markup = renderToStaticMarkup(createElement(AttendeeConfigurationWorkspace, {
      eventId: "event_1", eventName: "Fall Retreat", initialTypes: [attendeeType], initialClassifications: [classification],
    }));
    expect(markup.toLowerCase()).not.toContain("orthogonal");
    expect(markup).toContain("an attendee can have several of each");
  });
});

describe("tags: readable table headers and where-this-shows-up (#474)", () => {
  it("renders a real header cell per column, not a single run-together string", () => {
    const markup = renderToStaticMarkup(createElement(TagConfigurationWorkspace, {
      eventId: "event_1", eventName: "Fall Retreat", initialTags: [tag],
    }));
    for (const heading of ["Color", "Name", "Description", "Status", "Actions"]) {
      expect(markup).toContain(`<th>${heading}</th>`);
    }
    expect(markup).not.toContain("ColorNameDescription");
  });

  it("renders a per-field data-label on every tag card cell, for the narrow-screen card layout", () => {
    const markup = renderToStaticMarkup(createElement(TagConfigurationWorkspace, {
      eventId: "event_1", eventName: "Fall Retreat", initialTags: [tag],
    }));
    for (const label of ["Color", "Name", "Description", "Status", "Actions"]) {
      expect(markup).toContain(`data-label="${label}"`);
    }
  });

  it("renders headers with a tag, and explains an empty list instead of showing a bare table (#743)", () => {
    const withTag = renderToStaticMarkup(createElement(TagConfigurationWorkspace, {
      eventId: "event_1", eventName: "Fall Retreat",
      initialTags: [{ id: "t1", name: "Fixture", color: "#4F46E5", description: "", isActive: true }],
    }));
    expect(withTag).toContain("<th>Color</th><th>Name</th><th>Description</th><th>Status</th><th>Actions</th>");
    const empty = renderToStaticMarkup(createElement(TagConfigurationWorkspace, {
      eventId: "event_1", eventName: "Fall Retreat", initialTags: [],
    }));
    expect(empty).toContain("No tags yet");
    expect(empty).not.toContain("<th>Color</th>");
  });

  it("tells staff in plain language where tags show up, with a link, and only claims wiring that exists", () => {
    const markup = renderToStaticMarkup(createElement(TagConfigurationWorkspace, {
      eventId: "event_9", eventName: "Fall Retreat", initialTags: [tag],
    }));
    expect(markup).toContain("Where this shows up");
    expect(markup).toContain('href="/people?event=event_9"');
  });
});
