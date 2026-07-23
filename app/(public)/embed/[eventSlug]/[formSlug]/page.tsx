import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { getPublicRegistrationExperience } from "@/modules/forms/public-repository";

export const dynamic = "force-dynamic";

type EmbeddedRegistrationPageProps = {
  params: Promise<{ eventSlug: string; formSlug: string }>;
};

export const metadata: Metadata = {
  title: "Embedded registration",
  robots: { index: false, follow: false },
};

function serializeDate(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

export default async function EmbeddedRegistrationPage({
  params,
}: EmbeddedRegistrationPageProps) {
  const { eventSlug, formSlug } = await params;
  const experience = await getPublicRegistrationExperience(eventSlug, formSlug);
  if (!experience) notFound();

  if (
    experience.lifecycle.phase !== "OPEN"
    || experience.lifecycle.capacityDecision === "FULL"
  ) {
    return (
      <main className="public-registration-embed-state">
        <BrandMark />
        <p className="public-registration-eyebrow">IMSDA Events</p>
        <h1>Online registration is not available here</h1>
        <p>Open the event page for current dates, availability, waitlist information, and help.</p>
        <Link
          className="primary-button"
          href={`/events/${encodeURIComponent(eventSlug)}`}
          target="_top"
        >
          View event registration
        </Link>
      </main>
    );
  }

  return (
    <div className="public-registration-embed">
      <PublicRegistrationForm
        event={{
          ...experience.event,
          startsAt: serializeDate(experience.event.startsAt),
          endsAt: serializeDate(experience.event.endsAt),
        }}
        form={experience.form}
        choiceUsage={experience.choiceUsage}
        pricingDate={experience.pricingDate}
        lifecycle={experience.lifecycle}
      />
    </div>
  );
}
