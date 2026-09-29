import { describe, expect, it } from "vitest";
import {
  calendarDayDifference,
  effectiveLocationDates,
  eventLocationInputSchema,
  eventLocationOrderSchema,
  eventLocationUpdateSchema,
  evaluateLocationPhase,
  hasLocationEnded,
  locationDateProblem,
  locationFullMessage,
  locationHasRoom,
  locationLifecycleSource,
  normalizeLocationName,
  remainingLocationSeats,
  shiftCalendarDate,
  shiftLocationsForClone,
} from "@/modules/event-locations/domain";
import { churchAmountsOwedCsvRows } from "@/modules/club-registrations/church-owed";
import { clubRegistrationEditWindow } from "@/modules/club-registrations/domain";
import { evaluateEventRegistrationPhase, hasEventEnded } from "@/modules/events/lifecycle";
import { campingReportCsv, buildCampingReport, withLocationColumn, type ClubEventRecord } from "@/modules/reporting/club-event-reports";

/**
 * Locations inside one event (#413): pure rules. Synthetic data only.
 * The event runs Dec 5 to Dec 6, 2026 (Central time) and closes registration
 * on Nov 30.
 */

const event = {
  isPublished: true,
  timezone: "America/Chicago",
  registrationOpensOn: "2026-10-01",
  registrationClosesOn: "2026-11-30",
  waitlistEnabled: false,
  startsAt: new Date("2026-12-05T15:00:00Z"),
  endsAt: new Date("2026-12-06T22:00:00Z"),
};
const noDates = { firstDay: null, lastDay: null, registrationClosesOn: null };

