import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ageFieldId, agesNeededLabel, peopleMissingAges } from "@/modules/club-registrations/roster-ages";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }));

import { ClubRosterAgeField } from "@/components/club-roster-age-field";

const PROBLEM = "Enter Sam Staff age on the event date.";
const render = (props: { attempted?: boolean; error?: string | null; value?: string } = {}) => renderToStaticMarkup(
  createElement(ClubRosterAgeField, {
    attempted: props.attempted,
    error: props.error === undefined ? PROBLEM : props.error,
    memberId: "m3",
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
    expect(html).toContain('role="alert"');
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
