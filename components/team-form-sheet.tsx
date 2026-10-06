import type { TeamFormModel } from "@/modules/club-teams/team-form";
import { formatCalendarDate } from "@/modules/club-registrations/domain";

/** A labelled line: the value written on it when the form is filled in, a blank rule when it is not. */
function Line({ label, value, wide = false }: { label: string; value?: string; wide?: boolean }) {
  return (
    <div className={`team-form-field${wide ? " team-form-wide" : ""}`}>
      <span className="team-form-label">{label}</span>
      <span className="team-form-line" translate="no">{value}</span>
    </div>
  );
}

/**
 * The Pathfinder Bible Experience participating form (4-1), on one letter page (#809): filled in from a team's
 * registration, or blank for a club that mails or emails the paper. The wording and dates come from `buildTeamForm`.
 * Screen styles are a framed sheet; the print styles make it the page.
 */
export function TeamFormSheet({ model }: { model: TeamFormModel }) {
  const filled = model.filled;
  const coordinator = filled?.coordinator;
  const confirmedOn = filled?.confirmedOn ? formatCalendarDate(filled.confirmedOn) : "";
  return (
    <article className="team-form-sheet" aria-label={`${model.conference} ${model.title}`}>
      <header className="team-form-header">
        <p className="team-form-due">{model.dueNote}</p>
        <div>
          <h1>{model.conference}</h1>
          <h2>{model.title}</h2>
        </div>
        <p className="team-form-number">{model.formNumber}</p>
      </header>
      {model.booksLine && <p className="team-form-books">{model.booksLine}</p>}
      <p className="team-form-text">{model.datesParagraph}</p>

      <section>
        <h3>The Team</h3>
        <p className="team-form-text">{model.teamParagraph}</p>
      </section>

      <section>
        <h3>The Team&apos;s Coordinator</h3>
        <p className="team-form-text">{model.coordinatorIntro}</p>
        <p className="team-form-subheading">Contact Person/Team Coordinator</p>
        <div className="team-form-grid">
          <Line label="Name:" value={coordinator?.name} wide />
          <Line label="Address:" value={coordinator?.address} wide />
          <Line label="City:" value={coordinator?.city} />
          <Line label="State:" value={coordinator?.state} />
          <Line label="Zip:" value={coordinator?.zip} />
          <Line label="Phone:" value={coordinator?.phone} />
          <Line label="Email:" value={coordinator?.email} wide />
          <Line label="Club Name:" value={filled?.clubName} />
          <Line label="Church:" value={filled?.church ?? ""} />
          <Line label="Team Name:" value={filled?.teamName} wide />
          {(filled?.areaLocation || !filled) && <Line label="Area PBE (Missouri or Iowa):" value={filled?.areaLocation ?? ""} wide />}
          <Line label="Partner club (joint team):" value={filled?.partnerClub} wide />
        </div>
      </section>

      <section>
        <h3>Team Members</h3>
        <ol className="team-form-members">
          {model.memberSlots.map((slot) => (
            <li key={slot.number}><span className="team-form-number-label">{slot.number}.</span><span className="team-form-line" translate="no">{slot.name}</span></li>
          ))}
        </ol>
        <div className="team-form-grid">
          <Line label="Alternate Member:" value={model.alternate} wide />
          <Line label="Coaches:" value={model.coaches.join(", ")} wide />
        </div>
      </section>

      <section className="team-form-signature">
        {filled ? (
          <p className="team-form-text">
            <span className="team-form-box" aria-hidden="true">{filled.confirmed ? "☑" : "☐"}</span>{" "}
            <strong>Club director&apos;s confirmation{filled.confirmed ? "" : " (not recorded)"}:</strong> {model.confirmationText}
            {confirmedOn && <> Confirmed online on {confirmedOn}.</>}
          </p>
        ) : (
          <>
            <p className="team-form-text">{model.confirmationText}</p>
            <div className="team-form-grid">
              <Line label="Club Director's Signature:" wide />
              <Line label="Date:" />
            </div>
          </>
        )}
        <p className="team-form-mail">{model.mailLine}</p>
      </section>

      <p className="team-form-release">{model.releaseText}</p>
      {filled && (
        <p className="team-form-release-answer">
          <strong>Release understood and agreed:</strong> {filled.releaseAnswer || "Not recorded"}
        </p>
      )}
      <footer className="team-form-footer">
        {model.contactLines.map((line) => <p key={line}>{line}</p>)}
        <p className="team-form-number">{model.formNumber}</p>
      </footer>
    </article>
  );
}
