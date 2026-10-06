import { formatCalendarDate } from "@/modules/club-registrations/domain";
import type { TeamSettings } from "@/modules/club-teams/domain";

/**
 * The printable team registration form (#809): the paper Pathfinder Bible Experience form (4-1) as data. Pure, so the
 * filled form (from a registration), the blank form (for clubs that mail or email the paper) and the tests all read one
 * wording. The text follows the paper form; the dates come from the event, never from the text.
 */

export const TEAM_FORM_NUMBER = "4-1";
export const TEAM_FORM_CONFERENCE = "Iowa-Missouri Conference Pathfinder";
export const TEAM_FORM_TITLE = "Bible Experience Participating Form";

/** The team the filled form shows. Absent for the blank form. */
export type TeamFormFilled = {
  teamName: string;
  clubName: string;
  church: string | null;
  confirmationCode: string;
  areaLocation: string | null;
  coordinator: { name: string; address: string; city: string; state: string; zip: string; phone: string; email: string };
  partnerClub: string;
  members: string[];
  alternate: string;
  coaches: string[];
  /** The director's confirmation box was checked, and the date it was recorded. */
  confirmed: boolean;
  confirmedOn: string | null;
  /** The photo, video and liability release answer the director gave: "Yes", "No", or blank when none was recorded. */
  releaseAnswer: "Yes" | "No" | "";
};

export type TeamFormInput = {
  /** The Area level's date (the event's first day) and where it is held. */
  areaDate: string;
  areaPlaces: ReadonlyArray<{ name: string; address: string | null }>;
  registrationClosesOn: string | null;
  settings: Pick<TeamSettings, "minTeamMembers" | "maxTeamMembers" | "maxAlternates" | "maxMemberAge" | "ageAsOf" | "booksLine" | "levelInfo"> | null;
  filled: TeamFormFilled | null;
};

export type TeamFormModel = {
  formNumber: string;
  conference: string;
  title: string;
  /** "Due December 18", or empty when the event has no closing date. */
  dueNote: string;
  booksLine: string;
  /** The date and places paragraph, then the team rules paragraph. */
  datesParagraph: string;
  teamParagraph: string;
  coordinatorIntro: string;
  /** One more number than the paper's six when the team has seven members and no alternate, never fewer than six. */
  memberSlots: Array<{ number: number; name: string }>;
  alternate: string;
  coaches: string[];
  confirmationText: string;
  releaseText: string;
  mailLine: string;
  contactLines: string[];
  filled: TeamFormFilled | null;
};

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (count: number) => NUMBER_WORDS[count] ?? String(count);

/** "December 18" from a calendar date, as the paper's due note reads. */
function monthDay(calendarDate: string) {
  return formatCalendarDate(calendarDate).replace(/,\s*\d{4}$/, "");
}

