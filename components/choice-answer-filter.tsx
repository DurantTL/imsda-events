import Link from "next/link";
import { Download, ListFilter, X } from "lucide-react";
import {
  CHOICE_FILTER_QUESTION_PARAM,
  CHOICE_FILTER_VALUE_PARAM,
  type ChoiceCount,
  type ChoiceMatch,
} from "@/modules/registrations/choice-answer-filter";

export type ChoiceFilterView = {
  questions: Array<{ id: string; label: string }>;
  selected: {
    id: string;
    label: string;
    scope: "REGISTRATION" | "ATTENDEE";
    value: string | null;
    choices: ChoiceCount[];
    unanswered: number;
    /** Stored values the question does not offer; counted, never named. */
    other: number;
    matches: ChoiceMatch[];
  } | null;
};

/**
 * "Filter by answer" for the People & registrations list (#739). Server
 * rendered with plain links and a GET form, so the filter lives in the URL,
 * works before the page's script loads, and combines with the page's other
 * parameters (event, status filter, location). The server already narrowed
 * the list below it; this only shows the choices, their counts, and who chose
 * the selected one.
 */
export function ChoiceAnswerFilter({
  eventId,
  view,
  carry,
  canExport,
}: {
  eventId: string;
  view: ChoiceFilterView;
  /** Other URL parameters to keep (status filter, location). */
  carry: Record<string, string | undefined>;
  /** VIEW_REPORTS and VIEW_SENSITIVE_DATA: the filtered export needs both, so others get no button that would refuse. */
  canExport: boolean;
}) {
  if (view.questions.length === 0) return null;
  const { selected } = view;

  function query(extra: Record<string, string | null>) {
    const params = new URLSearchParams({ event: eventId });
    for (const [key, value] of Object.entries(carry)) if (value) params.set(key, value);
    for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
    return params;
  }
  const clearHref = `/people?${query({}).toString()}`;
  const exportHref = canExport && selected?.value
    ? `/api/events/${encodeURIComponent(eventId)}/exports/registrations?${new URLSearchParams([
        ...(carry.location ? [["location", carry.location]] : []),
        [CHOICE_FILTER_QUESTION_PARAM, selected.id],
        [CHOICE_FILTER_VALUE_PARAM, selected.value],
      ]).toString()}`
    : null;
  const unit = selected?.scope === "ATTENDEE" ? "people" : "registrations";
  const single = selected?.matches.length === 1;
  const resultNoun = selected?.scope === "ATTENDEE" ? (single ? "person" : "people") : (single ? "registration" : "registrations");

  return (
    <section className="panel choice-filter" aria-labelledby="choice-filter-title">
      <div className="choice-filter-head">
        <h3 id="choice-filter-title"><ListFilter aria-hidden="true" size={17} /> Filter by answer</h3>
        <form action="/people" method="get" className="choice-filter-form">
          <input type="hidden" name="event" value={eventId} />
          {Object.entries(carry).map(([key, value]) => value ? <input key={key} type="hidden" name={key} value={value} /> : null)}
          <label>
            <span className="sr-only">Question</span>
            <select name={CHOICE_FILTER_QUESTION_PARAM} defaultValue={selected?.id ?? ""}>
              <option value="">Choose a question…</option>
              {view.questions.map((question) => <option key={question.id} value={question.id}>{question.label}</option>)}
            </select>
          </label>
          <button className="secondary-button" type="submit">Show choices</button>
          {selected && <Link className="text-button" href={clearHref}><X aria-hidden="true" size={14} /> Clear</Link>}
        </form>
      </div>
      {selected && (
        <>
          <p className="choice-filter-note">
            Counts are {unit} on active registrations. Open a count to list them.
          </p>
          <ul className="choice-filter-counts" aria-label={`${selected.label} choices`}>
            {selected.choices.map((choice) => (
              <li key={choice.value}>
                <Link
                  aria-current={selected.value === choice.value ? "true" : undefined}
                  className={selected.value === choice.value ? "choice-chip active" : "choice-chip"}
                  href={`/people?${query({ [CHOICE_FILTER_QUESTION_PARAM]: selected.id, [CHOICE_FILTER_VALUE_PARAM]: choice.value }).toString()}`}
                >
                  <span>{choice.label}</span><strong>{choice.count}</strong>
                </Link>
              </li>
            ))}
            {selected.other > 0 && <li><span className="choice-chip muted"><span>Other / no longer offered</span><strong>{selected.other}</strong></span></li>}
            {selected.unanswered > 0 && <li><span className="choice-chip muted"><span>No answer</span><strong>{selected.unanswered}</strong></span></li>}
          </ul>
          {selected.value && (
            <div className="choice-filter-results">
              <div className="choice-filter-results-head">
                <strong>{selected.label}: {selected.choices.find((choice) => choice.value === selected.value)?.label ?? selected.value} · {selected.matches.length} {resultNoun}</strong>
                {exportHref && <a className="secondary-button" href={exportHref}><Download aria-hidden="true" size={16} /> Export this list (CSV)</a>}
              </div>
              {selected.matches.length === 0 ? <p className="choice-filter-note">Nobody has chosen this yet.</p> : (
                <ul className="choice-filter-list">
                  {selected.matches.map((match) => (
                    <li key={`${match.registrationId}:${match.attendeeId ?? "registration"}`}>
                      <Link href={`/people?${query({ registration: match.registrationId, [CHOICE_FILTER_QUESTION_PARAM]: selected.id, [CHOICE_FILTER_VALUE_PARAM]: selected.value })
                        .toString()}`}>
                        <strong>{match.personName}</strong>
                        <small>{match.confirmationCode}</small>
                        <span className="choice-chip static">{match.value}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
