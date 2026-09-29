"use client";

import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Megaphone, X } from "lucide-react";
import { splitParagraphs, type AccountBannerAnnouncement } from "@/modules/communications/account-banner-domain";

// Dismissals are per browser and per account, so a shared browser doesn't
// carry one person's dismissals to the next.
const storageKeyFor = (accountId: string) => `imsda:dismissed-announcements:${accountId}`;
const trimAt = 180;

const listeners = new Set<() => void>();
// Used when storage is blocked: the dismissal then lasts for this page view.
const memory = new Map<string, string>();

function snapshot(key: string): string {
  const held = memory.get(key);
  if (held !== undefined) return held;
  try {
    return window.localStorage.getItem(key) ?? "[]";
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

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function writeDismissed(key: string, ids: string[]) {
  const raw = JSON.stringify(ids);
  memory.set(key, raw);
  try {
    window.localStorage.setItem(key, raw);
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
  const text = long ? `${announcement.body.trim().slice(0, trimAt).trimEnd()}…` : announcement.body;
  return (
    <article className={`account-announcement is-${announcement.priority.toLowerCase()}`}>
      <Megaphone size={16} aria-hidden="true" />
      <div>
        <p className="account-announcement-event" translate="no">{announcement.eventName}</p>
        <h2>{announcement.title}</h2>
        {/* Plain text child, exactly as the event hub renders it: no HTML injection. */}
        {splitParagraphs(text).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        {long && <Link href={announcement.href}>Read more</Link>}
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
export function AccountAnnouncementBanner({
  accountId,
  announcements,
}: {
  accountId: string;
  announcements: AccountBannerAnnouncement[];
}) {
  const key = storageKeyFor(accountId);
  const getSnapshot = useCallback(() => snapshot(key), [key]);
  const dismissed = parseDismissed(useSyncExternalStore(subscribe, getSnapshot, () => "[]"));
  const [expanded, setExpanded] = useState(false);

  const visible = announcements.filter((item) => item.priority === "URGENT" || !dismissed.includes(item.id));
  if (visible.length === 0) return null;
  // URGENT announcements are never collapsed. With none, the top one shows
  // and the rest sit behind "N more".
  const urgent = visible.filter((item) => item.priority === "URGENT");
  const others = visible.filter((item) => item.priority !== "URGENT");
  const shown = urgent.length > 0 ? urgent : others.slice(0, 1);
  const collapsed = urgent.length > 0 ? others : others.slice(1);

  function dismiss(id: string) {
    // Keep only ids still in the current list, so old entries don't pile up.
    const current = new Set(announcements.map((item) => item.id));
    writeDismissed(key, [...new Set([...parseDismissed(snapshot(key)), id])].filter((entry) => current.has(entry)));
  }

  return (
    <section className="account-announcements" aria-label="Announcements">
      {shown.map((item) => <BannerItem announcement={item} key={item.id} onDismiss={dismiss} />)}
      {collapsed.length > 0 && (
        <>
          <button
            className="text-button"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show fewer" : `${collapsed.length} more`}
          </button>
          {expanded && collapsed.map((item) => <BannerItem announcement={item} key={item.id} onDismiss={dismiss} />)}
        </>
      )}
    </section>
  );
}
