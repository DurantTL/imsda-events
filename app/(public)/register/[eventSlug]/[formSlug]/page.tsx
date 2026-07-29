import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import {
  attendeeProfilePrefill,
  getAttendeeProfile,
} from "@/modules/attendee-accounts/profile-service";
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
    />
  );
}
