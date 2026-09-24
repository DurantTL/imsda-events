import {
  clubHeadcounts,
  roleAbbreviation,
  type ClubAssignmentSummary,
  type ClubEventRecord,
  type ClubHeadcounts,
} from "@/modules/reporting/club-event-reports";

/**
 * The printable club packet (Q1, #411): one letter sheet, front and back,
 * generalizing the retreat group-packet pattern (`retreat-packets.ts`, #155)
 * for a single club instead of a registration group. Pure, so the staff
 * packet page, the director's own-club page, and their tests all build the
 * same data from the same club record.
 *
 * Markers are flags only, never free text: a first-time-camper marker is
 * left out entirely because the Spring Camporee form collects no such
 * answer — a field missing from the form shows nothing here.
 */

export type ClubPacketAttendeeRow = {
  id: string;
  lastName: string;
  firstName: string;
  roleAbbreviation: string;
  ageOnEventDate: number | null;
  gender: string | null;
  medicalPersonnel: boolean;
  masterGuideInvestiture: boolean;
  firstTimeCamper: boolean;
  hasDietaryNeed: boolean;
};

export type ClubPacketEvent = {
  name: string;
  conferenceName: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  /** The form's late-pricing start date, or null when the event has no late pricing. */
  earlyBirdDeadline: string | null;
  /** True when this club's fee was calculated at the late rate. Only meaningful when `earlyBirdDeadline` is set. */
  lateRateApplied: boolean;
};

export type ClubPacket = {
  event: ClubPacketEvent;
  club: {
    organizationId: string;
    organizationName: string;
    sponsoringChurch: string | null;
    directorName: string;
    email: string;
    phone: string;
    submittedAt: string | null;
    confirmationCode: string;
  };
  headcounts: ClubHeadcounts;
  /** Attendees marked "First time at Camporee?" on the form. */
  firstTimeCampers: number;
  attendees: ClubPacketAttendeeRow[];
  camping: ClubEventRecord["camping"];
  assignment: ClubAssignmentSummary;
  dutyPreferences: {
    dutyAreas: string[];
    flagSlots: string[];
    bathroomDays: string[];
  };
  otherDetails: {
    specialActivities: string[];
    sponsoringMeals: boolean;
    mealSponsorshipCount: string;
    mealTimes: string[];
    partnerClub: string;
    eventRibbons: string;
    sabbathSkit: string;
  };
  milestones: {
    baptismNames: string;
    bibleNames: string;
  };
  amountOwedCents: number;
  isBilled: boolean;
};

export function buildClubPacket(club: ClubEventRecord, event: ClubPacketEvent): ClubPacket {
  const attendees: ClubPacketAttendeeRow[] = [...club.attendees]
    .sort((left, right) => left.lastName.localeCompare(right.lastName) || left.firstName.localeCompare(right.firstName))
    .map((attendee) => ({
      id: attendee.id,
      lastName: attendee.lastName,
      firstName: attendee.firstName,
      roleAbbreviation: roleAbbreviation(attendee.role),
      ageOnEventDate: attendee.ageOnEventDate,
      gender: attendee.gender,
      medicalPersonnel: attendee.medicalPersonnel,
      masterGuideInvestiture: attendee.masterGuideInvestiture,
      firstTimeCamper: attendee.firstTimeCamper,
      hasDietaryNeed: attendee.hasDietaryNeed,
    }));

  return {
    event: { ...event, lateRateApplied: club.lateRateApplied },
    club: {
      organizationId: club.organizationId,
      organizationName: club.organizationName,
      sponsoringChurch: club.sponsoringChurch,
      directorName: club.directorName,
      email: club.email,
      phone: club.phone,
      submittedAt: club.submittedAt,
      confirmationCode: club.confirmationCode,
    },
    headcounts: clubHeadcounts(club.attendees),
    firstTimeCampers: club.attendees.filter((attendee) => attendee.firstTimeCamper).length,
    attendees,
    camping: club.camping,
    assignment: null,
    dutyPreferences: {
      dutyAreas: club.dutyAreas,
      flagSlots: club.flagSlots,
      bathroomDays: club.bathroomDays,
    },
    otherDetails: {
      specialActivities: club.specialActivities,
      sponsoringMeals: club.sponsoringMeals,
      mealSponsorshipCount: club.mealSponsorshipCount,
      mealTimes: club.mealTimes,
      partnerClub: club.partnerClub,
      eventRibbons: club.eventRibbons,
      sabbathSkit: club.sabbathSkit,
    },
    milestones: {
      baptismNames: club.baptismNames,
      bibleNames: club.bibleNames,
    },
    amountOwedCents: club.amountOwedCents,
    isBilled: club.amountOwedCents > 0,
  };
}

/** Attaches staff's campsite/duty/activity assignment (#410) to an already-built packet. */
export function withClubPacketAssignment(packet: ClubPacket, assignment: ClubAssignmentSummary): ClubPacket {
  return { ...packet, assignment };
}
