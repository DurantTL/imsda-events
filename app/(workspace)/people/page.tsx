import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { LocationFilter } from "@/components/location-filter";
import { PeopleWorkspace } from "@/components/people-workspace";
import { resolveLocationFilter } from "@/modules/event-locations/filter";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";
import {
  CHOICE_FILTER_QUESTION_PARAM,
  CHOICE_FILTER_VALUE_PARAM,
  choiceAnswerCounts,
  filterRegistrationsByChoice,
  listChoiceQuestions,
  matchesForChoice,
  resolveChoiceFilter,
} from "@/modules/registrations/choice-answer-filter";
import { ChoiceAnswerFilter, type ChoiceFilterView } from "@/components/choice-answer-filter";
import { backgroundFlaggedAttendeeIds } from "@/modules/background-checks/repository";
import { staffPageTitles } from "@/components/staff-navigation";

export const metadata: Metadata = { title: staffPageTitles.registrations };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ event?: string; filter?: string; registration?: string; location?: string; answerQuestion?: string; answerValue?: string }> }) {
  const { event: requested, filter, registration, location: requestedLocation, [CHOICE_FILTER_QUESTION_PARAM]: answerQuestion, [CHOICE_FILTER_VALUE_PARAM]: answerValue } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("VIEW_SENSITIVE_DATA")) {
    return <AccessRestricted title="People records are restricted" detail="Your event role does not include access to attendee names, contact details, or registration records." />;
  }
  // Each location on its own, or all combined (#413).
  const { locations, locationId } = await resolveLocationFilter(event.id, requestedLocation);
  const [allRegistrations, flagged] = await Promise.all([listRegistrations(event.id, { locationId }), backgroundFlaggedAttendeeIds(event.id)]);
  // Filter by a choice answer (#739), on the server: only structured, non-sensitive
  // choice questions resolve here, whatever the URL says.
  const choice = resolveChoiceFilter(allRegistrations, { question: answerQuestion, value: answerValue });
  const registrations = choice ? filterRegistrationsByChoice(allRegistrations, choice) : allRegistrations;
  const choiceView: ChoiceFilterView = {
    questions: listChoiceQuestions(allRegistrations).map((question) => ({ id: question.id, label: question.label })),
    selected: choice ? {
      id: choice.question.id,
      label: choice.question.label,
      scope: choice.question.scope,
      value: choice.value,
      ...choiceAnswerCounts(allRegistrations, choice.question),
      matches: choice.value ? matchesForChoice(allRegistrations, choice.question, choice.value) : [],
    } : null,
  };
  return <>
    <LocationFilter basePath="/people" locations={locations} params={{ event: event.id, filter, [CHOICE_FILTER_QUESTION_PARAM]: choice?.question.id, [CHOICE_FILTER_VALUE_PARAM]: choice?.value ?? undefined }} selectedId={locationId} />
    <ChoiceAnswerFilter eventId={event.id} view={choiceView} carry={{ filter, location: locationId ?? undefined }} canExport={permissions.includes("VIEW_REPORTS") && permissions.includes("VIEW_SENSITIVE_DATA")} />
    <PeopleWorkspace key={`${event.id}:${choice?.question.id ?? ""}:${choice?.value ?? ""}`} eventId={event.id} eventSlug={event.slug} eventTimezone={event.timezone} waitlistEnabled={event.waitlistEnabled} initialRegistrations={registrations} canEdit={permissions.includes("MANAGE_REGISTRATION")} canEmail={permissions.includes("MANAGE_COMMUNICATIONS")} initialFilter={filter} initialRegistrationId={registration} backgroundFlaggedAttendeeIds={[...flagged]} matchingPersonFilter={Boolean(choice?.value)} locationId={locationId} />
  </>;
}
