"use client";

import { useEffect, useState } from "react";
import { countdownPhase, splitRemaining } from "@/modules/events/content-countdown";

/**
 * A countdown that is correct without script and better with it.
 *
 * The server renders `initialPhase` and a static, readable date, so the page
 * is complete before anything loads. After hydration the figures tick once a
 * second and the heading flips to "Happening now" or "This event has ended"
 * when the time comes. The ticking figures are hidden from screen readers; the
 * static line (`targetLabel`) carries the date for them.
 */
export function EventCountdown({
  targetMs,
  endMs,
  targetLabel,
  isEventStart,
  initialNowMs,
}: {
  targetMs: number;
  endMs: number | null;
  /** The target as a full date and time in the event's time zone. */
  targetLabel: string;
  /** True for the event's own start, where "Happening now" and "ended" make sense. */
  isEventStart: boolean;
  /** The server's clock at render, so the first client render matches it. */
  initialNowMs: number;
}) {
  const [nowMs, setNowMs] = useState(initialNowMs);

  useEffect(() => {
    // Catch up to the browser's clock right after hydration, then tick.
    const first = window.setTimeout(() => setNowMs(Date.now()), 0);
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  const { phase, remainingMs } = countdownPhase(nowMs, targetMs, isEventStart ? endMs : null);
  const parts = splitRemaining(remainingMs);

  if (phase === "during") {
    return (
      <div className="event-countdown is-live">
        <p className="event-countdown-status" role="status">Happening now</p>
        <p className="event-countdown-date">Started {targetLabel}</p>
      </div>
    );
  }
  if (phase === "after") {
    return (
      <div className="event-countdown is-over">
        <p className="event-countdown-status" role="status">
          {isEventStart ? "This event has ended" : "This date has passed"}
        </p>
        <p className="event-countdown-date">{targetLabel}</p>
      </div>
    );
  }
  return (
    <div className="event-countdown">
      <p className="event-countdown-date">{targetLabel}</p>
      <ul className="event-countdown-figures" aria-hidden="true">
        {([
          ["Days", parts.days],
          ["Hours", parts.hours],
          ["Minutes", parts.minutes],
          ["Seconds", parts.seconds],
        ] as const).map(([unit, value]) => (
          <li key={unit}>
            <strong>{String(value).padStart(2, "0")}</strong>
            <span>{unit}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
