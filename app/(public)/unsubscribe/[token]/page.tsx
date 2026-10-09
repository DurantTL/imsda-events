import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { getPrisma } from "@/lib/prisma";
import { getAnnouncementOptOutState, resolveUnsubscribeToken } from "@/modules/communications/email-preferences-repository";
import {
  maskEmailAddress,
  unsubscribeApiPath,
} from "@/modules/communications/email-preferences";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Email preferences",
  description: "Choose which IMSDA Events announcements you receive.",
  robots: { index: false, follow: false, nocache: true },
};

const doneMessages: Record<string, string> = {
  event: "You will not get more announcements for this event.",
  all: "You will not get announcements for any IMSDA event.",
  resubscribed: "You will get announcements again.",
};

/**
 * The page behind an announcement's unsubscribe link (#838). Reading it changes nothing: each choice is a separate
 * button that POSTs to the signed endpoint. It shows the address masked and the event's name, and nothing about any
 * registration. Registration confirmations, receipts, balance reminders, waitlist and transfer notices, and safety
 * or schedule-change notices are not announcements and keep coming; the page says so.
 */
export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { token } = await params;
  const subject = await resolveUnsubscribeToken(token);
  if (!subject) notFound();
  const event = await getPrisma().event.findUnique({ where: { id: subject.eventId }, select: { name: true } });
  if (!event) notFound();
  const state = await getAnnouncementOptOutState(subject.email, subject.eventId);
  const requestedDone = (await searchParams).done;
  const done = typeof requestedDone === "string" ? doneMessages[requestedDone] : undefined;
  const optedOut = state.event || state.all;
  const action = unsubscribeApiPath(token);

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <span><strong>IMSDA</strong><small>Events</small></span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">Email preferences</p>
          <h1>Event announcements</h1>
          <p>
            Settings for <strong>{maskEmailAddress(subject.email)}</strong>, for announcements from {event.name}.
          </p>
        </div>
        {done && <p className="inline-notice success" role="status">{done}</p>}
        <p role="status">
          {state.all
            ? "You are not getting announcements for any IMSDA event."
            : state.event
              ? "You are not getting announcements for this event."
              : "You are getting announcements for this event."}
        </p>
        {!state.event && !state.all && (
          <form method="post" action={action}>
            <input type="hidden" name="action" value="event" />
            <button className="primary-button" type="submit">Stop announcements for this event</button>
          </form>
        )}
        {!state.all && (
          <form method="post" action={action}>
            <input type="hidden" name="action" value="all" />
            <button className="secondary-button" type="submit">Stop all IMSDA Events announcements</button>
          </form>
        )}
        {optedOut && (
          <form method="post" action={action}>
            <input type="hidden" name="action" value="resubscribe" />
            <button className="secondary-button" type="submit">Start getting announcements again</button>
          </form>
        )}
        <p className="quiet-copy">
          This only covers announcements. You will still get messages about your registration: confirmations, receipts,
          balance reminders, waitlist and transfer notices, and safety or schedule changes.
        </p>
      </section>
    </main>
  );
}
