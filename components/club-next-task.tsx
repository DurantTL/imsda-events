import Link from "next/link";
import { ArrowRight, CalendarClock, CheckCircle2, CircleAlert } from "lucide-react";
import type { ClubNextTask } from "@/modules/club-rosters/home-next-task";

/**
 * The first card on Club home (#743): the next task, its deadline, and the one
 * filled button on the page. Before the statistics, so a director sees what to
 * do before how the year is going. No task shows "all caught up".
 */
export function ClubNextTaskCard({ next }: { next: ClubNextTask | null }) {
  if (!next) {
    return (
      <section aria-labelledby="club-next-task-heading" className="public-manage-card club-next-task is-clear">
        <div className="public-manage-card-heading">
          <p className="public-registration-eyebrow">Next task</p>
          <h2 id="club-next-task-heading">You&apos;re all caught up</h2>
        </div>
        <p className="public-manage-empty"><CheckCircle2 size={17} aria-hidden="true" /> Nothing needs your attention right now.</p>
      </section>
    );
  }
  const { step, deadline } = next;
  return (
    <section aria-labelledby="club-next-task-heading" className={`public-manage-card club-next-task${step.danger ? " club-step-danger" : ""}`}>
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Next task</p>
        <h2 id="club-next-task-heading">{step.text}</h2>
      </div>
      <div className="club-next-task-row">
        <p className="club-next-task-deadline">
          {step.danger ? <CircleAlert size={16} aria-hidden="true" /> : <CalendarClock size={16} aria-hidden="true" />}
          <span>{deadline ?? "No deadline"}</span>
        </p>
        <Link className="primary-button club-event-action" href={step.href}>
          {step.action} <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
