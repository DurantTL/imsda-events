"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { Megaphone, X } from "lucide-react";
import type { AccountBannerAnnouncement } from "@/modules/communications/account-banner-domain";

const storageKey = "imsda:dismissed-announcements";
const trimAt = 180;

const listeners = new Set<() => void>();

function readRaw(): string {
  try {
    return window.localStorage.getItem(storageKey) ?? "[]";
  } catch {
    return "[]";
  }
}

function parseDismissed(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// Dismissals are per browser. When storage is blocked they last for this page
// view only, via the in-memory copy.
let memoryRaw: string | null = null;

function snapshot(): string {
  return memoryRaw ?? readRaw();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function writeDismissed(ids: string[]) {
  const raw = JSON.stringify(ids);
  memoryRaw = raw;
  try {
    window.localStorage.setItem(storageKey, raw);
  } catch {
    // Storage can be blocked; the in-memory copy still hides it for now.
  }
  listeners.forEach((listener) => listener());
}

function BannerItem({
  announcement,
  onDismiss,
}: {
  announcement: AccountBannerAnnouncement;
  onDismiss: (id: string) => void;
}) {
  const long = announcement.body.length > trimAt;
  const body = long ? `${announcement.body.slice(0, trimAt).trimEnd()}…` : announcement.body;
  return (
    <article className={`account-announcement is-${announcement.priority.toLowerCase()}`}>
      <Megaphone size={16} aria-hidden="true" />
      <div>
        <p className="account-announcement-event" translate="no">{announcement.eventName}</p>
        <h2>{announcement.title}</h2>
        {/* Plain text child, exactly as the event hub renders it: no HTML injection. */}
        <p>{body}</p>
        {long && <Link href={`/account/events/${announcement.eventSlug}`}>Read more</Link>}
      </div>
      {announcement.priority !== "URGENT" && (
        <button
          className="icon-button"
          type="button"
          aria-label={`Dismiss announcement: ${announcement.title}`}
          onClick={() => onDismiss(announcement.id)}
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </article>
  );
}

/**
 * Published event announcements at the top of the account portal (#590). The
 * server has already decided what this account may see; this only orders the
 * presentation and remembers per-browser dismissals. URGENT never dismisses.
 */
export function AccountAnnouncementBanner({ announcements }: { announcements: AccountBannerAnnouncement[] }) {
  const dismissed = parseDismissed(useSyncExternalStore(subscribe, snapshot, () => "[]"));
  const [expanded, setExpanded] = useState(false);

  const visible = announcements.filter((item) => item.priority === "URGENT" || !dismissed.includes(item.id));
  if (visible.length === 0) return null;
  const [top, ...rest] = visible;

  function dismiss(id: string) {
    writeDismissed([...new Set([...parseDismissed(snapshot()), id])]);
  }

  return (
    <section className="account-announcements" aria-label="Announcements">
      <BannerItem announcement={top} onDismiss={dismiss} />
      {rest.length > 0 && (
        <>
          <button
            className="text-button"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show fewer" : `${rest.length} more`}
          </button>
          {expanded && rest.map((item) => <BannerItem announcement={item} key={item.id} onDismiss={dismiss} />)}
        </>
      )}
    </section>
  );
}
