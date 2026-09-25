"use client";

import Link from "next/link";
import { CalendarDays, ChevronRight } from "lucide-react";
import { rememberLastUsedEvent } from "@/components/remember-last-event";

export type SelectEventOption = { id: string; name: string; dates: string };

/**
 * The `/select-event` choices (#108 queue 1). Ordinary links, so they work
 * and read as links for keyboards and screen readers; activating one also
 * records it as the last-used event. Prefetching records nothing.
 */
export function SelectEventList({ events }: { events: readonly SelectEventOption[] }) {
  return (
    <ul className="select-event-list">
      {events.map((event) => (
        <li key={event.id}>
          <Link
            className="select-event-option"
            href={`/overview?event=${encodeURIComponent(event.id)}`}
            onClick={() => rememberLastUsedEvent(event.id)}
            onAuxClick={() => rememberLastUsedEvent(event.id)}
          >
            <span>
              <strong>{event.name}</strong>
              <small><CalendarDays aria-hidden="true" size={13} /> {event.dates}</small>
            </span>
            <ChevronRight aria-hidden="true" size={17} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
