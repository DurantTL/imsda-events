import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EventInfoCards } from "@/components/event-info-cards";
import { GroupRegistrationFlow } from "@/components/group-registration-flow";
import { listPublishedRegistrationInfoCards } from "@/modules/events/content-repository";
import { GroupRegistrationError, getGroupRegistrationExperience } from "@/modules/group-registrations/repository";

export const dynamic = "force-dynamic";

type GroupRegistrationPageProps = { params: Promise<{ eventSlug: string }> };

export const metadata: Metadata = {
  title: "Register as a group or individual",
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
        <section className="public-manage-card" style={{ maxWidth: 640, margin: "48px auto" }}>
          <p className="public-registration-eyebrow">Group registration</p>
          <h1>Group registration isn&apos;t available yet</h1>
          <p>The event team hasn&apos;t finished setting up registration for groups. Please check back soon, or contact the event team.</p>
          <p><Link href={`/events/${encodeURIComponent(eventSlug)}`}>Back to the event</Link></p>
        </section>
      </main>
    );
  }
  if (experience.experience.lifecycle.phase !== "OPEN" || experience.experience.lifecycle.capacityDecision === "FULL") {
    redirect(`/events/${encodeURIComponent(eventSlug)}`);
  }
  return (
    <GroupRegistrationFlow
      eventSlug={eventSlug}
      topContent={
        <EventInfoCards
          sections={await listPublishedRegistrationInfoCards(eventSlug)}
          eventSlug={eventSlug}
          placement="registration"
        />
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