function listNames(names: readonly string[]) {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const MAX_SLOTS_WITHOUT_ALTERNATE = 6;

export function buildTeamForm(input: TeamFormInput): TeamFormModel {
  const settings = input.settings;
  const level = (name: "CONFERENCE" | "UNION") => settings?.levelInfo.find((entry) => entry.level === name);
  const conference = level("CONFERENCE");
  const union = level("UNION");
  const levelSentence = (label: string, entry: ReturnType<typeof level>) => {
    const when = entry?.date ? `will be ${formatCalendarDate(entry.date)}` : "will be announced later";
    // "TBA" is how the template says the venue is not known yet: the paper form simply leaves it out.
    const where = entry?.place && !/^tba$/i.test(entry.place.trim()) ? ` in ${entry.place}` : "";
    return `${label} ${when}${entry?.date ? where : ""}.`;
  };
  const places = input.areaPlaces.map((place) => place.name);
  const placesSentence = places.length >= 2
    ? `There will be ${word(places.length)} locations, ${listNames(places)}.`
    : places.length === 1 ? `It will be held at ${places[0]}.` : "";
  const venuesLater = input.areaPlaces.every((place) => place.address) && input.areaPlaces.length > 0 ? "" : " Locations will be provided at a later date.";
  const closing = input.registrationClosesOn ? ` The deadline for this registration form is ${monthDay(input.registrationClosesOn)}.` : "";

  const datesParagraph = [
    `The IA/MO Conference Area Bible Experiences will be held ${formatCalendarDate(input.areaDate)}.`,
    placesSentence ? `${placesSentence}${venuesLater}` : venuesLater.trim(),
    levelSentence("The Conference Bible Experience", conference),
    levelSentence("The Mid-America Union Bible Experience", union),
  ].filter(Boolean).join(" ") + `${closing} Do not use the NAD dates on their website. The IA-MO Conference dates are different from the other Conferences in this Union.`;

  const min = settings?.minTeamMembers ?? null;
  const max = settings?.maxTeamMembers ?? null;
  const ageLimit = settings?.maxMemberAge !== null && settings?.maxMemberAge !== undefined
    ? `, not older than ${settings.maxMemberAge} as of ${formatCalendarDate(settings.ageAsOf ?? input.areaDate)}`
    : "";
  const sizeSentence = min !== null && max !== null
    ? `The team must have a minimum of ${word(min)} members, and the maximum number is ${word(max)}${(settings?.maxAlternates ?? 0) > 0 ? ", which includes the alternate member" : ""}.`
    : "";
  const teamParagraph = [
    "Teams can be any Pathfinder inducted into the Pathfinder Club which includes TLTs.",
    `The team member must be an active Pathfinder in good standing and not graduated from high school${ageLimit}.`,
    sizeSentence,
    "If a team member is absent, they can still go on to the next level if the team qualifies.",
    "If you only have 4 or less pathfinders interested in participating, you can join with one other club for PBE.",
  ].filter(Boolean).join(" ");

  const filled = input.filled;
  const memberCount = filled?.members.length ?? 0;
  const slotCount = Math.max(MAX_SLOTS_WITHOUT_ALTERNATE, memberCount);
  const memberSlots = Array.from({ length: slotCount }, (_, index) => ({ number: index + 1, name: filled?.members[index] ?? "" }));

  const confirmedAge = settings?.maxMemberAge !== null && settings?.maxMemberAge !== undefined
    ? ` and is not older than ${settings.maxMemberAge} as of ${formatCalendarDate(settings.ageAsOf ?? input.areaDate)}`
    : "";
  return {
    formNumber: TEAM_FORM_NUMBER,
    conference: TEAM_FORM_CONFERENCE,
    title: TEAM_FORM_TITLE,
    dueNote: input.registrationClosesOn ? `Due ${monthDay(input.registrationClosesOn)}` : "",
    booksLine: settings?.booksLine ?? "",
    datesParagraph,
    teamParagraph,
    coordinatorIntro: "We would like a contact person's name and number to be able to send out updates and information as needed.",
    memberSlots,
    alternate: filled?.alternate ?? "",
    coaches: filled?.coaches ?? [],
    confirmationText: `Every team member is an inducted Pathfinder/TLT in good standing, has not graduated from high school${confirmedAge}.`,
    releaseText: "Participants agree to be photographed and/or videotaped by or on behalf of the IA-MO Conference Youth Department during Youth Department events, and grants the IA-MO Conference Youth Department permission to use any such photographs and/or videotapes in any future promotional and/or advertising publications, and further releases Camp Heritage and/or the Conference from any and all liability in connection with such use.",
    mailLine: "Please mail or email this form in as soon as possible!",
    contactLines: [
      "YOUTH DEPARTMENT, PO Box 65665, West Des Moines, IA 50265  Email: youth@imsda.org",
      "Or register online from your club's page in IMSDA Events.",
      "Go to https://nadpbe.org/pbe-resources/ to assist you in your PBE preparation.",
    ],
    filled,
  };
}
