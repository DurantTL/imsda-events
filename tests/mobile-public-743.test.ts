import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpandableOptionDescription, ExpandableText, isLongText } from "@/components/expandable-text";
import {
  attendeeSummaryText,
  attendeeToOpenForIssues,
  pickInitialActiveAttendee,
} from "@/modules/forms/roster-cards";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const form = read("components/public-registration-form.tsx");
const css = read("app/globals.css");
const block = css.slice(css.indexOf("Issue 743: mobile public registration"));

describe("one active attendee at a time (#743)", () => {
  it("opens the first person who still needs something, and nobody when all are done", () => {
    expect(pickInitialActiveAttendee([
      { clientId: "a", complete: true },
      { clientId: "b", complete: false },
      { clientId: "c", complete: false },
    ])).toBe("b");
    expect(pickInitialActiveAttendee([{ clientId: "a", complete: true, mismatchCount: 1 }])).toBe("a");
    expect(pickInitialActiveAttendee([{ clientId: "a", complete: true }])).toBeNull();
  });

  it("keeps a single active id and renders a one-line summary with Edit for the rest", () => {
    expect(form).toContain("const [activeAttendeeId, setActiveAttendeeId] = useState<string | null>");
    expect(form).not.toContain("collapsedAttendeeIds");
    expect(form).toContain("const collapsed = canCollapse && !(isActive && (!isPhone || sheetOpen));");
    expect(form).toContain('{collapsed ? "Edit" : "Done"}');
    expect(form).toContain("{complete ? <StatusComplete /> : <NeedsAttention />}");
    expect(attendeeSummaryText("Ada Example", "Guest", true)).toBe("Ada Example · Guest · Complete");
    expect(attendeeSummaryText("Attendee 2", null, false)).toBe("Attendee 2 · Needs attention");
  });

  it("adding an attendee makes the new card the active one", () => {
    expect(form).toMatch(/function addAttendee\(\)[\s\S]*?openAttendee\(clientId\)/);
  });
});

describe("a validation error opens the right attendee (#743)", () => {
  const ids = ["a", "b", "c"];
  it("targets the card the first issue points into", () => {
    expect(attendeeToOpenForIssues([{ path: "attendees.2.responses.age" }], ids)).toBe("c");
    expect(attendeeToOpenForIssues([{ attendeeIndex: 1 }, { attendeeIndex: 2 }], ids)).toBe("b");
    expect(attendeeToOpenForIssues([{ path: "responses.email", scope: "REGISTRATION" }, { path: "attendees.1.responses.age" }], ids)).toBe("b");
    expect(attendeeToOpenForIssues([{ path: "responses.email", scope: "REGISTRATION" }], ids)).toBeNull();
    expect(attendeeToOpenForIssues([{ scope: "ATTENDEE" }], ids)).toBe("a");
  });

  it("wires showIssues and the summary link to it, keeping the #762 focus", () => {
    expect(form).toMatch(/function showIssues[\s\S]*?expandAttendeeCardsFor\(shownIssues\)[\s\S]*?errorSummaryRef\.current\?\.focus\(\)/);
    expect(form).toMatch(/function followIssueLink[\s\S]*?expandAttendeeCardsFor\(\[issue\]\)[\s\S]*?setSheetOpen\(true\)[\s\S]*?target\?\.focus\(\)/);
  });
});

describe("answers survive collapse (#743)", () => {
  it("hides the body instead of unmounting it, and keeps answers in lifted state", () => {
    expect(form).toContain("hidden={collapsed}");
    expect(form).not.toMatch(/\{!collapsed && \(\s*<div className="public-registration-attendee-body"/);
    expect(form).toContain("const [attendees, setAttendees] = useState<RosterAttendee[]>");
    expect(block).toContain(".public-registration-attendee-body[hidden] { display: none !important; }");
  });
});

describe("attendee sheet accessibility (#743)", () => {
  it("is a modal dialog only while open on a phone, with the shared trap, Escape and focus return", () => {
    expect(form).toContain('role={inSheet ? "dialog" : undefined}');
    expect(form).toContain('aria-modal={inSheet ? "true" : undefined}');
    expect(form).toContain("useAccessibleDialog<HTMLElement>(phoneSheetActive, () => setSheetOpen(false))");
    expect(form).toContain("useInertBackground(phoneSheetActive ? activeAttendeeId : null, attendeeSheetRef)");
    expect(form).toContain("clickEvent.currentTarget.focus();");
    const hook = read("components/use-attendee-sheet.ts");
    expect(hook).toContain("sibling.inert = true");
    expect(hook).toContain("element.inert = false");
    expect(read("components/use-accessible-dialog.ts")).toMatch(/Escape[\s\S]*previouslyFocused\?\.focus\(\)/);
  });

  it("never opens by itself on page load", () => {
    expect(form).toContain("const [sheetOpen, setSheetOpen] = useState(false);");
  });

  it("is full screen with the safe-area inset, and the pick list is a bottom sheet", () => {
    expect(block).toMatch(/\.public-registration-attendee\.is-sheet \{[^}]*position: fixed;[^}]*inset: 0;/);
    expect(block).toContain("env(safe-area-inset-top");
    expect(block).toMatch(/\.searchable-select-options \{[^}]*position: fixed;[^}]*bottom: var\(--searchable-sheet-inset, 0px\)/);
  });
});

