import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AreaClubsOverview, AreaMonthlyReportsTable, AreaPointsChart } from "@/components/area-clubs-views";
import { cardCell, isLongCardLabel } from "@/components/table-card-labels";
import type { AreaClubSummary } from "@/modules/club-reports/area-summary-domain";

const club: AreaClubSummary = {
  id: "club_1",
  name: "Sample Trailblazers Pathfinder Club",
  church: "Sample Hills Church",
  directors: ["Pat Sample"],
  rosterSize: 12,
  registrationOnTime: true,
  backgroundChecks: { missing: 1, notInCompliance: 0, expiringSoon: 2 },
  months: [
    { month: "2026-09", status: "SUBMITTED", points: 81 },
    { month: "2026-10", status: "LATE", points: 70 },
    { month: "2026-11", status: "MISSING", points: null },
  ],
  submitted: 2,
  late: 1,
  drafts: 0,
  missing: 1,
  lastReportMonth: "2026-10",
  reportPoints: 151,
  totalPoints: 161,
};
const links = { clubHref: (id: string) => `/c/${id}`, reportHref: (id: string, month: string) => `/c/${id}/${month}` };

/** Every attribute-bearing <td>/<th> tag of the rendered table, in order. */
function cells(html: string) {
  return [...html.matchAll(/<(td|th)\b([^>]*)>/g)].map((match) => ({ tag: match[1], attrs: match[2] }));
}
const label = (attrs: string) => /data-label="([^"]*)"/.exec(attrs)?.[1] ?? null;

describe("phone table cards render their labels and roles on the server (#686)", () => {
  it("labels every body cell of the area overview and flags long labels", () => {
    const html = renderToStaticMarkup(createElement(AreaClubsOverview, { clubs: [club], clubYear: "2026-27", links }));
    expect(html).toContain('class="report-table table-cards"');
    expect(html).toContain('role="table"');
    const body = cells(html).filter((cell) => !cell.attrs.includes('scope="col"'));
    expect(body[0]).toMatchObject({ tag: "th" });
    expect(body[0]!.attrs).toContain('role="rowheader"');
    expect(body[0]!.attrs).not.toContain("data-label");
    expect(body.slice(1).map((cell) => label(cell.attrs))).toEqual([
      "Director", "Church", "Roster", "Reports submitted", "Total points", "Last report", "Sterling Volunteers",
    ]);
    const long = body.filter((cell) => cell.attrs.includes("data-label-long")).map((cell) => label(cell.attrs));
    expect(long).toEqual(["Reports submitted", "Sterling Volunteers"]);
    // Column headers keep their roles even though the stacked layout hides them.
    expect(html.match(/role="columnheader"/g)).toHaveLength(8);
  });

  it("labels the month cells of the monthly grid by month", () => {
    const html = renderToStaticMarkup(createElement(AreaMonthlyReportsTable, { clubs: [club], clubYear: "2026-27", links }));
    const labels = cells(html).filter((cell) => cell.tag === "td").map((cell) => label(cell.attrs));
    expect(labels).toEqual(["Sep", "Oct", "Nov", "Submitted", "Draft", "Missing", "Total points"]);
    expect(html).toContain('role="rowgroup"');
    expect(html).toContain('role="row"');
  });

  it("labels the points table, where the row header follows the Rank cell", () => {
    const html = renderToStaticMarkup(createElement(AreaPointsChart, { clubs: [club], clubYear: "2026-27", sort: "points", basePath: "/x" }));
    const tableHtml = html.slice(html.indexOf("<table"));
    const body = cells(tableHtml).filter((cell) => !cell.attrs.includes('scope="col"'));
    expect(body.map((cell) => label(cell.attrs))).toEqual([
      "Rank", null, "Report points", "Yearly registration", "Total points",
    ]);
    expect(body[1]).toMatchObject({ tag: "th" });
    expect(body.filter((cell) => cell.attrs.includes("data-label-long")).map((cell) => label(cell.attrs))).toEqual(["Yearly registration"]);
  });
});

describe("card cell helpers", () => {
  it("cardCell gives the role always, the label when present and the long flag by length", () => {
    expect(cardCell(null)).toEqual({ role: "cell" });
    expect(cardCell("Church")).toEqual({ role: "cell", "data-label": "Church" });
    expect(cardCell("Sterling Volunteers")).toEqual({ role: "cell", "data-label": "Sterling Volunteers", "data-label-long": "" });
    expect(isLongCardLabel("Church")).toBe(false);
  });
});
