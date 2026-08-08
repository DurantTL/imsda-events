export type MerchandiseAdminStatus = "enabled" | "disabled" | "archived" | "scheduled";

export function merchandiseAdminStatus(input: { isEnabled: boolean; isArchived?: boolean; startsAt?: string | null; endsAt?: string | null; now?: Date }) {
  if (input.isArchived) return "archived" as const;
  if (!input.isEnabled) return "disabled" as const;
  const now = input.now ?? new Date();
  if (input.startsAt && new Date(input.startsAt) > now) return "scheduled" as const;
  if (input.endsAt && new Date(input.endsAt) < now) return "disabled" as const;
  return "enabled" as const;
}

export function formatMerchandiseMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function merchandiseEndpoint(eventId: string, suffix = "") {
  return `/api/events/${encodeURIComponent(eventId)}/merchandise${suffix}`;
}

export function assetEndpoint(eventId: string, suffix = "") {
  return `/api/events/${encodeURIComponent(eventId)}/assets${suffix}`;
}
