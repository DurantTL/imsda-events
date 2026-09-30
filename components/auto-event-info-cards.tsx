import { formatCardMoney, type EventInfoCards } from "@/modules/event-info-cards/domain";

/**
 * The auto-built cards of a club event (#651). Server-rendered, plain text
 * only: every value is escaped by React and nothing here takes markup.
 */

export function AutoEventHeader({
  header,
  timeLabel,
  statusLabel,
  introLine,
}: {
  header: EventInfoCards["header"];
  /** Time range line, e.g. "Friday, 4:00 PM CDT – Sunday, 12:00 PM CDT". */
  timeLabel?: string;
  /** Registration state, e.g. "Registration open". */
  statusLabel?: string;
  /** The lifecycle sentence that used to sit under the title. */
  introLine?: string;
}) {
  return (
    <section className="auto-info-header" aria-labelledby="auto-info-title">
      <p className="public-registration-eyebrow">{header.eyebrow}</p>
      <h1 id="auto-info-title">{header.title}</h1>
      {header.tagline && <p className="auto-info-tagline">{header.tagline}</p>}
      {header.meta && <p className="auto-info-meta">{header.meta}</p>}
      {timeLabel && <p className="auto-info-meta">{timeLabel}</p>}
      {header.subtitle && <p className="auto-info-subtitle">{header.subtitle}</p>}
      {statusLabel && <p className="auto-info-status"><strong>{statusLabel}</strong></p>}
      {introLine && <p className="auto-info-subtitle">{introLine}</p>}
    </section>
  );
}

export function AutoEventInfoCards({ cards }: { cards: EventInfoCards }) {
  const { classes, dates, deadlines, fees, steps, help } = cards;
  if (!classes && !dates && !deadlines && !fees && !steps && !help) return null;

  return (
    <div className="auto-info-cards" data-testid="auto-event-info-cards">
      {classes && (
        <section className="auto-info-card auto-info-classes" aria-labelledby="auto-info-classes-title">
          <h2 id="auto-info-classes-title">Classes</h2>
          <ul className="auto-info-legend" aria-label="Class color key">
            {classes.legend.map((item) => (
              <li key={item.kind}>
                <span className={`auto-info-swatch is-${item.kind.toLowerCase()}`} aria-hidden="true" />
                {item.label}
              </li>
            ))}
          </ul>
          {classes.grids.map((grid) => (
            <div className="auto-info-grid" key={grid.id}>
              {grid.locationName && <h3>{grid.locationName}</h3>}
              {grid.sessions.map((session) => (
                <div className="auto-info-session" key={session.id}>
                  <h4>{session.title}</h4>
                  <ul className="auto-info-class-list">
                    {session.classes.map((entry) => (
                      <li className={`auto-info-class is-${entry.kind.toLowerCase()}`} key={entry.id}>
                        <strong>{entry.honorName}</strong>
                        {entry.teacherName && <small>{entry.teacherName}</small>}
                        <small>
                          {entry.capacity === 0 ? "Full" : `${entry.capacity} spots`}
                          {entry.perClubLimit ? ` · up to ${entry.perClubLimit} per club` : ""}
                        </small>
                        {entry.badges.length > 0 && (
                          <span className="auto-info-badges">
                            {entry.badges.map((badge) => (
                              <span className={`auto-info-badge is-${badge.kind.toLowerCase()}`} key={badge.kind}>
                                {badge.text}
                              </span>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}

      {dates && (
        <section className="auto-info-card" aria-labelledby="auto-info-dates-title">
          <h2 id="auto-info-dates-title">Event dates</h2>
          <dl>
            {dates.rows.map((row) => (
              <div key={row.id}>
                <dt>{row.name}</dt>
                <dd>{row.dates}{row.address ? <small>{row.address}</small> : null}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {deadlines && (
        <section className="auto-info-card" aria-labelledby="auto-info-deadlines-title">
          <h2 id="auto-info-deadlines-title">Registration deadlines</h2>
          <dl>
            {deadlines.rows.map((row) => (
              <div key={row.id}>
                <dt>{row.name}</dt>
                <dd>{row.deadline}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {fees && (
        <section className="auto-info-card" aria-labelledby="auto-info-fees-title">
          <h2 id="auto-info-fees-title">Fees</h2>
          {fees.sections.map((section, sectionIndex) => (
            <div className="auto-info-fee-section" key={`${sectionIndex}:${section.title ?? ""}`}>
              {section.title && <h3>{section.title}</h3>}
              {section.groups.map((group, groupIndex) => (
                <div className="auto-info-fee-group" key={`${groupIndex}:${group.title}`}>
                  <h3>{group.title}</h3>
                  <dl>
                    {group.lines.map((line, lineIndex) => (
                      <div key={`${lineIndex}:${line.label}`}>
                        <dt>{line.label}{line.unit ? <small> {line.unit}</small> : null}</dt>
                        <dd>
                          {line.tiers.map((tier, tierIndex) => (
                            <span key={`${tierIndex}:${tier.amountCents}`}>
                              {tier.amountCents === 0 ? "No charge" : formatCardMoney(tier.amountCents)}
                              {tier.note ? <small> {tier.note}</small> : null}
                            </span>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          ))}
          {fees.notes.length > 0 && (
            <ul className="auto-info-notes">
              {fees.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}
        </section>
      )}

      {steps && (
        <section className="auto-info-card" aria-labelledby="auto-info-steps-title">
          <h2 id="auto-info-steps-title">How to register</h2>
          {steps.forms.map((form) => (
            <div key={form.title ?? "steps"}>
              {form.title && <h3>{form.title}</h3>}
              <ol>
                {form.steps.map((step, index) => (
                  <li key={`${index}:${step.title}`}>
                    <strong>{step.title}</strong>
                    {step.description && <small>{step.description}</small>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      )}

      {help && (
        <section className="auto-info-card" aria-labelledby="auto-info-help-title">
          <h2 id="auto-info-help-title">Need help?</h2>
          <p>Questions about classes, fees, or registering your club? Email <a href={`mailto:${help.email}`}>{help.email}</a>.</p>
        </section>
      )}
    </div>
  );
}
