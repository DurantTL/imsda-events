import { addDays, stayNights, type LodgingCategory, type LodgingRate } from "@/modules/lodging/domain";
import { resolveRoomChoice, type HouseholdPreference, type RegistrationLodgingInput } from "@/modules/lodging/preferences-domain";
import { lodgingCharge, type LodgingPriceLine } from "@/modules/lodging/pricing";

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
  categories: Array<{
    category: LodgingCategory;
    label: string;
    /** What is left each night: rooms for a room-type category (`roomBased`), people for any other. */
    remaining: Record<string, number | null>;
    rate: LodgingRate | null;
    /** People a typical room takes (the beds the extra-bedding note compares the party with). */
    unitCapacity?: number | null;
    /** The registrant chooses how many rooms. */
    roomBased?: boolean;
    /** Per night, the beds of the rooms in service, largest first: the over-beds note is worked out from the best case. */
    roomBeds?: Record<string, number[]> | null;
    /** Whether the type's units provide linens: ALL (no bedding note), SOME ("Most rooms: ..."), NONE. */
    linens?: "ALL" | "SOME" | "NONE";
  }>;
};

export type LodgingChoice = {
  category: LodgingCategory | "";
  firstNight: string;
  lastNight: string;
  partySize: number;
  /** "How many rooms?" (room-type categories only; 1 otherwise). */
  roomCount: number;
  /** The registrant confirms bringing extra bedding when the party is larger than the beds in the chosen rooms. */
  bringsExtraBedding: boolean;
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
    roomCount: 1,
    bringsExtraBedding: false,
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

/**
 * Whether a type has too little room for this request on any chosen night (the server counts again under its locks). A
 * room-type category is counted in rooms (`roomCount`, 1 by default: is there even one room?), any other in people.
 */
export function categoryIsFull(offer: LodgingStepOffer, category: LodgingCategory, nights: readonly string[], partySize: number, roomCount = 1) {
  const entry = offer.categories.find((candidate) => candidate.category === category);
  if (!entry) return true;
  const needed = entry.roomBased ? roomCount : partySize;
  return nights.some((night) => {
    const remaining = entry.remaining[night];
    return remaining !== null && (remaining === undefined || remaining < needed);
  });
}

/** Rooms free on every one of the nights; null when the type has no fixed limit. */
export function roomsFreeOn(offer: LodgingStepOffer, category: LodgingCategory, nights: readonly string[]) {
  const entry = offer.categories.find((candidate) => candidate.category === category);
  if (!entry) return 0;
  let free: number | null = null;
  for (const night of nights) {
    const remaining = entry.remaining[night];
    if (remaining === null) continue;
    free = Math.min(free ?? Number.MAX_SAFE_INTEGER, remaining ?? 0);
  }
  return free;
}

/**
 * The rooms question for the chosen type: whether it is asked, how many rooms may be chosen (1 up to the party size and the
 * rooms free), and whether the extra-bedding note shows. The same rule the server applies (`resolveRoomChoice`).
 */
export function roomQuestion(offer: LodgingStepOffer, choice: Pick<LodgingChoice, "category" | "firstNight" | "lastNight" | "partySize" | "roomCount" | "bringsExtraBedding">, relaxed = false) {
  const entry = choice.category === "" ? undefined : offer.categories.find((candidate) => candidate.category === choice.category);
  if (!entry?.roomBased || choice.category === "") return { asked: false as const, highest: 1, extraBeddingNeeded: false, problem: null as string | null };
  const free = relaxed ? null : roomsFreeOn(offer, choice.category, chosenNights(choice));
  const highest = Math.max(1, Math.min(choice.partySize, free === null ? choice.partySize : free));
  const result = resolveRoomChoice({
    capacity: { roomBased: true, unitCapacity: entry.unitCapacity ?? null, ...(entry.roomBeds ? { roomBeds: entry.roomBeds } : {}) },
    nights: chosenNights(choice),
    partySize: choice.partySize, roomCount: choice.roomCount, bringsExtraBedding: choice.bringsExtraBedding, requireAcknowledgement: true,
    roomsAvailable: free !== null && free > 0 ? free : null,
  });
  const extraBeddingNeeded = result.ok ? result.extraBeddingNeeded : result.code === "EXTRA_BEDDING_NOT_ACKNOWLEDGED";
  return { asked: true as const, highest, extraBeddingNeeded, problem: result.ok ? null : `Lodging step: ${result.message}` };
}

/** The room count kept within what is allowed (1 up to the party and the rooms free), for when the party or the nights change. */
export function clampedRoomCount(offer: LodgingStepOffer, choice: LodgingChoice) {
  const question = roomQuestion(offer, choice);
  return question.asked ? Math.min(Math.max(1, choice.roomCount), question.highest) : 1;
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
  const rooms = roomQuestion(offer, choice, relaxed);
  if (rooms.problem) return rooms.problem;
  const charge = lodgingCharge({ category: choice.category, nights: nights.length, partySize: choice.partySize, rates: entry.rate ? { [choice.category]: entry.rate } : {}, units: entry.roomBased ? choice.roomCount : 1 });
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
  const charge = lodgingCharge({ category: choice.category, nights: chosenNights(choice).length, partySize: choice.partySize, rates: { [choice.category]: entry.rate }, units: entry.roomBased ? Math.min(Math.max(1, choice.roomCount), choice.partySize) : 1 });
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
    ...(offer.categories.find((candidate) => candidate.category === choice.category)?.roomBased
      ? { roomCount: choice.roomCount, ...(choice.bringsExtraBedding ? { bringsExtraBedding: true } : {}) }
      : {}),
    groundFloorNeeded: choice.groundFloorNeeded,
    accessibleRoomNeeded: choice.accessibleRoomNeeded,
    privateRoomRequested: choice.privateRoomRequested,
    householdPreference: choice.householdPreference,
    ...(roommates.length > 0 ? { roommates: roommates.map((row) => ({ name: row.name.trim(), confirmationCode: row.confirmationCode.trim(), ...(row.fromClientId ? { fromClientId: row.fromClientId } : {}) })) } : {}),
    ...(choice.within.length > 0 ? { roommatesWithin: choice.within } : {}),
  };
}
