import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => createElement("a", { href }, children),
}));

import { HonorsSetupWorkspace } from "@/components/honors-setup-workspace";
import { ClubClassPicker } from "@/components/club-class-picker";
import {
  compareHonorSessions,
  emptySessionWarning,
  sortHonorSessions,
} from "@/modules/honors/session-order";

const globalsCss = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

// Synthetic data only.
const morning = { id: "s-morning", name: "Sabbath Morning", sortOrder: 0, createdAt: new Date("2026-10-01T10:00:00Z") };
const afternoon = { id: "s-afternoon", name: "Sabbath Afternoon", sortOrder: 0, createdAt: new Date("2026-10-01T11:00:00Z") };

describe("honors session order (#570 F-10)", () => {
  it("orders by the saved sortOrder first", () => {
    const later = { ...morning, sortOrder: 2 };
    const earlier = { ...afternoon, sortOrder: 1 };
    expect(sortHonorSessions([later, earlier]).map((s) => s.id)).toEqual(["s-afternoon", "s-morning"]);
  });

  it("keeps creation order for equal sortOrder instead of falling back to the name", () => {
    // Alphabetically "Sabbath Afternoon" < "Sabbath Morning"; the admin added Morning first.
    expect(sortHonorSessions([afternoon, morning]).map((s) => s.name)).toEqual(["Sabbath Morning", "Sabbath Afternoon"]);
    expect(compareHonorSessions(morning, afternoon)).toBeLessThan(0);
  });

  it("is stable when nothing separates two sessions and does not mutate its input", () => {
    const input = [{ sortOrder: 1, name: "b" }, { sortOrder: 1, name: "a" }];
    expect(sortHonorSessions(input).map((s) => s.name)).toEqual(["b", "a"]);
    expect(input.map((s) => s.name)).toEqual(["b", "a"]);
  });

  it("renders the admin setup page sessions in saved order", () => {
    const html = renderToStaticMarkup(createElement(HonorsSetupWorkspace, {
      catalog: [],
      eventId: "evt_1",
      eventName: "Synthetic Honors Weekend",
      otherEvents: [],
      initialSetup: {
        sessions: [
          { id: "s2", name: "Sabbath Afternoon", sortOrder: 2, offeringCount: 1 },
          { id: "s1", name: "Sabbath Morning", sortOrder: 1, offeringCount: 1 },
        ],
        offerings: [],
      },
    }));
    expect(html.indexOf("Sabbath Morning")).toBeGreaterThan(-1);
    expect(html.indexOf("Sabbath Morning")).toBeLessThan(html.indexOf("Sabbath Afternoon"));
  });

  it("renders the director picker sessions in saved order", () => {
    const html = renderToStaticMarkup(createElement(ClubClassPicker, {
      organizationId: "org_1",
      eventId: "evt_1",
      initialWorkspace: {
        open: true,
        registrationClosesOn: null,
        sessions: [
          { id: "s2", name: "Sabbath Afternoon", sortOrder: 2 },
          { id: "s1", name: "Sabbath Morning", sortOrder: 1 },
        ],
        attendees: [{
          id: "a1", firstName: "Sam", lastName: "Sample", attendeeType: "YOUTH", consumesSeat: true, ageOnEventDate: 12,
        }],
        offerings: [{ id: "o2", honorName: "Synthetic Honor", honorCode: "ZZ", span: "SINGLE_SESSION", sessionId: "s2", sessionName: null, sessionOrder: 0, capacity: 5, minimumAge: null, perClubLimit: null, teacherName: "", location: "", isActive: true, seatsTaken: 0, clubSeatsTaken: 0 }, { id: "o1", honorName: "Synthetic Honor", honorCode: "ZZ", span: "SINGLE_SESSION", sessionId: "s1", sessionName: null, sessionOrder: 0, capacity: 5, minimumAge: null, perClubLimit: null, teacherName: "", location: "", isActive: true, seatsTaken: 0, clubSeatsTaken: 0 }],
        selections: {},
      },
    } as never));
    expect(html.indexOf("Sabbath Morning")).toBeGreaterThan(-1);
    expect(html.indexOf("Sabbath Morning")).toBeLessThan(html.indexOf("Sabbath Afternoon"));
  });
});

describe("honors admin empty-session warning (#570 F-25)", () => {
  const setup = (offeringCount: number) => ({
    sessions: [{ id: "s1", name: "Sunday", sortOrder: 0, offeringCount }],
    offerings: [],
  });
  const render = (offeringCount: number) => renderToStaticMarkup(createElement(HonorsSetupWorkspace, {
    catalog: [], eventId: "evt_1", eventName: "Synthetic Honors Weekend", otherEvents: [], initialSetup: setup(offeringCount),
  }));

  it("uses the exact requested wording", () => {
    expect(emptySessionWarning).toBe("No classes yet — this session will be hidden from directors until you add one.");
  });

  it("warns on a session with no classes and only then", () => {
    expect(render(0)).toContain(emptySessionWarning);
    expect(render(3)).not.toContain(emptySessionWarning);
  });
});

describe("mobile width guards (#570 F-11, F-12)", () => {
  it("lets the registration layout track shrink below its content at phone widths", () => {
    // A bare `1fr` track has an automatic minimum and grew with a long word.
    const mobile = globalsCss.slice(globalsCss.indexOf("@media (max-width: 900px) {\n  .public-registration-hero"));
    expect(mobile).toMatch(/\.public-registration-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(mobile.slice(0, mobile.indexOf("\n}"))).not.toMatch(/\.public-registration-layout,/);
  });

  it("constrains the registration intro and progress tracker", () => {
    expect(globalsCss).toMatch(/\.public-registration-intro \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere/);
    expect(globalsCss).toMatch(/\.public-registration-progress \{[^}]*min-width: 0;[^}]*max-width: 100%/);
  });

  it("keeps the current step readable in the compact tracker", () => {
    expect(globalsCss).toMatch(/\.public-registration-progress li\.is-current \{ flex-grow: 2\.5; \}/);
  });

  it("positions the honors table scroller so its hidden Actions header cannot widen the page", () => {
    expect(globalsCss).toMatch(/\.honor-table-wrap \{[^}]*position: relative/);
    const component = readFileSync(path.join(process.cwd(), "components/honors-setup-workspace.tsx"), "utf8");
    expect(component).toContain("report-table-wrap honor-table-wrap");
  });
});