describe("sticky registration CTA (#743)", () => {
  it("marks the step bar and sticks it with the safe-area inset, last in the column, phone only", () => {
    expect(form).toContain('className="public-registration-step-actions is-sticky-cta"');
    expect(block).toMatch(/@media only screen and \(max-width: 768px\)/);
    expect(block).toMatch(/\.is-sticky-cta \{[^}]*position: sticky;[^}]*bottom: 0;[^}]*order: 99;/);
    expect(block).toContain("padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px));");
    expect(block).toContain("scroll-margin-bottom: calc(96px + env(safe-area-inset-bottom, 0px))");
  });

  it("is not sticky in print (the rules live in a screen-only query)", () => {
    expect(block).not.toContain("@media print");
    expect(block.match(/position: sticky/g)?.length).toBeGreaterThan(0);
    expect(block.slice(0, block.indexOf("@media only screen"))).not.toContain("position: sticky");
  });

  it("has a Submit in the bar on review and the stylesheet braces balance", () => {
    expect(form).toContain("public-registration-submit-button is-sticky-submit");
    let depth = 0;
    for (const char of css) depth += char === "{" ? 1 : char === "}" ? -1 : 0;
    expect(depth).toBe(0);
  });
});

describe("no modals for steps, fees or help (#743)", () => {
  it("the public form's only dialog is the remove-attendee confirmation", () => {
    expect(form.match(/<ConfirmDialog/g)?.length).toBe(1);
    expect(form).toContain("Remove ${pendingName} and their answers?");
    expect(form).not.toMatch(/role="dialog"[^>]*(fee|help|step)/i);
    for (const file of ["components/group-registration-flow.tsx", "components/expandable-text.tsx"]) {
      expect(read(file)).not.toMatch(/ConfirmDialog|modal-backdrop|aria-modal/);
    }
  });

  it("long help expands inline with a disclosure", () => {
    expect(form).toContain("<details className=\"public-registration-select-descriptions-disclosure\">");
  });
});

describe("intro and description expanders (#743)", () => {
  it("shows a short text whole and a long text clamped with a Read more button", () => {
    expect(isLongText("Short intro.")).toBe(false);
    const short = renderToStaticMarkup(createElement(ExpandableText, { text: "Short intro." }));
    expect(short).not.toContain("Read more");
    const long = renderToStaticMarkup(createElement(ExpandableText, { text: "Long words. ".repeat(30) }));
    expect(long).toContain("is-clamped");
    expect(long).toContain('aria-expanded="false"');
    expect(long).toContain("Read more");
    expect(long).toContain("Long words.");
  });

  it("uses it for the intro and keeps a choice's radio outside the Read more button", () => {
    expect(form).toContain("<ExpandableText text={definition.description} />");
    const markup = renderToStaticMarkup(createElement(ExpandableOptionDescription, {
      text: "A long description of this attendee type. ".repeat(6),
      renderChoice: (description) => createElement("label", null, createElement("input", { type: "radio" }), description),
    }));
    expect(markup).toMatch(/<\/label><button[^>]*aria-expanded="false"[^>]*>Read more<\/button>/);
    const plain = renderToStaticMarkup(createElement(ExpandableOptionDescription, {
      text: "Short.",
      renderChoice: (description) => createElement("label", null, description),
    }));
    expect(plain).not.toContain("Read more");
    expect(form).toContain("<ExpandableOptionDescription");
  });
});
