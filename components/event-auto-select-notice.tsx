import Link from "next/link";

/**
 * Rendered once by `AppShell`, for every workspace page reached without
 * `?event=`, when the layout's `loadWorkspaceEventContext` (the same decision
 * `resolveEventContext` makes for the page) chose the current event automatically —
 * the remembered event, or the nearest published/open one — rather than the
 * account asking for it by id (#465). Names the event and offers a way out,
 * so an automatic choice is never mistaken for the only option.
 */
export function EventAutoSelectNotice({
  eventName,
  switchHref = "/select-event",
}: {
  eventName: string;
  /** Where "Switch event" goes: the picker for staff, `/admin` for system administrators. */
  switchHref?: string;
}) {
  return (
    <div className="inline-notice event-auto-select-notice" role="status">
      <span>Continuing with <strong>{eventName}</strong>.</span>
      <Link className="text-link" href={switchHref}>Switch event</Link>
    </div>
  );
}
