import { describe, expect, it } from "vitest";
import { clubPortalNavItems, clubReporterNavItems } from "@/modules/club-rosters/portal-nav";
import { clubCapabilities } from "@/modules/organizations/director-grants-domain";

/** The club portal menu (#644): renamed, combined and grouped, with the same destinations per role as before. Synthetic ids only. */

const base = "/account/clubs/club-1";
type Role = Parameters<typeof clubCapabilities>[0];
const nav = (role: Role) => clubPortalNavItems({ base, role, capabilities: clubCapabilities(role) });
const hrefs = (role: Role) => nav(role).map((item) => item.href.replace(base, "") || "/");

describe("club portal menu (#644)", () => {
  it("groups a director's menu People / Events / Records / Orders / Club", () => {
    const items = nav("DIRECTOR");
    expect(items.map((item) => `${item.group ?? "-"}:${item.label}`)).toEqual([
      "-:Home",
      "People:Roster", "People:Honors", "People:Class tracking",
      "Events:Events", "Events:Forms",
      "Records:Monthly Records",
      "Orders:Orders",
      "Club:Club info",
    ]);
    expect(items.find((item) => item.label === "Class tracking")?.href).toBe(`${base}/class-tracking`);
    expect(items.find((item) => item.label === "Club info")?.href).toBe(`${base}/club-info`);
  });

  it("no longer uses the old labels", () => {
    const labels = nav("DIRECTOR").map((item) => item.label);
    for (const old of ["Events & classes", "Earned awards", "Club admins", "Club profile", "Club home"]) expect(labels).not.toContain(old);
  });

  it("gives each role exactly the destinations it had before, with Club info standing for team and profile", () => {
    const everything = ["/", "/roster", "/honors", "/class-tracking", "/events", "/forms", "/records", "/orders", "/club-info"];
    expect(hrefs("DIRECTOR")).toEqual(everything);
    expect(hrefs("DEPUTY")).toEqual(everything);
    // A registrar: no forms, no notes or reports, no club info.
    expect(hrefs("REGISTRAR")).toEqual(["/", "/roster", "/honors", "/class-tracking", "/events", "/orders"]);
  });

  it("has one Monthly Records item and no separate notes or reports items (#653)", () => {
    const labels = nav("DIRECTOR").map((item) => item.label);
    expect(labels).toContain("Monthly Records");
    expect(labels).not.toContain("Meeting notes");
    expect(labels).not.toContain("Monthly reports");
  });

  it("has no People heading and no Honors & class reports item (#701)", () => {
    for (const role of ["DIRECTOR", "DEPUTY", "REGISTRAR"] as const) {
      const items = nav(role);
      expect(items.find((item) => item.label === "Honors & class reports")).toBeUndefined();
      expect(items.some((item) => item.href === `${base}/exports`)).toBe(false);
      for (const item of items.filter((entry) => entry.group === "People")) expect(item.hideGroupLabel).toBe(true);
    }
  });

  it("hides groups with no visible items for a registrar", () => {
    const groups = new Set(nav("REGISTRAR").map((item) => item.group));
    expect(groups.has("Club")).toBe(false);
    expect(groups.has("Orders")).toBe(true);
  });

  it("gives a reporter without roster access Home plus Monthly Records", () => {
    const items = clubReporterNavItems({ base, capabilities: clubCapabilities("REPORTER") });
    expect(items.map((item) => item.href.replace(base, "") || "/")).toEqual(["/", "/records"]);
    expect(items.map((item) => item.label)).toEqual(["Home", "Monthly Records"]);
  });
});
