import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AutoEventInfoCards } from "@/components/auto-event-info-cards";
import { clubDirectorSignInNotice } from "@/modules/club-registrations/club-notices";
import { ClubDirectorSignInNotice } from "@/components/club-director-sign-in-notice";
import { EventInfoCards } from "@/components/event-info-cards";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { listPublishedRegistrationInfoCards } from "@/modules/events/content-repository";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import {
  attendeeProfilePrefill,
  getAttendeeProfile,
  withoutPersonalDetails,
} from "@/modules/attendee-accounts/profile-service";
import { attendeeSecondStepPending } from "@/modules/attendee-accounts/portal-second-step";
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
  const { account, via } = await getCurrentAttendee();
  // The address and emergency contact follow the profile API (#745): only the
  // attendee's own session, with any second step finished, gets them prefilled.
  const mayPrefillPersonalDetails = account
    ? via === "attendee" && !(await attendeeSecondStepPending())
    : false;
  const profilePrefill = account
    ? attendeeProfilePrefill(
        mayPrefillPersonalDetails
          ? await getAttendeeProfile(account.id)
          : withoutPersonalDetails(await getAttendeeProfile(account.id)),
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
        if (field.type === "ADDRESS") {
          return value && typeof value === "object" ? [[field.key, value]] : [];
        }
        if (typeof value !== "string" || !value) return [];
        // A choice field only takes one of its own options, so a profile
        // country that isn't listed is left blank rather than breaking it.
        if (field.type === "SELECT" && field.options.length > 0 && !field.options.includes(value)) return [];
        return [[field.key, value]];
      }),
  );

  // Auto info cards (#651): club events only. The repository returns null for
  // any other audience, so a general event's registration page is unchanged.
  const autoCards = await getAutoEventInfoCards(eventSlug);
  // The page only renders while registration is open (it redirects otherwise).
  const clubNoticeEvent = {
    audience: experience.event.audience,
    billingMode: experience.event.billingMode,
    slug: experience.event.slug,
    registrationOpen: true,
  };
  const clubNotice = clubDirectorSignInNotice(clubNoticeEvent);
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
      lodging={experience.lodging}
      initialResponses={scopedPrefill("REGISTRATION")}
      initialAttendeeResponses={scopedPrefill("ATTENDEE")}
      disableDrafts={Boolean(account)}
      topContent={
        editableCards.length > 0 || autoCards || clubNotice ? (
          <>
            <ClubDirectorSignInNotice event={clubNoticeEvent} />
            <EventInfoCards sections={editableCards} eventSlug={eventSlug} placement="registration" />
            {autoCards ? <AutoEventInfoCards cards={autoCards} /> : null}
          </>
        ) : undefined
      }
    />
  );
}
