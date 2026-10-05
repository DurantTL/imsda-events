import type { LodgingPropertySeed, LodgingUnitSeed } from "@/modules/lodging/templates/types";

/**
 * Sunnydale Academy (Camp Meeting), from the sheets and the legacy housing
 * tool recorded on #198. Room and site structure only: the source sheets'
 * occupant names are deliberately not copied, and nothing here is priced.
 * Whether a room is available is a per-event choice; Boys 121, 210 and 212
 * start unavailable but stay in the inventory.
 */
function dorm(prefix: string, floor: number, number: number, extra: Partial<LodgingUnitSeed> = {}): LodgingUnitSeed {
  return {
    key: `${prefix}-${number}`,
    name: String(number),
    kind: "ROOM",
    category: "DORM_ROOM",
    floor,
    groundLevel: floor === 1,
    beds: ["TWIN", "TWIN"],
    ...extra,
  };
}

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

const boys = (floor: number, numbers: readonly number[], extra: (number: number) => Partial<LodgingUnitSeed> = () => ({})) =>
  numbers.map((number) => dorm("boys", floor, number, extra(number)));
const girls = (floor: number, numbers: readonly number[]) => numbers.map((number) => dorm("girls", floor, number));

export const sunnydaleTemplate: LodgingPropertySeed = {
  key: "sunnydale-academy",
  name: "Sunnydale Academy",
  version: 1,
  buildings: [
    {
      key: "boys-dorm",
      name: "Boys Dorm",
      units: [
        ...boys(1, [...range(101, 105), ...range(120, 123)], (number) => number === 121
          ? { beds: ["DOUBLE", "DOUBLE"], defaultUnavailable: true, notes: "2 double beds. Unavailable by default." }
          : {}),
        ...boys(1, [106, 107], () => ({ assignable: false, beds: [], capacity: 0, category: undefined, notes: "Storage." })),
        ...boys(2, [...range(201, 205), 207, ...range(209, 216)], (number) => number === 210 || number === 212
          ? { defaultUnavailable: true, notes: "Unavailable by default." }
          : {}),
        ...boys(3, [...range(301, 303), 305, ...range(307, 316)], (number) => {
          if (number === 302) return { beds: ["DOUBLE"], bathroom: "PRIVATE", notes: "Double room with a private bath." };
          if (number >= 314) return { beds: [], capacity: 8, specialUse: true, notes: "Special use: a group room that holds 8." };
          return {};
        }),
      ],
    },
    {
      key: "girls-dorm",
      name: "Girls Dorm",
      units: [
        ...girls(1, range(101, 108)),
        ...girls(2, [...range(201, 205), 207, 211, ...range(213, 228)]),
        ...girls(3, [...range(301, 305), 307, ...range(311, 318)]),
      ],
    },
    {
      key: "conference-center",
      name: "Conference center",
      units: [
        { key: "cc-01", name: "CC-01", kind: "ROOM", category: "CONFERENCE_CENTER_ROOM", bathroom: "PRIVATE", beds: ["QUEEN"], notes: "Front room, own bathroom." },
        { key: "cc-02", name: "CC-02", kind: "ROOM", category: "CONFERENCE_CENTER_ROOM", bathroom: "PRIVATE", beds: ["DOUBLE", "DOUBLE"], notes: "Front room, own bathroom." },
        { key: "cc-1a", name: "CC-1A", kind: "ROOM", category: "CONFERENCE_CENTER_ROOM", bathroom: "SHARED", beds: ["TWIN"], notes: "Back room, shares the center's bathroom." },
        { key: "cc-1b", name: "CC-1B", kind: "ROOM", category: "CONFERENCE_CENTER_ROOM", bathroom: "SHARED", beds: ["TWIN"], notes: "Back room, shares the center's bathroom." },
      ],
    },
    {
      key: "rv-sites",
      name: "RV sites",
      units: [
        ...range(1, 16).map((number): LodgingUnitSeed => ({
          key: `rv-${number}`,
          name: `RV site ${number}`,
          kind: "RV_SITE",
          category: "RV_SITE",
          capacity: 1,
          notes: "Church parking lot. Fill from site 1 first.",
        })),
        { key: "rv-conference-center", name: "RV site by the conference center", kind: "RV_SITE", category: "RV_SITE", capacity: 1 },
        { key: "rv-cafeteria", name: "RV site by the cafeteria", kind: "RV_SITE", category: "RV_SITE", capacity: 1 },
      ],
    },
    {
      key: "tent-areas",
      name: "Tent areas",
      units: [
        { key: "tents-with-power", name: "Tent sites with power", kind: "TENT", isArea: true, category: "TENT_WITH_POWER", capacity: 4, notes: "By the Girls Dorm; not numbered. Grass that turns to mud in the rain." },
        { key: "tent-camping", name: "Tent camping", kind: "TENT", isArea: true, category: "TENT", capacity: null, notes: "No set limit and no designated spots." },
      ],
    },
  ],
};
