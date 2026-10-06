import type { LodgingBedType } from "@/modules/lodging/domain";
import type { LodgingPropertySeed, LodgingUnitSeed } from "@/modules/lodging/templates/types";

/**
 * Camp Heritage, from the lodging chart recorded on #198. Camp events include
 * lodging in the registration price, so nothing here is priced. Camp Heritage
 * House is never available and is not listed.
 */
const queenAndBunk: readonly LodgingBedType[] = ["QUEEN", "TWIN_BUNK"];
const cabinBeds: readonly LodgingBedType[] = ["TWIN_BUNK", "TWIN_BUNK", "TWIN_BUNK", "TWIN_BUNK", "DOUBLE"];

function room(key: string, name: string, beds: readonly LodgingBedType[], extra: Partial<LodgingUnitSeed> = {}): LodgingUnitSeed {
  return { key, name, kind: "ROOM", bathroom: "PRIVATE", linensProvided: true, beds, ...extra };
}

function cabin(key: string, name: string, beds: readonly LodgingBedType[] = cabinBeds): LodgingUnitSeed {
  return { key, name, kind: "ROOM", bathroom: "BATHHOUSE", linensProvided: false, beds };
}

export const campHeritageTemplate: LodgingPropertySeed = {
  key: "camp-heritage",
  name: "Camp Heritage",
  version: 1,
  buildings: [
    {
      key: "wildlife-inn",
      name: "Wildlife Inn",
      units: [
        ...["Moose", "Deer", "Wolf"].map((name) => room(`wildlife-inn-${name.toLowerCase()}`, name, queenAndBunk, { floor: 1, groundLevel: true })),
        ...["Eagle", "Loon", "Owl"].map((name) => room(`wildlife-inn-${name.toLowerCase()}`, name, queenAndBunk, { floor: 2 })),
      ],
    },
    {
      key: "lakeview-lodge",
      name: "Lakeview Lodge",
      units: [
        room("lakeview-sunset", "Sunset Room", ["QUEEN"], { notes: "Connected to the dining hall.", defaultHold: { kind: "STAFF", reason: "Held for the cooks" } }),
        room("lakeview-starlight", "Starlight Room", ["QUEEN"], { defaultHold: { kind: "STAFF", reason: "Held for the cooks" } }),
      ],
    },
    {
      key: "generals-quarters",
      name: "Generals Quarters",
      units: [room("generals-quarters", "Generals Quarters", queenAndBunk, { notes: "A separate building attached to the office; not part of Lakeview." })],
    },
    {
      key: "four-seasons-cabins",
      name: "Four Seasons Cabins",
      units: ["Winter", "Summer", "Autumn", "Spring"].map((name) =>
        room(`four-seasons-${name.toLowerCase()}`, name, ["QUEEN", "TWIN_BUNK", "TWIN_BUNK"], { notes: "Kitchenette, carpet. North and South cabins." })),
    },
    {
      key: "medicine-lodge",
      name: "Medicine Lodge",
      units: [
        room("medicine-willow-bark", "Willow Bark", queenAndBunk),
        room("medicine-witch-hazel", "Witch Hazel", queenAndBunk),
        room("medicine-nurses-room", "Nurses Room", queenAndBunk, { defaultHold: { kind: "STAFF", reason: "Held for the nurse" } }),
        room("medicine-wild-thyme", "Wild Thyme", ["QUEEN", "TWIN_BUNK", "TWIN_BUNK"]),
      ],
    },
    {
      key: "forest-village",
      name: "Forest Village",
      units: ["Beaver", "Raccoon", "Wolverine", "Coyote", "Bobcat", "Bear"].map((name) => cabin(`forest-village-${name.toLowerCase()}`, name)),
    },
    {
      key: "mountain-village",
      name: "Mountain Village",
      units: ["Nuthatch", "Chickadee", "Robin", "Dove", "Cardinal", "Bluebird"].map((name) => cabin(`mountain-village-${name.toLowerCase()}`, name)),
    },
    {
      key: "other-cabins",
      name: "Other cabins",
      units: [
        cabin("goldfinch", "Goldfinch", ["TWIN_BUNK", "TWIN_BUNK", "DOUBLE"]),
        cabin("whippoorwill", "Whippoorwill"),
      ],
    },
    {
      key: "shady-oak-campground",
      name: "Shady Oak Campground",
      units: [
        { key: "shady-oak-full-hookup", name: "Shady Oak full-hookup sites", kind: "RV_SITE", isArea: true, capacity: 20, notes: "A counted area; the sites are not numbered on site." },
        { key: "shady-oak-no-electric", name: "Shady Oak sites without electricity", kind: "TENT", isArea: true, capacity: 20, notes: "A counted area; the sites are not numbered on site." },
      ],
    },
  ],
};
