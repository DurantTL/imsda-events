import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HonorPillList } from "@/components/honor-pill-list";
import { needsDatedBefore, sortNeedsOldestFirst } from "@/modules/club-orders/domain";
import type { CurrentMemberHonor } from "@/modules/honors/member-honor-domain";

const pill = (props: Parameters<typeof HonorPillList>[0]) => renderToStaticMarkup(createElement(HonorPillList, props));
const honors = (count: number): CurrentMemberHonor[] => Array.from({ length: count }, (_, index) => ({
  honorId: `h${index + 1}`,
  honorCode: `AR-${index + 1}`,
  honorName: `Honor ${index + 1}`,
  status: index % 2 === 0 ? "COMPLETED" : "IN_PROGRESS",
  completionDate: "",
  createdAt: "2026-09-01",
}));

describe("HonorPillList (#790)", () => {
  it("renders every honor, hiding (not removing) the ones past the threshold, with the toggle", () => {
    const html = pill({ honors: honors(9) });
    expect((html.match(/honor-pill /g) ?? []).length).toBe(9);
    expect((html.match(/ hidden=""/g) ?? []).length).toBe(3);
    expect(html).toContain("Show all (9)");
    // Collapsed is not a scroll box, so it is not a keyboard stop.
    expect(html).not.toContain('tabindex="0"');
  });

  it("shows no toggle and hides nothing for a short list, and a dash for none", () => {
    const html = pill({ honors: honors(6) });
    expect(html).not.toContain("Show all");
    expect(html).not.toContain(' hidden=""');
    expect(pill({ honors: [] })).toBe("—");
  });

  it("names the status in the pill only when asked", () => {
    expect(pill({ honors: honors(1), showStatus: true })).toContain("Honor 1 · Completed");
    expect(pill({ honors: honors(1) })).not.toContain("· Completed</span>");
  });
});

describe("order list with undated needs (#790)", () => {
  const need = (id: string, sourceDate: string, created = 1) => ({ id, sourceDate, createdAt: new Date(2026, 8, created) });

  it("sorts undated needs after every dated one, then by creation", () => {
    const sorted = sortNeedsOldestFirst([
      need("c", ""), need("b", "2026-08-01"), need("d", "", 2), need("a", "2026-05-01"), need("e", "2026-08-01", 0),
    ]);
    expect(sorted.map((row) => row.id)).toEqual(["a", "e", "b", "c", "d"]);
  });

  it("doesn't change its input", () => {
    const input = [need("b", ""), need("a", "2026-01-01")];
    sortNeedsOldestFirst(input);
    expect(input.map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("selects only dated needs strictly before the date, and nothing for a blank date", () => {
    const needs = [need("a", "2026-05-01"), need("b", "2026-06-01"), need("u", "")];
    expect(needsDatedBefore(needs, "2026-06-01").map((row) => row.id)).toEqual(["a"]);
    expect(needsDatedBefore(needs, "2027-01-01").map((row) => row.id)).toEqual(["a", "b"]);
    expect(needsDatedBefore(needs, "")).toEqual([]);
  });
});
