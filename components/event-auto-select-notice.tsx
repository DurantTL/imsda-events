import Link from "next/link";

/**
 * Shown when `resolveEventContext` chose the current event automatically —
 * the remembered event, or the nearest published/open one — rather than the
 * account asking for it by id (#465). Names the event and offers a way out,
 * so an automatic choice is never mistaken for the only option.
 */
export function EventAutoSelectNotice({ eventName }: { eventName: string }) {
  return (
    <div className="inline-notice event-auto-select-notice" role="status">
      <span>Continuing with <strong>{eventName}</strong>.</span>
      <Link className="text-link" href="/select-event">Switch event</Link>
    </div>
  );
}
