"use client";

import { useState } from "react";
import { CalendarPlus, Check, Copy, ExternalLink, Link2 } from "lucide-react";
import type { CalendarSubscribeLinks } from "@/modules/calendar/subscribe";

/** Add-to-calendar buttons for the public calendar feed (#444). */
export function CalendarSubscribe({ links }: { links: CalendarSubscribeLinks }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(links.feedUrl);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(null), 3000);
  }

  return (
    <section aria-labelledby="calendar-subscribe-heading" className="calendar-subscribe-panel" id="subscribe">
      <div>
        <h2 id="calendar-subscribe-heading"><CalendarPlus size={18} aria-hidden="true" /> Add to your calendar</h2>
        <p>Subscribe once and every conference date stays up to date in your own calendar app.</p>
      </div>
      <ul className="calendar-subscribe-buttons">
        <li><a className="secondary-button" href={links.google} rel="noreferrer" target="_blank">Google Calendar <ExternalLink size={14} aria-hidden="true" /></a></li>
        <li><a className="secondary-button" href={links.outlook} rel="noreferrer" target="_blank">Outlook.com <ExternalLink size={14} aria-hidden="true" /></a></li>
        <li><a className="secondary-button" href={links.outlookWork} rel="noreferrer" target="_blank">Outlook (work or school) <ExternalLink size={14} aria-hidden="true" /></a></li>
        <li><a className="secondary-button" href={links.apple}>Apple Calendar</a></li>
        <li><a className="secondary-button" href={links.feedUrl}><Link2 size={14} aria-hidden="true" /> ICS link</a></li>
        <li>
          <button className="secondary-button" onClick={() => void copy()} type="button">
            {copied === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} Copy link
          </button>
        </li>
      </ul>
      <p aria-live="polite" className="calendar-subscribe-status" role="status">
        {copied === "copied" ? "Calendar link copied." : copied === "failed" ? `Copy this link instead: ${links.feedUrl}` : ""}
      </p>
    </section>
  );
}
