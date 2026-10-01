import { LockKeyhole } from "lucide-react";
import { formatClubFormAnswer, RESTRICTED_LABEL } from "@/modules/club-forms/domain";
import type { ClubFormSubmissionView as SubmissionView } from "@/modules/club-forms/submissions";
import { isFieldVisible } from "@/modules/forms/definition";

const statusLabel = { DRAFT: "Draft", SUBMITTED: "Submitted" } as const;

function submittedOn(value: string | null) {
  if (!value) return "Not submitted";
  return new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}

/**
 * One filled-in club form, laid out to print cleanly on a page for the club's
 * paper files (#610). A sensitive answer the viewer may not read shows
 * "Restricted" whether or not it was answered, so a blank tells nothing.
 * Nothing here decides access: the submission it is given was already
 * filtered by `getSubmissionForViewer`.
 */
export function ClubFormSubmissionView({ submission }: { submission: SubmissionView }) {
  const restricted = new Set(submission.restrictedKeys);
  const { definition, sectionNotes } = submission.template;
  const hidden = new Set(submission.template.hiddenFieldKeys ?? []);
  // A field hidden from new forms (#712) shows only when it holds an answer (or may hold one this viewer cannot read).
  const holdsNothing = (key: string) => hidden.has(key)
    && (restricted.has(key) ? !submission.hasSensitiveAnswers : submission.answers[key] === undefined);

  return (
    <article className="club-form-sheet">
      <header className="club-form-sheet-header">
        <p className="public-registration-eyebrow">{submission.organization.name} · Club year {submission.clubYear}</p>
        <h2>{definition.title}</h2>
        {definition.description && <p>{definition.description}</p>}
        <p className="club-form-sheet-meta">
          <span>{statusLabel[submission.status]}{submission.status === "SUBMITTED" ? ` on ${submittedOn(submission.submittedAt)}` : ""}</span>
          {submission.subjectName && <span translate="no">For {submission.subjectName}</span>}
          <span>{submission.enteredVia === "LINK" ? "Filled in through a private link" : "Filled in by the club"}</span>
        </p>
        {restricted.size > 0 && (
          <p className="club-form-restricted-note">
            <LockKeyhole aria-hidden="true" size={13} /> Sensitive answers are shown as {RESTRICTED_LABEL} for your role.
          </p>
        )}
      </header>

      {submission.template.printLayout === "PASSENGER_LIST"
        ? <PassengerList restricted={restricted} submission={submission} />
        : definition.sections.map((section) => {
          const fields = section.fields.filter((field) => isFieldVisible(field, submission.answers) && !holdsNothing(field.key));
          if (fields.length === 0) return null;
          return (
            <section className="club-form-sheet-section" key={section.id}>
              <h3>{section.title}</h3>
              {(sectionNotes[section.id] ?? []).map((note, index) => <p className="club-form-note" key={index}>{note}</p>)}
              <dl className="club-form-answers">
                {fields.map((field) => (
                  <div key={field.id}>
                    <dt>{field.label}</dt>
                    <dd translate="no">
                      {restricted.has(field.key)
                        ? <span className="club-form-restricted">{RESTRICTED_LABEL}</span>
                        : formatClubFormAnswer(field, submission.answers[field.key]) || <span className="club-form-blank">—</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
    </article>
  );
}

const rollCalls = [1, 2, 3, 4, 5] as const;

function PassengerList({ submission, restricted }: { submission: SubmissionView; restricted: Set<string> }) {
  const { definition, sectionNotes } = submission.template;
  const answer = (key: string) => {
    const value = submission.answers[key];
    return typeof value === "string" ? value : "";
  };
  const contacts = definition.sections[0];
  // A row counts if anything was written on it: a passenger with an emergency contact but no name stays on the sheet.
  const passengers = Array.from({ length: 20 }, (_, index) => index + 1)
    .filter((n) => answer(`passenger_${n}_name`) || answer(`passenger_${n}_phone`) || answer(`passenger_${n}_emergency_contact`));
  return (
    <>
      <section className="club-form-sheet-section">
        <h3>{contacts.title}</h3>
        {(sectionNotes[contacts.id] ?? []).map((note, index) => <p className="club-form-note" key={index}>{note}</p>)}
        <dl className="club-form-answers">
          {contacts.fields.map((field) => (
            <div key={field.id}>
              <dt>{field.label}</dt>
              <dd translate="no">{formatClubFormAnswer(field, submission.answers[field.key]) || <span className="club-form-blank">—</span>}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="club-form-sheet-section">
        <h3>Passengers and roll call</h3>
        <table className="club-form-roll-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Passenger</th>
              <th scope="col">Phone</th>
              <th scope="col">Emergency contact</th>
              {rollCalls.map((call) => <th className="club-form-roll-cell" key={call} scope="col">{call}</th>)}
            </tr>
          </thead>
          <tbody>
            {passengers.length === 0 && <tr><td colSpan={4 + rollCalls.length}>No passengers listed.</td></tr>}
            {passengers.map((n, row) => (
              <tr key={n}>
                <td>{row + 1}</td>
                <td translate="no">{answer(`passenger_${n}_name`) || <span className="club-form-blank">(no name)</span>}</td>
                <td translate="no">{answer(`passenger_${n}_phone`)}</td>
                <td translate="no">
                  {restricted.has(`passenger_${n}_emergency_contact`)
                    ? <span className="club-form-restricted">{RESTRICTED_LABEL}</span>
                    : answer(`passenger_${n}_emergency_contact`)}
                </td>
                {rollCalls.map((call) => <td className="club-form-roll-cell" key={call}><span className="club-form-roll-box" /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
