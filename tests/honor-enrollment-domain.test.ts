import { describe, expect, it } from "vitest";
import { consumesClassSeat, selectionProblem, type SelectableOffering } from "@/modules/honors/enrollment-domain";

const offering = (id: string, overrides: Partial<SelectableOffering> = {}): SelectableOffering => ({
  id, honorName: id, span: "SINGLE_SESSION", sessionId: "sabbath", minimumAge: null, isActive: true, ...overrides,
});
const offerings = new Map([
  offering("knots"),
  offering("birds", { sessionId: "sunday" }),
  offering("stars", { sessionId: "sabbath" }),
  offering("backpacking", { span: "ALL_SESSIONS", sessionId: null, minimumAge: 12 }),
  offering("retired", { isActive: false, sessionId: "sunday" }),
].map((row) => [row.id, row]));
const youth = { ageOnEventDate: 11 };

describe("class selection rules", () => {
  it("allows one class per session", () => {
    expect(selectionProblem(youth, ["knots", "birds"], offerings)).toBeNull();
    expect(selectionProblem(youth, ["knots", "stars"], offerings)).toMatch(/one class per session/);
    expect(selectionProblem(youth, ["knots", "knots"], offerings)).toMatch(/twice/);
  });

  it("keeps an all-sessions class on its own", () => {
    expect(selectionProblem({ ageOnEventDate: 13 }, ["backpacking"], offerings)).toBeNull();
    expect(selectionProblem({ ageOnEventDate: 13 }, ["backpacking", "birds"], offerings)).toMatch(/only class/);
  });

  it("enforces minimum age from age on the event date", () => {
    expect(selectionProblem(youth, ["backpacking"], offerings)).toMatch(/ages 12 and up/);
    expect(selectionProblem({ ageOnEventDate: null }, ["backpacking"], offerings)).toMatch(/age isn't on the roster/);
    expect(selectionProblem({ ageOnEventDate: 12 }, ["backpacking"], offerings)).toBeNull();
  });

  it("refuses unknown and newly retired classes, but lets someone keep a retired one", () => {
    expect(selectionProblem(youth, ["made-up"], offerings)).toMatch(/isn't offered/);
    expect(selectionProblem(youth, ["retired"], offerings)).toMatch(/no longer offered/);
    expect(selectionProblem(youth, ["retired"], offerings, new Set(["retired"]))).toBeNull();
  });

  it("counts only youth against seats", () => {
    expect(consumesClassSeat("YOUTH")).toBe(true);
    expect(consumesClassSeat("UNDERAGE")).toBe(true);
    expect(consumesClassSeat(null)).toBe(true);
    expect(consumesClassSeat("STAFF")).toBe(false);
    expect(consumesClassSeat("ADULT")).toBe(false);
  });
});
