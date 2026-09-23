import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  addDays,
  calendarDateIn,
  eventTimeLabel,
  sortCalendarItems,
  type CalendarItem,
} from "@/modules/calendar/domain";
import type { CalendarEntryInput, CalendarEntryUpdate, CalendarEventSettings } from "@/modules/calendar/schemas";
import { evaluateEventRegistrationPhase } from "@/modules/events/lifecycle";

export class CalendarError extends Error {
  constructor(public readonly code: "ENTRY_NOT_FOUND" | "EVENT_NOT_FOUND", message: string) {
    super(message);
    this.name = "CalendarError";
  }
}

const publicEventSelect = {
  id: true,
  slug: true,
  name: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  location: true,
  calendarCategory: true,
  isPublished: true,
  registrationOpensOn: true,
  registrationClosesOn: true,
  waitlistEnabled: true,
} as const;

/**
 * What anyone may see: published events an administrator hasn't hidden, and
 * published entries. Nothing else is ever read here, so nothing else can leak
 * into the page, the feed, or search engines.
 */
export async function listPublicCalendarItems(from: string, to: string, now = new Date()): Promise<CalendarItem[]> {
  const prisma = getPrisma();
  // Widen by a day each side so an event's own time zone can't push it out of range.
  const [events, entries] = await Promise.all([
    prisma.event.findMany({
      where: {
        isPublished: true,
        showOnCalendar: true,
        startsAt: { lt: new Date(`${addDays(to, 2)}T00:00:00Z`) },
        endsAt: { gte: new Date(`${addDays(from, -1)}T00:00:00Z`) },
      },
      select: publicEventSelect,
    }),
    prisma.calendarEntry.findMany({
      where: { isPublished: true, startsOn: { lte: to }, endsOn: { gte: from } },
    }),
  ]);

  const items: CalendarItem[] = [
    ...events.map((event) => ({
      key: `event-${event.id}`,
      kind: "EVENT" as const,
      title: event.name,
      description: "",
      startsOn: calendarDateIn(event.startsAt, event.timezone),
      endsOn: calendarDateIn(event.endsAt, event.timezone),
      timeLabel: eventTimeLabel(event.startsAt, event.endsAt, event.timezone),
      location: event.location ?? "",
      category: event.calendarCategory ?? "",
      href: `/events/${encodeURIComponent(event.slug)}`,
      status: "SCHEDULED" as const,
      registrationOpen: evaluateEventRegistrationPhase(event, now) === "OPEN",
    })),
    ...entries.map((entry) => ({
      key: `entry-${entry.id}`,
      kind: "ENTRY" as const,
      title: entry.title,
      description: entry.description,
      startsOn: entry.startsOn,
      endsOn: entry.endsOn,
      timeLabel: entry.timeLabel,
      location: entry.location,
      category: entry.category,
      href: entry.linkUrl,
      status: entry.status,
      registrationOpen: false,
    })),
  ];
  return sortCalendarItems(items.filter((item) => item.startsOn <= to && item.endsOn >= from));
}

export type CalendarAdminEntry = Awaited<ReturnType<typeof listCalendarEntries>>[number];

export async function listCalendarEntries() {
  const entries = await getPrisma().calendarEntry.findMany({ orderBy: [{ startsOn: "desc" }, { title: "asc" }], take: 300 });
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    startsOn: entry.startsOn,
    endsOn: entry.endsOn,
    timeLabel: entry.timeLabel,
    location: entry.location,
    category: entry.category,
    linkUrl: entry.linkUrl,
    status: entry.status,
    isPublished: entry.isPublished,
    updatedAt: entry.updatedAt.toISOString(),
  }));
}

export type CalendarAdminEvent = Awaited<ReturnType<typeof listCalendarEvents>>[number];

/** Events that haven't ended (plus the last month), with whether each shows on the calendar. */
export async function listCalendarEvents(now = new Date()) {
  const events = await getPrisma().event.findMany({
    where: { endsAt: { gte: new Date(now.getTime() - 31 * 86_400_000) } },
    orderBy: { startsAt: "asc" },
    select: { ...publicEventSelect, showOnCalendar: true },
  });
  return events.map((event) => ({
    id: event.id,
    name: event.name,
    startsOn: calendarDateIn(event.startsAt, event.timezone),
    endsOn: calendarDateIn(event.endsAt, event.timezone),
    isPublished: event.isPublished,
    showOnCalendar: event.showOnCalendar,
    calendarCategory: event.calendarCategory ?? "",
  }));
}

