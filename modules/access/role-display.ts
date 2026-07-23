import type { EventRole } from "@/modules/access/permissions";

export const roleDetails: Record<EventRole, { label: string; description: string }> = {
  EVENT_ADMIN: { label: "Event administrator", description: "Full event access, configuration, and staff management." },
  REGISTRATION_MANAGER: { label: "Registration manager", description: "People, registrations, and operational reports." },
  FINANCE_MANAGER: { label: "Finance manager", description: "Payments, refunds, balances, and reports." },
  COMMUNICATIONS_MANAGER: { label: "Communications manager", description: "Draft and publish attendee event-feed updates." },
  CHECK_IN_STAFF: { label: "Check-in staff", description: "Arrival search, check-in, and check-in reversal." },
  READ_ONLY_STAFF: { label: "Read-only staff", description: "View the event workspace without making changes." },
};

export function roleLabel(role: EventRole) {
  return roleDetails[role].label;
}
