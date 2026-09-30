import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { EventInfoCards } from "@/components/event-info-cards";
import { GroupRegistrationFlow } from "@/components/group-registration-flow";
import { listPublishedRegistrationInfoCards } from "@/modules/events/content-repository";
import { GROUP_LABEL } from "@/modules/group-registrations/domain";
import { GroupRegistrationError, getGroupRegistrationExperience } from "@/modules/group-registrations/repository";

export const dynamic = "force-dynamic";

type GroupRegistrationPageProps = { params: Promise<{ eventSlug: string }> };

export const metadata: Metadata = {
  title: `${GROUP_LABEL} registration`,
  robots: { index: false, follow: false },
};

async function load(eventSlug: string) {
  try {
    return await getGroupRegistrationExperience(eventSlug);
  } catch (error) {
    if (error instanceof GroupRegistrationError && error.code === "EVENT_NOT_FOUND") return null;
    throw error;
  }
}

/**
 * /register/<eventSlug>/group (#650): people who are not in a club register
 * through one contact, on a club event. Labelled only "Group". No payment: the
 * contact is billed after the event.
 */
export default async function GroupRegistrationPage({ params }: GroupRegistrationPageProps) {
  const { eventSlug } = await params;
  const experience = await load(eventSlug);
  if (!experience) notFound();
  if (experience.problem || !experience.event || !experience.experience) {
    return (
      <main className="public-registration-page">
        <header className="public-registration-header">
          <div className="public-registration-header-inner">
            <Link className="public-registration-brand public-event-brand-link" href={`/events/${encodeURIComponent(eventSlug)}`}>
              <BrandMark /><span><strong>IMSDA</strong><small>Events</small></span>
            </Link>
          </div>
        </header>
        <section className="public-manage-card public-group-state">
          <p className="public-registration-eyebrow">{GROUP_LABEL}</p>
          <h1>{GROUP_LABEL} registration isn&apos;t available yet</h1>
          <p>The event team hasn&apos;t finished setting up {GROUP_LABEL.toLowerCase()} registration. Please check back soon, or contact the event team.</p>
          <p><Link className="public-event-not-found-link" href={`/events/${encodeURIComponent(eventSlug)}`}>Back to the event</Link></p>
        </section>
      </main>
    );
  }
  if (experience.experience.lifecycle.phase !== "OPEN" || experience.experience.lifecycle.capacityDecision === "FULL") {
    redirect(`/events/${encodeURIComponent(eventSlug)}`);
  }
  const editableCards = await listPublishedRegistrationInfoCards(eventSlug);
  return (
    <GroupRegistrationFlow
      eventSlug={eventSlug}
      topContent={
        editableCards.length > 0
          ? <EventInfoCards sections={editableCards} eventSlug={eventSlug} placement="registration" />
          : undefined
      }
      ready={{
        ...experience,
        event: experience.event,
        experience: experience.experience,
        billingNotice: experience.billingNotice ?? "You'll be billed after the event.",
      }}
    />
  );
}
