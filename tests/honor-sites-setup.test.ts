import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => createElement("a", { href }, children),
}));

import { ClubClassPicker } from "@/components/club-class-picker";
import { HonorsSetupWorkspace } from "@/components/honors-setup-workspace";
import { formTemplates } from "@/modules/forms/definition";
import type { ClassSelectionWorkspace } from "@/modules/honors/enrollment-repository";
import type { EventHonorSetup } from "@/modules/honors/repository";

// Synthetic data only.
const at = new Date("2026-10-01T09:00:00Z");
const session = (id: string, name: string, locationId: string | null, sortOrder: number) => ({
  id, name, locationId, sortOrder, createdAt: at, offeringCount: 1, activeOfferingCount: 1,
});

function setup(overrides: Partial<EventHonorSetup> = {}): EventHonorSetup {
  return {
    locations: [
      { id: "loc-kc", name: "Kansas City Multicultural", sortOrder: 2, isActive: true },
      { id: "loc-dm", name: "Des Moines", sortOrder: 1, isActive: true },
    ],
    sessions: [
      session("s-kc", "Sabbath Morning", "loc-kc", 0),
      session("s-dm-2", "Sabbath Afternoon", "loc-dm", 1),
      session("s-dm-1", "Sabbath Morning", "loc-dm", 0),
    ],
    offerings: [],
    ...overrides,
  };
}

const render = (initialSetup: EventHonorSetup) => renderToStaticMarkup(createElement(HonorsSetupWorkspace, {
  catalog: [], eventId: "evt_1", eventName: "Synthetic Honors Weekend", otherEvents: [], initialSetup,
}));

describe("honors setup at sites (#589)", () => {
  it("groups sessions by site in the location's order, with each site's own session order", () => {
    const html = render(setup());
    const desMoines = html.indexOf("Des Moines</span></h3>");
    const kansasCity = html.indexOf("Kansas City Multicultural</span></h3>");
    expect(desMoines).toBeGreaterThan(-1);
    expect(desMoines).toBeLessThan(kansasCity);
    // Inside Des Moines, order 0 comes before order 1.
    const morning = html.indexOf("Sabbath Morning", desMoines);
    expect(morning).toBeGreaterThan(desMoines);
    expect(morning).toBeLessThan(html.indexOf("Sabbath Afternoon", desMoines));
    // Both sites keep a "Sabbath Morning".
    expect(html.match(/<strong>Sabbath Morning<\/strong>/g)).toHaveLength(2);
  });

  it("gives each session and the new-session form a site picker", () => {
    const html = render(setup());
    expect(html).toContain("Site for Sabbath Morning");
    // With active sites, a new session must name one.
    expect(html).toContain("Choose a site");
    expect(html).toContain("Site for Sabbath Morning");
    expect(html).toContain('value="loc-dm"');
  });

  it("looks exactly as before for an event without locations", () => {
    const html = render(setup({ locations: [], sessions: [session("s1", "Sunday", null, 0)] }));
    expect(html).not.toContain("Site for");
    expect(html).not.toContain("No site");
    expect(html).toContain("<strong>Sunday</strong>");
  });
});

describe("the class picker before a location is chosen (#589)", () => {
  it("says to choose a location first", () => {
    const workspace = {
      open: true, registrationClosesOn: null, location: null, locationRequired: true, locationMessage: "Choose your location first.",
      sessions: [], attendees: [], offerings: [], selections: {},
    } as unknown as ClassSelectionWorkspace;
    const html = renderToStaticMarkup(createElement(ClubClassPicker, { initialWorkspace: workspace, organizationId: "club-1", eventId: "evt_1" }));
    expect(html).toContain("Choose your location first.");
    expect(html).not.toContain("Save classes");
  });
});

describe("Honors Weekend template wording (#589)", () => {
  it("no longer tells staff to create one event per site", () => {
    const template = formTemplates.find((candidate) => candidate.key === "honors_weekend")!;
    expect(template.description).not.toMatch(/one event per site/i);
    expect(template.description).toContain("Event settings → Locations");
  });
});

describe("the sessions migration (#589)", () => {
  const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20260929191000_honor_session_locations/migration.sql"), "utf8");

  it("is additive: one nullable column, no dropped table or column", () => {
    expect(sql).toContain('ALTER TABLE "HonorSession" ADD COLUMN     "locationId" TEXT;');
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)|ADD COLUMN[^;]*NOT NULL/i);
  });

  it("replaces the event-wide name key with one per site, keeping today's rule for sessions with no site", () => {
    expect(sql).toContain('DROP INDEX "HonorSession_eventId_normalizedName_key";');
    expect(sql).toMatch(/UNIQUE INDEX "HonorSession_eventId_normalizedName_no_location_key"\s+ON "HonorSession"\("eventId", "normalizedName"\) WHERE "locationId" IS NULL/);
    expect(sql).toMatch(/UNIQUE INDEX "HonorSession_eventId_locationId_normalizedName_key"\s+ON "HonorSession"\("eventId", "locationId", "normalizedName"\) WHERE "locationId" IS NOT NULL/);
  });
});

describe("the offering sites migration (#589)", () => {
  const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20260929191100_honor_offering_locations/migration.sql"), "utf8");

  it("is additive: one nullable column, no dropped table or column", () => {
    expect(sql).toContain('ALTER TABLE "HonorOffering" ADD COLUMN     "locationId" TEXT;');
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)|ADD COLUMN[^;]*NOT NULL/i);
  });

  it("limits the column to all-sessions classes and makes their uniqueness per site", () => {
    expect(sql).toMatch(/CHECK \("locationId" IS NULL OR "span" = 'ALL_SESSIONS'\)/);
    expect(sql).toContain('DROP INDEX "HonorOffering_eventId_honorId_all_sessions_key";');
    expect(sql).toMatch(/"HonorOffering"\("eventId", "honorId"\) WHERE "sessionId" IS NULL AND "locationId" IS NULL/);
    expect(sql).toMatch(/"HonorOffering"\("eventId", "honorId", "locationId"\) WHERE "sessionId" IS NULL AND "locationId" IS NOT NULL/);
  });
});