export async function createCalendarEntry(input: CalendarEntryInput, actorUserId: string) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const entry = await tx.calendarEntry.create({
      data: { ...input, createdByUserId: actorUserId, updatedByUserId: actorUserId },
    });
    await writeAuditLog({
      actorUserId,
      action: "CALENDAR_ENTRY_CREATED",
      entityType: "CalendarEntry",
      entityId: entry.id,
      summary: `Added "${entry.title}" to the calendar${entry.isPublished ? "" : " as a draft"}.`,
      metadata: { startsOn: entry.startsOn, endsOn: entry.endsOn, isPublished: entry.isPublished },
    }, tx);
  });
  return listCalendarEntries();
}

export async function updateCalendarEntry(entryId: string, input: CalendarEntryUpdate, actorUserId: string) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.calendarEntry.findUnique({ where: { id: entryId } });
    if (!existing) throw new CalendarError("ENTRY_NOT_FOUND", "That calendar entry could not be found.");
    const entry = await tx.calendarEntry.update({ where: { id: entryId }, data: { ...input, updatedByUserId: actorUserId } });
    const changed = Object.keys(input).filter((key) => existing[key as keyof typeof existing] !== entry[key as keyof typeof entry]);
    await writeAuditLog({
      actorUserId,
      action: existing.isPublished !== entry.isPublished
        ? (entry.isPublished ? "CALENDAR_ENTRY_PUBLISHED" : "CALENDAR_ENTRY_UNPUBLISHED")
        : "CALENDAR_ENTRY_UPDATED",
      entityType: "CalendarEntry",
      entityId: entry.id,
      summary: `Updated "${entry.title}" on the calendar.`,
      metadata: { changed },
    }, tx);
  });
  return listCalendarEntries();
}

export async function deleteCalendarEntry(entryId: string, actorUserId: string) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.calendarEntry.findUnique({ where: { id: entryId } });
    if (!existing) throw new CalendarError("ENTRY_NOT_FOUND", "That calendar entry could not be found.");
    await tx.calendarEntry.delete({ where: { id: entryId } });
    await writeAuditLog({
      actorUserId,
      action: "CALENDAR_ENTRY_DELETED",
      entityType: "CalendarEntry",
      entityId: entryId,
      summary: `Removed "${existing.title}" from the calendar.`,
      metadata: { startsOn: existing.startsOn, endsOn: existing.endsOn, wasPublished: existing.isPublished },
    }, tx);
  });
  return listCalendarEntries();
}

export async function updateEventCalendarSettings(eventId: string, input: CalendarEventSettings, actorUserId: string) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.event.findUnique({ where: { id: eventId }, select: { id: true, name: true, showOnCalendar: true, calendarCategory: true } });
    if (!existing) throw new CalendarError("EVENT_NOT_FOUND", "That event could not be found.");
    const updated = await tx.event.update({
      where: { id: eventId },
      data: {
        ...(input.showOnCalendar === undefined ? {} : { showOnCalendar: input.showOnCalendar }),
        ...(input.calendarCategory === undefined ? {} : { calendarCategory: input.calendarCategory }),
      },
      select: { showOnCalendar: true, calendarCategory: true },
    });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "EVENT_CALENDAR_SETTINGS_UPDATED",
      entityType: "Event",
      entityId: eventId,
      summary: existing.showOnCalendar !== updated.showOnCalendar
        ? `${updated.showOnCalendar ? "Showed" : "Hid"} ${existing.name} on the public calendar.`
        : `Changed the calendar category for ${existing.name}.`,
      metadata: {
        showOnCalendar: updated.showOnCalendar,
        calendarCategory: updated.calendarCategory ?? "",
      },
    }, tx);
  });
  return listCalendarEvents();
}

/** Today's date in the conference time zone, for the default month. */
export function conferenceToday(now = new Date()) {
  return calendarDateIn(now);
}
