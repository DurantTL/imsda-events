import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CalendarAdminWorkspace } from "@/components/calendar-admin-workspace";
import type { CalendarAdminEntry } from "@/modules/calendar/repository";

const source = readFileSync(path.join(process.cwd(), "components/calendar-admin-workspace.tsx"), "utf8");

const entry: CalendarAdminEntry = {
  id: "entry-1",
  title: "Synthetic Rally",
  description: "",
  startsOn: "2099-05-01",
  endsOn: "2099-05-01",
  timeLabel: "",
  location: "Camp Example",
  category: "Youth",
  linkUrl: "",
  status: "SCHEDULED",
  entryType: "STANDARD",
  repeat: null,
  repeatExceptions: [],
  isPublished: true,
  sourceFeedId: null,
  sourceFeedName: null,
  isHiddenLocally: false,
  sourceRemovedAt: null,
  locallyEditedFields: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("calendar admin entries list and edit dialog (#869)", () => {
  const html = renderToStaticMarkup(createElement(CalendarAdminWorkspace, { initialEntries: [entry], initialEvents: [] }));

  it("renames the list heading and leaves the add form for new entries", () => {
    expect(html).toContain("<h2>Calendar entries</h2>");
    expect(html).not.toContain("Dates added by staff");
    expect(html).toContain("Add a date to the calendar");
  });

  it("puts a labelled, full-width search first in the Entries panel", () => {
    const panel = html.slice(html.indexOf("<h2>Calendar entries</h2>"));
    expect(panel.indexOf("Search entries")).toBeGreaterThan(-1);
    expect(panel.indexOf("Search entries")).toBeLessThan(panel.indexOf("<select"));
    expect(panel).toContain('class="calendar-search"');
    expect(panel).toContain('class="calendar-filter-row"');
  });

  it("does not render the edit dialog until Edit is used, and Edit announces a dialog", () => {
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("no longer scrolls to the top form when editing", () => {
    expect(source).not.toContain("scrollIntoView");
    expect(source).toContain("EditEntryDialog");
    expect(source).toMatch(/useAccessibleDialog<HTMLElement>\(true, \(\) => cancelUnlessBusy\(saving, onCancel\)\)/);
  });

  it("restores focus without scrolling, falling back to the list summary when the row is gone", () => {
    const hook = readFileSync(path.join(process.cwd(), "components/use-accessible-dialog.ts"), "utf8");
    expect(hook).toContain("previouslyFocused?.focus({ preventScroll: true })");
    expect(source).toMatch(/opener\?\.isConnected \? opener : summaryRef\.current/);
    expect(source).toMatch(/ref=\{summaryRef\}[^>]*tabIndex=\{-1\}/);
  });

  it("keeps the imported-item notice and errors inside the edit form", () => {
    expect(source).toContain("Imported from {entry.sourceFeedName}. Fields you change here are kept when the calendar refreshes");
    expect(source).toMatch(/!removeTarget && !bulkTarget && !editing/);
    expect(source).toMatch(/<EntryForm entry=\{entry\} error=\{error\}/);
  });
});