describe("location names and input", () => {
  it("normalizes case, spacing and width so a name is unique per event ignoring case", () => {
    expect(normalizeLocationName("  Camp   Heritage 1 ")).toBe("camp heritage 1");
    expect(normalizeLocationName("CAMP HERITAGE 1")).toBe(normalizeLocationName("camp heritage 1"));
    expect(normalizeLocationName("Ｄｅｓ Moines")).toBe("des moines");
  });

  it("accepts a bare name and fills the optional fields with null", () => {
    expect(eventLocationInputSchema.parse({ name: " Des Moines " })).toEqual({
      name: "Des Moines", address: null, firstDay: null, lastDay: null, capacity: null, registrationClosesOn: null, isActive: true,
    });
  });

  it("refuses a blank name, a zero capacity, an impossible date, and a last day before the first", () => {
    expect(eventLocationInputSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(eventLocationInputSchema.safeParse({ name: "A", capacity: 0 }).success).toBe(false);
    expect(eventLocationInputSchema.safeParse({ name: "A", firstDay: "2026-02-30" }).success).toBe(false);
    const backwards = eventLocationInputSchema.safeParse({ name: "A", firstDay: "2026-12-06", lastDay: "2026-12-05" });
    expect(backwards.success).toBe(false);
    expect(eventLocationInputSchema.safeParse({ name: "A", lastDay: "2026-12-05", registrationClosesOn: "2026-12-06" }).success).toBe(false);
    expect(eventLocationInputSchema.safeParse({ name: "A", unknown: 1 }).success).toBe(false);
  });

  it("checks dates from the merged values of a partial edit", () => {
    expect(locationDateProblem({ firstDay: "2026-12-06", lastDay: "2026-12-05", registrationClosesOn: null })?.path).toBe("lastDay");
    expect(locationDateProblem({ firstDay: null, lastDay: "2026-12-05", registrationClosesOn: "2026-12-06" })?.path).toBe("registrationClosesOn");
    expect(locationDateProblem({ firstDay: "2026-12-05", lastDay: "2026-12-06", registrationClosesOn: "2026-12-01" })).toBeNull();
    expect(eventLocationUpdateSchema.safeParse({}).success).toBe(false);
    expect(eventLocationUpdateSchema.parse({ isActive: false, capacity: null })).toEqual({ isActive: false, capacity: null });
  });

  it("requires a reorder to name each location once", () => {
    expect(eventLocationOrderSchema.safeParse({ orderedIds: ["a", "b"] }).success).toBe(true);
    expect(eventLocationOrderSchema.safeParse({ orderedIds: ["a", "a"] }).success).toBe(false);
  });
});

describe("per-location dates (#575 and #366 applied to the location)", () => {
  it("uses the event's own dates when the location sets none", () => {
    expect(effectiveLocationDates(event, noDates)).toEqual({ firstDay: "2026-12-05", lastDay: "2026-12-06", registrationClosesOn: "2026-11-30" });
    expect(effectiveLocationDates(event, null)).toEqual({ firstDay: "2026-12-05", lastDay: "2026-12-06", registrationClosesOn: "2026-11-30" });
    expect(locationLifecycleSource(event, noDates)).toMatchObject({ registrationClosesOn: "2026-11-30", lastDay: null });
  });

  it("behaves exactly like the event when there is no location", () => {
    for (const now of ["2026-09-30", "2026-10-15", "2026-11-30", "2026-12-01", "2026-12-06", "2026-12-07"]) {
      const at = new Date(`${now}T18:00:00Z`);
      expect(evaluateLocationPhase(event, null, at)).toBe(evaluateEventRegistrationPhase(event, at));
      expect(evaluateLocationPhase(event, noDates, at)).toBe(evaluateEventRegistrationPhase(event, at));
      expect(hasLocationEnded(event, null, at)).toBe(hasEventEnded(event, at));
    }
  });

  it("closes one location on its own closing date while another stays open", () => {
    const early = { firstDay: null, lastDay: null, registrationClosesOn: "2026-10-10" };
    const at = new Date("2026-10-15T18:00:00Z");
    expect(evaluateLocationPhase(event, early, at)).toBe("CLOSED");
    expect(evaluateLocationPhase(event, noDates, at)).toBe("OPEN");
    expect(evaluateLocationPhase(event, early, new Date("2026-10-10T18:00:00Z"))).toBe("OPEN");
  });

  it("closes a location after its own last day (#575), even when the event's closing date is later", () => {
    const short = { firstDay: "2026-11-20", lastDay: "2026-11-21", registrationClosesOn: null };
    expect(evaluateLocationPhase(event, short, new Date("2026-11-21T20:00:00Z"))).toBe("OPEN");
    expect(evaluateLocationPhase(event, short, new Date("2026-11-22T20:00:00Z"))).toBe("CLOSED");
    expect(hasLocationEnded(event, short, new Date("2026-11-22T20:00:00Z"))).toBe(true);
    expect(hasLocationEnded(event, short, new Date("2026-11-21T20:00:00Z"))).toBe(false);
  });

  it("lets a location run later than the event", () => {
    const late = { firstDay: "2026-12-19", lastDay: "2026-12-20", registrationClosesOn: "2026-12-15" };
    const afterEvent = new Date("2026-12-10T18:00:00Z");
    expect(evaluateEventRegistrationPhase(event, afterEvent)).toBe("CLOSED");
    expect(evaluateLocationPhase(event, late, afterEvent)).toBe("OPEN");
    expect(evaluateLocationPhase(event, late, new Date("2026-12-16T18:00:00Z"))).toBe("CLOSED");
    expect(evaluateLocationPhase(event, late, new Date("2026-12-21T18:00:00Z"))).toBe("CLOSED");
    expect(hasLocationEnded(event, late, new Date("2026-12-21T18:00:00Z"))).toBe(true);
  });

  it("still honors the event's opening date and publication for a location with dates", () => {
    const own = { firstDay: null, lastDay: null, registrationClosesOn: "2026-12-15" };
    expect(evaluateLocationPhase(event, own, new Date("2026-09-30T18:00:00Z"))).toBe("UPCOMING");
    expect(evaluateLocationPhase({ ...event, isPublished: false }, own, new Date("2026-10-15T18:00:00Z"))).toBe("DRAFT");
  });

  it("gives the director edit window of the location's own dates", () => {
    const early = { firstDay: null, lastDay: null, registrationClosesOn: "2026-10-10" };
    const window = (location: typeof early | typeof noDates, today: string) => {
      const dates = effectiveLocationDates(event, location);
      return clubRegistrationEditWindow({
        phase: evaluateLocationPhase(event, location, new Date(`${today}T18:00:00Z`)),
        registrationClosesOn: dates.registrationClosesOn,
        today,
        eventDate: dates.firstDay,
        ended: hasLocationEnded(event, location, new Date(`${today}T18:00:00Z`)),
      });
    };
    expect(window(early, "2026-10-15")).toMatchObject({ open: false });
    expect(window(noDates, "2026-10-15")).toEqual({ open: true });
    const closed = window(early, "2026-10-15");
    expect(closed.open === false && closed.message).toContain("October 10, 2026");
  });
});

describe("per-location capacity counts people like the event capacity", () => {
  it("has room up to and including the capacity, and never for more", () => {
    expect(locationHasRoom(3, 1, 2)).toBe(true);
    expect(locationHasRoom(3, 2, 2)).toBe(false);
    expect(locationHasRoom(3, 3, 0)).toBe(true);
    expect(locationHasRoom(null, 10_000, 500)).toBe(true);
  });

  it("reports what is left, never below zero, and null for no limit", () => {
    expect(remainingLocationSeats(3, 1)).toBe(2);
    expect(remainingLocationSeats(3, 5)).toBe(0);
    expect(remainingLocationSeats(null, 5)).toBeNull();
    expect(locationFullMessage("Des Moines", 0)).toBe("Des Moines is full.");
    expect(locationFullMessage("Des Moines", 1)).toBe("Only 1 spot remains at Des Moines.");
    expect(locationFullMessage("Des Moines", 2)).toBe("Only 2 spots remain at Des Moines.");
  });
});

describe("cloning shifts location dates like event dates", () => {
  it("moves dates by whole days, across month and year ends and leap days", () => {
    expect(shiftCalendarDate("2026-12-19", 364)).toBe("2027-12-18");
    expect(shiftCalendarDate("2027-12-30", 3)).toBe("2028-01-02");
    expect(shiftCalendarDate("2027-02-28", 366)).toBe("2028-02-29");
    expect(shiftCalendarDate("2026-12-05", -5)).toBe("2026-11-30");
    expect(calendarDayDifference("2026-12-05", "2027-12-04")).toBe(364);
    expect(calendarDayDifference("2027-12-04", "2026-12-05")).toBe(-364);
  });

  it("copies name, address, capacity and order, moves every date, and renumbers the order", () => {
    const shifted = shiftLocationsForClone([
      { name: "B", address: "2 Rd", capacity: 40, sortOrder: 7, firstDay: "2026-12-19", lastDay: "2026-12-20", registrationClosesOn: "2026-12-15" },
      { name: "A", address: null, capacity: null, sortOrder: 2, firstDay: null, lastDay: null, registrationClosesOn: null },
    ], 364);
    expect(shifted).toEqual([
      { name: "A", address: null, capacity: null, sortOrder: 0, firstDay: null, lastDay: null, registrationClosesOn: null },
      { name: "B", address: "2 Rd", capacity: 40, sortOrder: 1, firstDay: "2027-12-18", lastDay: "2027-12-19", registrationClosesOn: "2027-12-14" },
    ]);
  });
});

describe("staff exports name the location only when the event has one", () => {
  it("leaves a table alone when no row names a location, and inserts one column when any does", () => {
    const table: Array<Array<string | number>> = [["Club", "Confirmation", "Total"], ["A", "REG-1", 3], ["B", "REG-2", 4]];
    expect(withLocationColumn(table, [null, undefined], 2)).toBe(table);
    expect(withLocationColumn(table, ["Des Moines", null], 2)).toEqual([
      ["Club", "Confirmation", "Location", "Total"], ["A", "REG-1", "Des Moines", 3], ["B", "REG-2", "", 4],
    ]);
  });

  const record = (organizationName: string, locationName: string | null): ClubEventRecord => ({
    organizationId: organizationName, organizationName, sponsoringChurch: null, registrationId: `r-${organizationName}`, confirmationCode: `REG-${organizationName}`,
    status: "SUBMITTED", directorName: "", email: "", phone: "", submittedAt: null,
    camping: { tents: "", trailers: "", kitchenCanopy: "", totalSqft: "", campNextTo: "" },
    dutyAreas: [], flagSlots: [], bathroomDays: [], specialActivities: [], partnerClub: "", eventRibbons: "", sabbathSkit: "",
    sponsoringMeals: false, mealSponsorshipCount: "", mealTimes: [], baptismNames: "", bibleNames: "", attendees: [],
    amountOwedCents: 0, lateRateApplied: false, locationName,
  });

  it("adds a Location column to a club report only for an event with locations", () => {
    const withLocations = campingReportCsv(buildCampingReport([record("A", "Des Moines"), record("B", "Kansas City")]));
    const cells = (line: string) => line.split(",").map((cell) => cell.replaceAll('"', ""));
    const [header, first] = withLocations.split("\n").map(cells);
    expect(header!.slice(0, 5)).toEqual(["Club", "Sponsoring church", "Confirmation", "Location", "Tents"]);
    expect(first!.slice(0, 4)).toEqual(["A", "", "REG-A", "Des Moines"]);
    const without = campingReportCsv(buildCampingReport([record("A", null)]));
    expect(cells(without.split("\n")[0]!).slice(0, 4)).toEqual(["Club", "Sponsoring church", "Confirmation", "Tents"]);
    expect(cells(without.split("\n")[0]!)).not.toContain("Location");
  });

  it("adds a Location column to the church-owed export only for an event with locations", () => {
    const row = (organizationName: string, locationName?: string | null) => ({
      organizationId: organizationName, organizationName, churchId: "church-1", churchName: "Test Church", confirmationCode: `REG-${organizationName}`,
      status: "SUBMITTED" as const, attendeeCount: 2, isBilled: true, amountOwedCents: 5000, ...(locationName === undefined ? {} : { locationName }),
    });
    const plain = churchAmountsOwedCsvRows([row("A")]);
    expect(plain[0]).not.toContain("Location");
    const located = churchAmountsOwedCsvRows([row("A", "Des Moines"), row("B", null)]);
    expect(located[0]![2]).toBe("Location");
    expect(located.slice(1).map((line) => line[2])).toEqual(["Des Moines", ""]);
    expect(located[1]!.length).toBe(plain[1]!.length + 1);
  });
});

describe("location-specific wording (#413)", () => {
  const base = { registrationClosesOn: "2026-10-10", today: "2026-10-15", eventDate: "2026-12-05" };

  it("names the location instead of the whole event when its window is closed", () => {
    const named = (phase: "UPCOMING" | "CLOSED", ended = false) => clubRegistrationEditWindow({ ...base, phase, ended, locationName: "Des Moines" });
    expect(named("CLOSED")).toEqual({ open: false, message: "Registration for Des Moines closed after October 10, 2026. Contact the event team to add or remove someone." });
    expect(named("CLOSED", true)).toEqual({ open: false, message: "Registration for Des Moines has closed. Contact the event team to add or remove someone." });
    const upcoming = named("UPCOMING");
    expect(upcoming.open === false && upcoming.message).toContain("Registration for Des Moines isn't open");
  });

  it("keeps the event wording, unchanged, when there is no location", () => {
    const closed = clubRegistrationEditWindow({ ...base, phase: "CLOSED" });
    expect(closed).toEqual({ open: false, message: "Registration closed after October 10, 2026. Contact the event team to add or remove someone." });
    const ended = clubRegistrationEditWindow({ ...base, phase: "CLOSED", ended: true });
    expect(ended.open === false && ended.message).toContain("Registration for this event has closed.");
  });
});
