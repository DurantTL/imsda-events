import { addDays, stayNights, type LodgingCategory, type LodgingRate } from "@/modules/lodging/domain";
import type { HouseholdPreference, RegistrationLodgingInput } from "@/modules/lodging/preferences-domain";
import { lodgingCharge, unitsForParty, type LodgingPriceLine } from "@/modules/lodging/pricing";

/**
 * The lodging step of the public registration form (#199), as pure helpers shared by the step's screen, the form's
 * running total and the tests. The server decides again on submit (full types, minimum nights, price); nothing here is
 * trusted, it only keeps the screen honest while the registrant chooses.
 */

/** What the form offers; the same shape the server sends (`PublicLodgingOffer`). */
export type LodgingStepOffer = {
  nights: string[];
  deadline: string;
  fullBehavior: "SHOW_FULL" | "WAITLIST";
  categories: Array<{ category: LodgingCategory; label: string; remaining: Record<string, number | null>; rate: LodgingRate | null; unitCapacity?: number | null }>;
};

export type LodgingChoice = {
  category: LodgingCategory | "";
  firstNight: string;
  lastNight: string;
  partySize: number;
  groundFloorNeeded: boolean;
  accessibleRoomNeeded: boolean;
  privateRoomRequested: boolean;
  householdPreference: HouseholdPreference;
  roommates: Array<{ name: string; confirmationCode: string; fromClientId: string }>;
  within: Array<{ fromClientId: string; targetClientId: string }>;
};

export function defaultLodgingChoice(offer: LodgingStepOffer, attendeeCount: number): LodgingChoice {
  return {
    category: "",
    firstNight: offer.nights[0] ?? "",
    lastNight: offer.nights[offer.nights.length - 1] ?? "",
    partySize: Math.max(1, attendeeCount),
    groundFloorNeeded: false,
    accessibleRoomNeeded: false,
    privateRoomRequested: false,
    householdPreference: "TOGETHER",
    roommates: [],
    within: [],
  };
}

/** The nights the choice covers, first to last. Empty when the last night is before the first. */
export function chosenNights(choice: Pick<LodgingChoice, "firstNight" | "lastNight">) {
  if (!choice.firstNight || !choice.lastNight || choice.lastNight < choice.firstNight) return [];
  return stayNights(choice.firstNight, addDays(choice.lastNight, 1));
}

/** Whether a type has too little room for this party on any chosen night (the server counts again under its locks). */
export function categoryIsFull(offer: LodgingStepOffer, category: LodgingCategory, nights: readonly string[], partySize: number) {
  const entry = offer.categories.find((candidate) => candidate.category === category);
  if (!entry) return true;
  return nights.some((night) => {
    const remaining = entry.remaining[night];
    return remaining !== null && (remaining === undefined || remaining < partySize);
  });
}

/**
 * What cannot be submitted. `relaxed` is for a registration that is joining the waitlist: its lodging choice is kept as an
 * unpriced request, so a full type or a stay under a minimum is not a problem yet.
 */
export function lodgingStepProblem(offer: LodgingStepOffer, choice: LodgingChoice, attendeeCount: number, relaxed = false): string | null {
  const nights = chosenNights(choice);
  if (nights.length === 0) return "Lodging step: the last night cannot be before the first night.";
  if (choice.partySize < 1 || choice.partySize > Math.max(1, attendeeCount)) return "Lodging step: choose how many of the people on this registration are staying.";
  if (choice.category === "") return null;
  const entry = offer.categories.find((candidate) => candidate.category === choice.category);
  if (!entry) return "Lodging step: that lodging type is not available.";
  if (!relaxed && categoryIsFull(offer, choice.category, nights, choice.partySize)) return `Lodging step: ${entry.label} is full for those nights. Choose another type or other nights.`;
  const charge = lodgingCharge({ category: choice.category, nights: nights.length, partySize: choice.partySize, rates: entry.rate ? { [choice.category]: entry.rate } : {}, units: unitsForParty(choice.partySize, entry.unitCapacity) });
  if (!relaxed && charge.kind === "BELOW_MINIMUM_NIGHTS") return `Lodging step: ${entry.label} needs at least ${charge.minimumNights} nights.`;
  const incomplete = choice.roommates.some((row) => (row.name.trim() !== "") !== (row.confirmationCode.trim() !== ""));
  if (incomplete) return "Lodging step: enter both the name and the confirmation code to ask someone to room with you.";
  return null;
}

/** The priced line the choice adds to the total, or null (no type, no rate, or a choice that cannot be priced). */
export function lodgingStepLine(offer: LodgingStepOffer, choice: LodgingChoice): LodgingPriceLine | null {
  if (choice.category === "") return null;
  const entry = offer.categories.find((candidate) => candidate.category === choice.category);
  if (!entry?.rate) return null;
  const charge = lodgingCharge({ category: choice.category, nights: chosenNights(choice).length, partySize: choice.partySize, rates: { [choice.category]: entry.rate }, units: unitsForParty(choice.partySize, entry.unitCapacity) });
  return charge.kind === "CHARGE" ? charge.line : null;
}

/** The submission's `lodging`: the whole event is sent as no window, a partial stay as its first and last night. */
export function lodgingStepInput(offer: LodgingStepOffer, choice: LodgingChoice): RegistrationLodgingInput {
  const whole = choice.firstNight === offer.nights[0] && choice.lastNight === offer.nights[offer.nights.length - 1];
  const roommates = choice.roommates.filter((row) => row.name.trim() !== "" && row.confirmationCode.trim() !== "");
  return {
    category: choice.category === "" ? null : choice.category,
    firstNight: whole ? null : choice.firstNight,
    lastNight: whole ? null : choice.lastNight,
    partySize: choice.partySize,
    groundFloorNeeded: choice.groundFloorNeeded,
    accessibleRoomNeeded: choice.accessibleRoomNeeded,
    privateRoomRequested: choice.privateRoomRequested,
    householdPreference: choice.householdPreference,
    ...(roommates.length > 0 ? { roommates: roommates.map((row) => ({ name: row.name.trim(), confirmationCode: row.confirmationCode.trim(), ...(row.fromClientId ? { fromClientId: row.fromClientId } : {}) })) } : {}),
    ...(choice.within.length > 0 ? { roommatesWithin: choice.within } : {}),
  };
}
