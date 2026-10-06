import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { effectiveChoice, makeSearchMatcher, matchesSearch, searchWords } from "@/lib/search-match";
import { memberMatchesSearch } from "@/components/club-earned-awards-workspace";
import { filterRowsByPersonName } from "@/modules/honors/member-honor-domain";
import { NeedsAttention } from "@/components/needs-attention";
import { clubGuestsSchema, namedSchemaIssueMessage } from "@/modules/club-registrations/domain";
import { missingAgeSummaryItems } from "@/modules/club-registrations/roster-ages";
import { namedIssueMessage } from "@/modules/forms/roster-cards";

// All names, items and numbers are synthetic.

describe("search that finds what was typed (#799 G2)", () => {
  it("matches every word in any order, ignoring case, accents and punctuation", () => {
    expect(matchesSearch(["Polo Shirt", "UN-204"], "shirt polo")).toBe(true);
    expect(matchesSearch(["Polo Shirt", "UN-204"], "un 204")).toBe(true);
    expect(matchesSearch(["Polo Shirt", "UN-204"], "un204")).toBe(true);
    expect(matchesSearch(["José"], "jose")).toBe(true);
    expect(matchesSearch(["Polo Shirt"], "scarf")).toBe(false);
    expect(matchesSearch(["Polo Shirt"], "polo scarf")).toBe(false);
  });

  it("matches everything for a blank or punctuation-only search", () => {
    expect(matchesSearch(["Anything"], "")).toBe(true);
    expect(matchesSearch(["Anything"], "  , ")).toBe(true);
    expect(searchWords("  Smith,  Jo ")).toEqual(["smith", "jo"]);
  });

  it("finds a member typed as 'Last, First', which the old search missed", () => {
    const member = { firstName: "Jo", lastName: "Synthetic", classLabel: "Pathfinder" };
    expect(memberMatchesSearch(member, "Synthetic, Jo")).toBe(true);
    expect(memberMatchesSearch(member, "jo path")).toBe(true);
    expect(filterRowsByPersonName([member], "Synthetic, Jo")).toHaveLength(1);
    expect(filterRowsByPersonName([member], "Synthetic, Al")).toHaveLength(0);
  });

  it("never leaves a hidden item chosen, and picks a sole match only once something is typed", () => {
    const listed = [{ id: "a" }, { id: "b" }];
    expect(effectiveChoice("b", listed, "x")).toBe("b");
    expect(effectiveChoice("z", listed, "x")).toBe("");
    expect(effectiveChoice("", listed, "")).toBe("");
    expect(effectiveChoice("", [{ id: "only" }], "on")).toBe("only");
    expect(effectiveChoice("z", [{ id: "only" }], "on")).toBe("only");
    // Nothing typed: a one-item list is not pre-selected.
    expect(effectiveChoice("", [{ id: "only" }], "")).toBe("");
    expect(effectiveChoice("", [{ id: "only" }], " , ")).toBe("");
    expect(effectiveChoice("a", [], "x")).toBe("");
  });

  it("matches each field on its own, never across the join of two", () => {
    expect(matchesSearch(["Ann", "Adams"], "anna")).toBe(false);
    expect(matchesSearch(["Ann", "Adams"], "ann adams")).toBe(true);
    expect(makeSearchMatcher("ab123")(["AB-123"])).toBe(true);
    expect(makeSearchMatcher("")(["x"])).toBe(true);
  });
});

describe("errors name the attendee (#799 G6)", () => {
  const names = ["Alex Synthetic", "Blake Synthetic", "Alex Synthetic"];

  it("prefixes a multi-attendee message with the attendee, and the position when two share a name", () => {
    expect(namedIssueMessage("T-shirt size is required.", 1, names, "Attendee")).toBe("Blake Synthetic — T-shirt size is required.");
    expect(namedIssueMessage("T-shirt size is required.", 2, names, "Attendee")).toBe("Alex Synthetic (Attendee 3) — T-shirt size is required.");
  });

  it("does not repeat a name the message already carries", () => {
    const message = "Choose a responsible adult for Blake Synthetic.";
    expect(namedIssueMessage(message, 1, names, "Attendee")).toBe(message);
  });

  it("names the extra person a request-validation message is about", () => {
    const parsed = z.object({ guests: clubGuestsSchema }).safeParse({ guests: [
      { id: "abcdef12", firstName: "Ok", lastName: "Person", age: 20, email: null },
      { id: "abcdef34", firstName: "", lastName: "Person", age: 20, email: null },
    ] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((issue) => namedSchemaIssueMessage(issue));
    expect(messages).toContain("Extra person 2: Enter a first name.");
    expect(namedSchemaIssueMessage({ path: ["newGuests", 0, "age"], message: "Enter an age from 0 to 120." })).toBe("New extra person 1: Enter an age from 0 to 120.");
    expect(namedSchemaIssueMessage({ path: ["selectedMemberIds"], message: "Pick someone." })).toBe("Pick someone.");
  });

  it("lists each person who still needs an age, by name, with a link target for their own field", () => {
    const items = missingAgeSummaryItems([
      { memberId: "m1", firstName: "Sam", lastName: "Synthetic", ageOnEventDate: null, reportedAge: null },
      { memberId: "m2", firstName: "Kim", lastName: "Synthetic", ageOnEventDate: null, reportedAge: null },
    ]);
    expect(items.map((item) => item.text)).toEqual([
      "Sam Synthetic needs an age on the event date.",
      "Kim Synthetic needs an age on the event date.",
    ]);
    expect(items.map((item) => item.fieldId)).toEqual(["club-age-m1", "club-age-m2"]);
  });
});

describe('"Needs attention" looks urgent (#799 G4)', () => {
  it("is an icon plus bold text, never colour alone", () => {
    const html = renderToStaticMarkup(createElement(NeedsAttention));
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<strong>Needs attention</strong>");
    expect(html).toContain('class="needs-attention"');
  });
});
