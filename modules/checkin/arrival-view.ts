import { attendeeBalanceCents } from "@/modules/registrations/finance-view";

/**
 * The only per-attendee shape the check-in desk receives (#757). It is built
 * on the server from an explicit allow-list, so form answers (public
 * submission responses, attendee responses, health or sensitive-flagged
 * answers), contact details and payment history can never reach the client,
 * whatever permissions the viewer holds. The check-in desk shows none of
 * those, so unlike other staff screens there is no VIEW_SENSITIVE_DATA
 * branch: nothing sensitive is a legitimate part of this view.
 */
export type CheckInArrival = {
  id: string;
  firstName: string;
  lastName: string;
  attendeeType: string;
  checkedIn: boolean;
  checkedInAt: string | null;
  confirmationCode: string;
  /** Amount to collect at the door; always 0 when `showBalances` is false. */
  balanceCents: number;
  /** Attendees on the same registration, for the payment-due prompt. */
  partySize: number;
};

type ArrivalSource = {
  confirmationCode: string;
  balanceCents: number;
  isDeferredOrganizationBilling?: boolean;
  attendees: ReadonlyArray<{
    id: string;
    firstName: string;
    lastName: string;
    attendeeType: string;
    checkedIn: boolean;
    checkedInAt: string | null;
  }>;
};

export function projectCheckInArrivals(
  registrations: readonly ArrivalSource[],
  options: { showBalances: boolean },
): CheckInArrival[] {
  return registrations.flatMap((registration) => {
    const balanceCents = options.showBalances ? attendeeBalanceCents(registration) : 0;
    return registration.attendees.map((attendee) => ({
      id: attendee.id,
      firstName: attendee.firstName,
      lastName: attendee.lastName,
      attendeeType: attendee.attendeeType,
      checkedIn: attendee.checkedIn,
      checkedInAt: attendee.checkedInAt,
      confirmationCode: registration.confirmationCode,
      balanceCents,
      partySize: registration.attendees.length,
    }));
  });
}
