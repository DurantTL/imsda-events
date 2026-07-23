import type { EventRole } from "@/modules/access/permissions";

export function removesActiveEventAdmin(
  current: { role: EventRole; status: "ACTIVE" | "INACTIVE" },
  next: { role: EventRole; status: "ACTIVE" | "INACTIVE" },
) {
  return current.role === "EVENT_ADMIN"
    && current.status === "ACTIVE"
    && (next.role !== "EVENT_ADMIN" || next.status !== "ACTIVE");
}

export function wouldRemoveLastActiveEventAdmin(
  current: { role: EventRole; status: "ACTIVE" | "INACTIVE" },
  next: { role: EventRole; status: "ACTIVE" | "INACTIVE" },
  otherActiveAdminCount: number,
) {
  return removesActiveEventAdmin(current, next) && otherActiveAdminCount === 0;
}
