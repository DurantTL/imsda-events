import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ageFieldId, agesNeededLabel, peopleMissingAges } from "@/modules/club-registrations/roster-ages";
import { continueButtonLabel, focusFirstMissingAge, leaveAfterSave, shownAgeError } from "@/modules/club-registrations/roster-age-flow";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }));

import { ClubRosterAgeField } from "@/components/club-roster-age-field";

const PROBLEM = "Enter Sam Staff age on the event date.";
const render = (props: { attempted?: boolean; error?: string | null; value?: string; newTab?: boolean } = {}) => renderToStaticMarkup(
  createElement(ClubRosterAgeField, {
    attempted: props.attempted,
    error: props.error === undefined ? PROBLEM : props.error,
    memberId: "m3",
    newTab: props.newTab,
    onAge: () => {},
    onSaveToRoster: () => {},
    organizationId: "org1",
    saveToRoster: true,
    value: props.value ?? "",
  }),
);

describe("Age on event date field (#718)", () => {
  it("shows no error on first render, even though the age is missing", () => {
    const html = render();
    expect(html).not.toContain(PROBLEM);
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('aria-invalid="false"');
  });

  it("shows the error once Continue has been pressed", () => {
    const html = render({ attempted: true });
    expect(html).toContain(PROBLEM);
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="club-age-m3-error"');
  });

  it("has a visible, labelled numeric input with a years suffix", () => {
    const html = render();
    expect(html).toContain('class="club-roster-age-input"');
    expect(html).toContain(`for="${ageFieldId("m3")}"`);
    expect(html).toContain(`id="${ageFieldId("m3")}"`);
    expect(html).toContain('type="number"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain("Age on event date</label>");
    expect(html).toContain("years");
  });

  it("reads the help as one sentence with a link to the roster", () => {
    const html = render();
    expect(html).toContain("No birth date on the roster. Enter their age on the event date, or ");
    expect(html).toContain('<a href="/account/clubs/org1/roster">add a birth date on the roster</a>.');
    expect(html).toContain("Also update their age on the roster");
  });
});

describe("what Continue says while ages are missing (#718)", () => {
  const person = (memberId: string, ageOnEventDate: number | null) => ({ memberId, firstName: "Sam", lastName: memberId, ageOnEventDate, reportedAge: null });
  const roster = [person("a", 12), person("b", null), person("c", null), person("d", null)];

  it("lists going people with a blank or invalid age, in roster order", () => {
    expect(peopleMissingAges(roster, ["a", "b", "c"], { c: "200" }, {}).map((p) => p.memberId)).toEqual(["b", "c"]);
    expect(peopleMissingAges(roster, ["a", "b", "c"], {}, { b: 9, c: 10 })).toEqual([]);
    expect(peopleMissingAges(roster, ["a"], {}, {})).toEqual([]);
  });

  it("words the count", () => {
    expect(agesNeededLabel(1)).toBe("Enter 1 age to continue");
    expect(agesNeededLabel(3)).toBe("Enter 3 ages to continue");
  });
});

describe("the roster link (#718)", () => {
  it("stays in the same tab by default", () => {
    const html = render();
    expect(html).not.toContain("_blank");
    expect(html).not.toContain("opens in a new tab");
  });

  it("opens in a new tab with a visible hint where unsaved edits could be lost", () => {
    const html = renderToStaticMarkup(
      createElement(ClubRosterAgeField, {
        error: null, memberId: "m3", newTab: true, onAge: () => {}, onSaveToRoster: () => {}, organizationId: "org1", saveToRoster: true, value: "",
      }),
    );
    expect(html).toContain("(opens in a new tab)");
    expect(html).toContain("add a birth date on the roster</a> (opens in a new tab).");
  });
});

describe("when the age problem shows (#718)", () => {
  it("is hidden until attempted or touched (blur)", () => {
    expect(shownAgeError(PROBLEM, false, false)).toBeNull();
    expect(shownAgeError(PROBLEM, false, true)).toBe(PROBLEM);
    expect(shownAgeError(PROBLEM, true, false)).toBe(PROBLEM);
    expect(shownAgeError(null, true, true)).toBeNull();
  });
});

describe("a blocked Continue (#718)", () => {
  it("scrolls to and focuses the first missing age input", () => {
    const calls: string[] = [];
    const input = { scrollIntoView: () => calls.push("scroll"), focus: (o: { preventScroll: true }) => calls.push(`focus:${o.preventScroll}`) };
    const found: string[] = [];
    const ok = focusFirstMissingAge(ageFieldId("b"), (id) => { found.push(id); return input; });
    expect(ok).toBe(true);
    expect(found).toEqual(["club-age-b"]);
    expect(calls).toEqual(["scroll", "focus:true"]);
  });

  it("does nothing when nobody is missing an age or the input is not on the page", () => {
    expect(focusFirstMissingAge(null, () => { throw new Error("not looked up"); })).toBe(false);
    expect(focusFirstMissingAge("club-age-x", () => null)).toBe(false);
  });
});

describe("the live Continue label (#718)", () => {
  it("asks for ages only when nothing else disables the button", () => {
    expect(continueButtonLabel({ missingAges: 3, goingCount: 5, otherwiseDisabled: false })).toBe("Enter 3 ages to continue");
    expect(continueButtonLabel({ missingAges: 1, goingCount: 2, otherwiseDisabled: false })).toBe("Enter 1 age to continue");
    expect(continueButtonLabel({ missingAges: 3, goingCount: 5, otherwiseDisabled: true })).toBe("Continue with 5 people");
    expect(continueButtonLabel({ missingAges: 0, goingCount: 1, otherwiseDisabled: false })).toBe("Continue with 1 person");
  });
});

describe("the workspace roster link saves first (#718)", () => {
  it("saves the draft, then navigates", async () => {
    const order: string[] = [];
    const saved = await leaveAfterSave({
      href: "/roster",
      flush: async () => { order.push("flush"); return true; },
      push: (href) => order.push(`push:${href}`),
      onUnsaved: () => order.push("unsaved"),
    });
    expect(saved).toBe(true);
    expect(order).toEqual(["flush", "push:/roster"]);
  });

  it("stays on the page and reports it when the save fails", async () => {
    const order: string[] = [];
    const saved = await leaveAfterSave({
      href: "/roster",
      flush: async () => false,
      push: () => order.push("push"),
      onUnsaved: (href) => order.push(`unsaved:${href}`),
    });
    expect(saved).toBe(false);
    expect(order).toEqual(["unsaved:/roster"]);
  });
});
