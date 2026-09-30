import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AutoEventInfoCards } from "@/components/auto-event-info-cards";
import { EventInfoCards } from "@/components/event-info-cards";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { listPublishedRegistrationInfoCards } from "@/modules/events/content-repository";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import {
  attendeeProfilePrefill,
  getAttendeeProfile,
} from "@/modules/attendee-accounts/profile-service";
import { getAutoEventInfoCards } from "@/modules/event-info-cards/repository";
import { getPublicRegistrationExperience } from "@/modules/forms/public-repository";

export const dynamic = "force-dynamic";

function serializeDate(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

type PublicRegistrationPageProps = {
  params: Promise<{ eventSlug: string; formSlug: string }>;
};

export async function generateMetadata({
  params,
}: PublicRegistrationPageProps): Promise<Metadata> {
  const { eventSlug, formSlug } = await params;
  const experience = await getPublicRegistrationExperience(eventSlug, formSlug);
  if (!experience) {
    return {
      title: "Registration unavailable",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${experience.form.definition.title} · ${experience.event.name}`,
    description: `Register for ${experience.event.name}.`,
    robots: { index: false, follow: true },
  };
}

export default async function PublicRegistrationPage({
  params,
}: PublicRegistrationPageProps) {
  const { eventSlug, formSlug } = await params;
  const experience = await getPublicRegistrationExperience(eventSlug, formSlug);
  if (!experience) notFound();
  if (
    experience.lifecycle.phase !== "OPEN"
    || experience.lifecycle.capacityDecision === "FULL"
  ) {
    redirect(`/events/${encodeURIComponent(eventSlug)}`);
  }
  const { account } = await getCurrentAttendee();
  const profilePrefill = account
    ? attendeeProfilePrefill(
        await getAttendeeProfile(account.id),
        account.verifiedEmail,
      )
    : {};
  const fields = experience.form.definition.sections.flatMap((section) => section.fields);
  const knownKeys = new Set(fields.map((field) => field.key));
  const scopedPrefill = (scope: "REGISTRATION" | "ATTENDEE") => Object.fromEntries(
    fields
      .filter((field) => field.scope === scope && knownKeys.has(field.key))
      .flatMap((field) => {
        const value = profilePrefill[field.key as keyof typeof profilePrefill];
        return typeof value === "string" && value ? [[field.key, value]] : [];
      }),
  );

  // Auto info cards (#651): club events only. The repository returns null for
  // any other audience, so a general event's registration page is unchanged.
  const autoCards = await getAutoEventInfoCards(eventSlug);
  const editableCards = await listPublishedRegistrationInfoCards(eventSlug);

  return (
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
      initialResponses={scopedPrefill("REGISTRATION")}
      initialAttendeeResponses={scopedPrefill("ATTENDEE")}
      disableDrafts={Boolean(account)}
      topContent={
        editableCards.length > 0 || autoCards ? (
          <>
            <EventInfoCards sections={editableCards} eventSlug={eventSlug} placement="registration" />
            {autoCards ? <AutoEventInfoCards cards={autoCards} /> : null}
          </>
        ) : undefined
      }
    />
  );
}
