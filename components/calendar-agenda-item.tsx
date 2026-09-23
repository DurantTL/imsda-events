import Link from "next/link";
import { CalendarDays, ChevronRight, Clock3, ExternalLink, MapPin } from "lucide-react";
import { calendarStatusLabels, formatDateRange, type CalendarItem } from "@/modules/calendar/domain";

const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ItemLink({ item, children, className }: { item: CalendarItem; children: React.ReactNode; className?: string }) {
  if (!item.href) return <span className={className}>{children}</span>;
  if (item.href.startsWith("/")) return <Link className={className} href={item.href}>{children}</Link>;
  return <a className={className} href={item.href} rel="noreferrer" target="_blank">{children}</a>;
}

export function AgendaItem({ item }: { item: CalendarItem }) {
  const [, month, day] = item.startsOn.split("-").map(Number);
  return (
    <li className={`calendar-agenda-item calendar-kind-${item.kind.toLowerCase()} calendar-status-${item.status.toLowerCase()}`}>
      <span className="calendar-date-badge" aria-hidden="true">
        <small>{shortMonths[month - 1]}</small>
        <strong>{day}</strong>
      </span>
      <div className="calendar-agenda-body">
        <div className="calendar-agenda-tags">
          <span className="calendar-kind-label">{item.kind === "EVENT" ? "IMSDA event" : "Conference date"}</span>
          {item.category && <span className="calendar-category-tag">{item.category}</span>}
          {item.status !== "SCHEDULED" && <span className="status-chip coral">{calendarStatusLabels[item.status]}</span>}
          {item.registrationOpen && <span className="status-chip green">Registration open</span>}
        </div>
        <h3><ItemLink item={item}>{item.title}</ItemLink></h3>
        <p className="calendar-agenda-meta">
          <span><CalendarDays size={14} aria-hidden="true" /> {formatDateRange(item.startsOn, item.endsOn)}</span>
          {item.timeLabel && <span><Clock3 size={14} aria-hidden="true" /> {item.timeLabel}</span>}
          {item.location && <span><MapPin size={14} aria-hidden="true" /> {item.location}</span>}
        </p>
        {item.description && <p className="calendar-agenda-description">{item.description}</p>}
      </div>
      {item.href && item.status !== "CANCELLED" && (
        <ItemLink
          className={`${item.registrationOpen ? "primary-button" : "secondary-button"} calendar-agenda-action`}
          item={item}
        >
          {item.kind === "EVENT" ? (item.registrationOpen ? "Register" : "Details") : "More info"}
          {item.href.startsWith("/") ? <ChevronRight size={14} aria-hidden="true" /> : <ExternalLink size={14} aria-hidden="true" />}
        </ItemLink>
      )}
    </li>
  );
}

