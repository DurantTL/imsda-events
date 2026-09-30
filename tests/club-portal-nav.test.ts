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
      "People:Roster", "People:Honors", "People:Class tracking", "People:Honors & class reports",
      "Events:Events", "Events:Forms",
      "Records:Meeting notes", "Records:Monthly reports",
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
    const everything = ["/", "/roster", "/honors", "/class-tracking", "/exports", "/events", "/forms", "/notes", "/reports", "/orders", "/club-info"];
    expect(hrefs("DIRECTOR")).toEqual(everything);
    expect(hrefs("DEPUTY")).toEqual(everything);
    // A registrar: no forms, no notes or reports, no club info.
    expect(hrefs("REGISTRAR")).toEqual(["/", "/roster", "/honors", "/class-tracking", "/exports", "/events", "/orders"]);
  });

  it("hides groups with no visible items for a registrar", () => {
    const groups = new Set(nav("REGISTRAR").map((item) => item.group));
    expect(groups.has("Club")).toBe(false);
    expect(groups.has("Orders")).toBe(true);
  });

  it("gives a reporter without roster access Home plus the two report screens", () => {
    const items = clubReporterNavItems({ base, capabilities: clubCapabilities("REPORTER") });
    expect(items.map((item) => item.href.replace(base, "") || "/")).toEqual(["/", "/notes", "/reports"]);
    expect(items.map((item) => item.label)).toEqual(["Home", "Meeting notes", "Monthly reports"]);
  });
});
