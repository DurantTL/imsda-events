import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * #131: the "Responsible adult" control on the registration form and the private registration page. One
 * radio group per minor, the adults on the same registration plus "None of us", one always selected, so the
 * choice cannot be left blank. Synthetic data only.
 */
vi.mock("server-only", () => ({}));

import { ResponsibleAdultChoice } from "@/components/responsible-adult-choice";
import { PublicResponsibleAdult } from "@/components/public-responsible-adult";

const adults = [{ key: "a-dad", name: "Dan Sample" }, { key: "a-uncle", name: "Ulf Sample" }];
const minors = [{ key: "a-son", name: "Sam Sample" }];

function render(props: Partial<Parameters<typeof ResponsibleAdultChoice>[0]> = {}) {
  return renderToStaticMarkup(createElement(ResponsibleAdultChoice, {
    idPrefix: "test_choice",
    minors,
    adults,
    values: { "a-son": "a-dad" },
    onChange: () => undefined,
    ...props,
  }));
}

describe("ResponsibleAdultChoice", () => {
  it("lists the adults on the registration plus None of us, one radio group per minor", () => {
    const markup = render();
    expect(markup).toContain("Responsible adult for");
    expect(markup).toContain("Sam Sample");
    expect(markup.match(/type="radio"/g)).toHaveLength(3);
    expect(markup).toContain("Dan Sample");
    expect(markup).toContain("Ulf Sample");
    expect(markup).toContain("None of us");
    // One shared group name per minor, and every radio is required: it cannot be left blank.
    expect(new Set(markup.match(/name="[^"]+"/g)).size).toBe(1);
    expect(markup.match(/required=""/g)).toHaveLength(3);
  });

  it("shows the preselected adult as checked, and only that one", () => {
    const markup = render({ values: { "a-son": "a-uncle" } });
    expect(markup.match(/checked=""/g)).toHaveLength(1);
    expect(markup).toMatch(/value="a-uncle"[^>]*checked=""|checked=""[^>]*value="a-uncle"/);
  });

  it("preselects None of us when the registration has no adult, and says staff will follow up", () => {
    const markup = render({ adults: [], values: { "a-son": "NONE" } });
    expect(markup.match(/type="radio"/g)).toHaveLength(1);
    expect(markup).toMatch(/value="NONE"[^>]*checked=""|checked=""[^>]*value="NONE"/);
    expect(markup).toContain("There is no adult on this registration");
  });

  it("names the problem next to the minor", () => {
    const markup = render({ errors: { "a-son": "The responsible adult for Sam Sample must be an adult on this registration." } });
    expect(markup).toContain("must be an adult on this registration");
    expect(markup).toContain("public-registration-field-invalid");
  });

  it("shows a decision staff made without letting the registrant change it", () => {
    const markup = render({ minors: [{ key: "a-son", name: "Sam Sample", locked: true }] });
    expect(markup).toContain("disabled");
    expect(markup).toContain("The event team set this");
  });

  it("gives every minor their own group", () => {
    const markup = render({ minors: [...minors, { key: "a-teen", name: "Tia Sample" }], values: { "a-son": "a-dad", "a-teen": "NONE" } });
    expect(new Set(markup.match(/name="[^"]+"/g)).size).toBe(2);
    expect(markup.match(/type="radio"/g)).toHaveLength(6);
  });
});

describe("PublicResponsibleAdult (the private registration page)", () => {
  const view = {
    adults: [{ attendeeId: "att-dad", name: "Dan Sample", isAccountHolder: true }],
    minors: [{ attendeeId: "att-son", name: "Sam Sample", choice: null, lockedByStaff: false }],
  };

  it("preselects the only adult when nothing is recorded, and offers to save it", () => {
    const markup = renderToStaticMarkup(createElement(PublicResponsibleAdult, { token: "t", view }));
    expect(markup).toContain("Responsible adult");
    expect(markup).toMatch(/value="att-dad"[^>]*checked=""|checked=""[^>]*value="att-dad"/);
    expect(markup).toContain("Save responsible adult");
  });

  it("shows the recorded choice, and no save button when staff decided every minor", () => {
    const recorded = renderToStaticMarkup(createElement(PublicResponsibleAdult, { token: "t", view: { ...view, minors: [{ ...view.minors[0]!, choice: "NONE" }] } }));
    expect(recorded).toMatch(/value="NONE"[^>]*checked=""|checked=""[^>]*value="NONE"/);
    const locked = renderToStaticMarkup(createElement(PublicResponsibleAdult, { token: "t", view: { ...view, minors: [{ ...view.minors[0]!, choice: "att-dad", lockedByStaff: true }] } }));
    expect(locked).not.toContain("Save responsible adult");
    expect(locked).toContain("The event team set this");
  });
});
