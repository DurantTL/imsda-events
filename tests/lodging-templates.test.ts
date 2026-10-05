import { describe, expect, it } from "vitest";
import { lodgingPropertyTemplates, seedCapacity, type LodgingUnitSeed } from "@/modules/lodging/templates";

const heritage = lodgingPropertyTemplates.find((template) => template.key === "camp-heritage")!;
const sunnydale = lodgingPropertyTemplates.find((template) => template.key === "sunnydale-academy")!;
const unitsOf = (template: typeof heritage, building?: string) =>
  template.buildings.filter((entry) => !building || entry.key === building).flatMap((entry) => entry.units);
const find = (template: typeof heritage, key: string) => unitsOf(template).find((unit) => unit.key === key)!;

describe("property templates", () => {
  it("are versioned code data with unique keys", () => {
    for (const template of lodgingPropertyTemplates) {
      expect(template.version).toBeGreaterThanOrEqual(1);
      const keys = unitsOf(template).map((unit) => unit.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(template.buildings.map((building) => building.key)).size).toBe(template.buildings.length);
    }
  });

  it("carry facility data only: no price, no person, no occupant name", () => {
    for (const template of lodgingPropertyTemplates) {
      for (const unit of unitsOf(template)) {
        expect(Object.keys(unit).filter((key) => /price|rate|cents|cost|person|guest|occupant|email/i.test(key))).toEqual([]);
        expect(unit.notes ?? "").not.toMatch(/@|\$\d/);
      }
    }
  });

  it("never lists Camp Heritage House and holds the cooks' and nurse's rooms by default", () => {
    expect(unitsOf(heritage).some((unit) => /house/i.test(unit.name))).toBe(false);
    const held = unitsOf(heritage).filter((unit) => unit.defaultHold).map((unit) => unit.key).sort();
    expect(held).toEqual(["lakeview-starlight", "lakeview-sunset", "medicine-nurses-room"]);
  });

  it("gives Camp Heritage the recorded capacities", () => {
    expect(seedCapacity(find(heritage, "wildlife-inn-moose"))).toBe(4);
    expect(seedCapacity(find(heritage, "lakeview-sunset"))).toBe(2);
    expect(seedCapacity(find(heritage, "four-seasons-winter"))).toBe(6);
    expect(seedCapacity(find(heritage, "forest-village-bear"))).toBe(10);
    expect(seedCapacity(find(heritage, "whippoorwill"))).toBe(10);
    expect(seedCapacity(find(heritage, "goldfinch"))).toBe(6);
    expect(unitsOf(heritage, "wildlife-inn")).toHaveLength(6);
    expect(unitsOf(heritage, "forest-village")).toHaveLength(6);
    expect(unitsOf(heritage, "mountain-village")).toHaveLength(6);
    const shady = unitsOf(heritage, "shady-oak-campground");
    expect(shady.map((unit) => [unit.isArea, seedCapacity(unit)])).toEqual([[true, 20], [true, 20]]);
  });

  it("matches the Man Camp check: 33 queens and bottom bunks in rooms with their own bathroom", () => {
    const own = ["wildlife-inn", "generals-quarters", "four-seasons-cabins", "medicine-lodge"]
      .flatMap((building) => unitsOf(heritage, building))
      .filter((unit) => unit.key !== "medicine-nurses-room");
    expect(own.reduce((total, unit) => total + (unit.beds ?? []).filter((bed) => bed === "QUEEN" || bed === "TWIN_BUNK").length, 0)).toBe(33);
  });

  it("gives Sunnydale the recorded rooms and sites", () => {
    const boys = unitsOf(sunnydale, "boys-dorm");
    expect(boys.filter((unit) => unit.assignable !== false)).toHaveLength(37);
    expect(boys.filter((unit) => unit.assignable === false).map((unit) => unit.key)).toEqual(["boys-106", "boys-107"]);
    expect(unitsOf(sunnydale, "girls-dorm")).toHaveLength(45);
    expect(["boys-120", "boys-121", "boys-122", "boys-123"].every((key) => find(sunnydale, key).floor === 1)).toBe(true);
    expect(unitsOf(sunnydale, "girls-dorm").filter((unit) => unit.floor === 1).map((unit) => unit.name)).toEqual(["101", "102", "103", "104", "105", "106", "107", "108"]);
    expect(unitsOf(sunnydale, "rv-sites")).toHaveLength(18);
    expect(unitsOf(sunnydale, "rv-sites").every((unit) => unit.kind === "RV_SITE" && seedCapacity(unit) === 1)).toBe(true);
  });

  it("starts Boys 121, 210 and 212 unavailable and nothing else", () => {
    expect(unitsOf(sunnydale).filter((unit) => unit.defaultUnavailable).map((unit) => unit.key).sort()).toEqual(["boys-121", "boys-210", "boys-212"]);
  });

  it("sizes the special rooms, the conference center and the tent areas as recorded", () => {
    for (const key of ["boys-314", "boys-315", "boys-316"]) expect(find(sunnydale, key)).toMatchObject({ specialUse: true, capacity: 8 });
    expect(seedCapacity(find(sunnydale, "boys-121"))).toBe(4);
    expect(seedCapacity(find(sunnydale, "boys-302"))).toBe(2);
    expect(find(sunnydale, "boys-302").bathroom).toBe("PRIVATE");
    expect(seedCapacity(find(sunnydale, "boys-101"))).toBe(2);
    expect(["cc-01", "cc-02", "cc-1a", "cc-1b"].map((key) => seedCapacity(find(sunnydale, key)))).toEqual([2, 4, 1, 1]);
    expect(find(sunnydale, "cc-01").bathroom).toBe("PRIVATE");
    expect(find(sunnydale, "cc-1a").bathroom).toBe("SHARED");
    expect(seedCapacity(find(sunnydale, "tents-with-power"))).toBe(4);
    expect(find(sunnydale, "tents-with-power").category).toBe("TENT_WITH_POWER");
    expect(seedCapacity(find(sunnydale, "tent-camping"))).toBeNull();
    expect(find(sunnydale, "tent-camping").category).toBe("TENT");
  });

  it("gives every unit a way to be counted", () => {
    for (const template of lodgingPropertyTemplates) {
      for (const unit of unitsOf(template) as LodgingUnitSeed[]) {
        const capacity = seedCapacity(unit);
        if (capacity === null) expect(unit.isArea).toBe(true);
        else expect(capacity).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
