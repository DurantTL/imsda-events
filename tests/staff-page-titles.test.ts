import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mobileNavigationLabels,
  mobileNavigationOrder,
  navigation,
  staffPageTitles,
  staffSubpageTitle,
} from "@/components/staff-navigation";

const root = join(__dirname, "..");
const pageFile = (path: string) => join(root, "app/(workspace)", path, "page.tsx");

describe("staff page names (#685)", () => {
  it("uses one name per section in the navigation", () => {
    const labelByHref = Object.fromEntries(navigation.map((item) => [item.href, item.label]));
    expect(labelByHref["/overview"]).toBe("Dashboard");
    expect(labelByHref["/people"]).toBe("Registrations");
    expect(labelByHref["/finance"]).toBe("Payments");
    expect(labelByHref["/more/promo-codes"]).toBe("Promo codes");
    expect(labelByHref["/registration-builder"]).toBe("Registration form");
  });

  it("keeps five phone tabs with short labels while the sidebar keeps full labels (#711)", () => {
    expect([...mobileNavigationOrder]).toEqual(["/overview", "/people", "/check-in", "/communications", "/more"]);
    expect(mobileNavigationOrder.map((href) => mobileNavigationLabels[href])).toEqual(["Home", "People", "Check-in", "Emails", "More"]);
    for (const href of mobileNavigationOrder) {
      expect(navigation.find((item) => item.href === href)?.label).toBeTruthy();
    }
    expect(navigation.find((item) => item.href === "/overview")?.label).toBe("Dashboard");
    expect(navigation.find((item) => item.href === "/people")?.label).toBe("Registrations");
    expect(navigation.every((item) => !("mobileLabel" in item))).toBe(true);
  });

  it("names /more/* pages that are not nav items instead of 'More'", () => {
    expect(staffSubpageTitle("/more/honors")).toBe("Honors Weekend classes");
    expect(staffSubpageTitle("/more/honors/rosters")).toBe("Honors Weekend rosters");
    expect(staffSubpageTitle("/more/reports")).toBe("Operational reports");
    expect(staffSubpageTitle("/more/reports/clubs")).toBe("Camporee club reports");
    expect(staffSubpageTitle("/more/reports/clubs/check-in-book")).toBe("Check-in book");
    expect(staffSubpageTitle("/more/reports/clubs/packet/org_1")).toBe("Club packet");
    expect(staffSubpageTitle("/more/reports/packets")).toBe("Grouped retreat packets");
    expect(staffSubpageTitle("/more/clubs")).toBe("Clubs");
    expect(staffSubpageTitle("/more/clubs/org_1")).toBe("Club");
    expect(staffSubpageTitle("/more/clubs/reports")).toBe("Club monthly reports");
    expect(staffSubpageTitle("/more/clubs/reports/org_1/2028-08")).toBe("Club monthly report");
    expect(staffSubpageTitle("/more/club-forms")).toBe("Club forms");
    expect(staffSubpageTitle("/more/club-forms/sub_1")).toBe("Club form");
    expect(staffSubpageTitle("/more/merchandise")).toBe("Merchandise catalog");
    expect(staffSubpageTitle("/more/program-assignments/run_1")).toBe("Assignment roster");
    expect(staffSubpageTitle("/more")).toBeNull();
    expect(staffSubpageTitle("/people")).toBeNull();
  });

  it("has every page's <title> read the shared constant", () => {
    const pages: Record<string, string> = {
      overview: "overview", registrations: "people", payments: "finance", registrationForm: "registration-builder",
      emails: "communications", team: "staff", imports: "imports", systemManagement: "admin", checkIn: "check-in",
      more: "more", honors: "more/honors", honorsRosters: "more/honors/rosters", promoCodes: "more/promo-codes",
      attendeeSetup: "more/attendee-configuration", tags: "more/tags", eventSettings: "more/event-settings",
      clubPacket: "more/reports/clubs/packet/[organizationId]", checkInBook: "more/reports/clubs/check-in-book",
      clubReports: "more/reports/clubs", groupedPackets: "more/reports/packets", operationalReports: "more/reports",
      clubMonthlyReport: "more/clubs/reports/[organizationId]/[month]", clubMonthlyReports: "more/clubs/reports",
      clubs: "more/clubs", club: "more/clubs/[organizationId]", clubForm: "more/club-forms/[submissionId]",
      clubForms: "more/club-forms", eventHealth: "more/event-health", clubAssignments: "more/club-assignments", eventContent: "more/event-content",
      eventPatches: "more/event-patches", operationalHealth: "more/health", merchandise: "more/merchandise",
      assignmentRoster: "more/program-assignments/[runId]", programAssignments: "more/program-assignments",
    };
    expect(Object.keys(pages).sort()).toEqual(Object.keys(staffPageTitles).sort());
    for (const [key, path] of Object.entries(pages)) {
      const file = pageFile(path);
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, "utf8"), file).toContain(`title: staffPageTitles.${key}`);
    }
  });
});
