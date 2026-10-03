import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { DeskLocationSelect, deskLocationHref, deskLocationLabel, isSelectStepKey } from "@/components/desk-location-select";

/** Check-in desk location control (#413). Synthetic names and ids only. */
const locations = [
  { id: "loc_a", name: "Sunnydale Academy", isActive: true },
  { id: "loc_b", name: "Old Campus", isActive: false },
];
const render = (selectedId: string | null, list = locations) =>
  renderToStaticMarkup(createElement(DeskLocationSelect, { basePath: "/check-in", locations: list, params: { event: "event_a" }, selectedId }));

describe("desk location select", () => {
  it("builds the same URLs the LocationFilter links do", () => {
    expect(deskLocationHref("/check-in", { event: "event_a" }, null)).toBe("/check-in?event=event_a");
    expect(deskLocationHref("/check-in", { event: "event_a" }, "loc_a")).toBe("/check-in?event=event_a&location=loc_a");
    expect(deskLocationHref("/check-in", { event: "event_a", location: "old" }, "loc_b")).toBe("/check-in?event=event_a&location=loc_b");
  });

  it("marks inactive locations", () => {
    expect(deskLocationLabel(locations[0])).toBe("Sunnydale Academy");
    expect(deskLocationLabel(locations[1])).toBe("Old Campus (inactive)");
  });

  it("is a GET form that works without scripts: event kept, a visible Apply button", () => {
    const markup = render("loc_a");
    expect(markup).toContain('method="get"');
    expect(markup).toContain('action="/check-in"');
    expect(markup).toContain('name="event"');
    expect(markup).toContain('value="event_a"');
    expect(markup).toContain(">Apply</button>");
    expect(markup).not.toContain("desk-location-go-hidden");
    expect(markup).toContain("Desk location");
  });

  it("lists All locations then each location, preselecting the chosen one", () => {
    const markup = render("loc_a");
    expect(markup.indexOf("All locations")).toBeLessThan(markup.indexOf("Sunnydale Academy"));
    expect(markup).toMatch(/<option value="loc_a"[^>]*selected/);
    expect(markup).toContain("Old Campus (inactive)");
    expect(render(null)).toMatch(/<option value=""[^>]*selected/);
  });

  it("renders nothing for an event with no locations", () => {
    expect(render(null, [])).toBe("");
  });

  it("treats arrow, paging and letter keys as steps that do not navigate, but not Enter", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown", "s"]) expect(isSelectStepKey(key)).toBe(true);
    for (const key of ["Enter", "Tab", "Escape"]) expect(isSelectStepKey(key)).toBe(false);
  });
});
