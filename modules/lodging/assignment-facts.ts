import "server-only";

import type { LodgingCategory } from "@/modules/lodging/domain";
import {
  assignableRegistrationStatuses,
  assignmentWarnings,
  exceptionKindLabels,
  exceptionSection,
  isOfferLapsed,
  noticeIsObsolete,
  sensitiveExceptionKinds,
  unitConflicts,
  type AssignmentWarning,
  type ExceptionRow,
  type Segment,
  type WaitlistStatus,
} from "@/modules/lodging/assignment-domain";
import { loadPlanningState, loadTogetherInput, toNight, type PlanningState } from "@/modules/lodging/assignment-state";
import { buildStays, noticeContentHash, type Stay } from "@/modules/lodging/stays";
import { requestNights } from "@/modules/lodging/preferences-domain";
import { attendeeName, loadCurrentRequests, type Client } from "@/modules/lodging/preferences-service";
import { minorStatusAt, personAgeFromAnswers, eventStartDate } from "@/modules/guardian-authority/domain";
import type { TogetherInput } from "@/modules/lodging/preferences-domain";

/**
 * The facts the staff workspace, the reports, the exports and the attendee display are all derived from, computed once
 * from the database: people (attendees and expected guests), their requests and wanted nights, what is assigned, the
 * keep-together groups and the exceptions. Nothing here writes. Accessibility flags are carried raw on the person and
 * are stripped by every consumer that is not for staff holding VIEW_SENSITIVE_DATA.
 */

export type PersonFact = {
  occupantKey: string;
  occupantId: string;
  kind: "ATTENDEE" | "PLACEHOLDER";
  name: string;
  registrationId: string | null;
  registrationCode: string | null;
  registrationStatus: string | null;
  active: boolean;
  personId: string | null;
  people: number;
  minorStatus: "MINOR" | "ADULT" | "UNKNOWN" | null;
  /** A request that asks for no category means "not asking for lodging". */
  asksForLodging: boolean;
  hasRequest: boolean;
  category: LodgingCategory | null;
  wantedNights: string[];
  /** Raw yes/no flags: only for staff with VIEW_SENSITIVE_DATA. */
  groundFloorNeeded: boolean;
  accessibleRoomNeeded: boolean;
  waitlistStatus: WaitlistStatus | null;
};

export type WaitlistFact = {
  id: string;
  registrationId: string;
  registrationCode: string;
  holder: string;
  category: LodgingCategory;
  firstNight: string | null;
  lastNight: string | null;
  partySize: number;
  status: WaitlistStatus;
  offerNumber: number;
  offeredAt: string | null;
  offerExpiresAt: string | null;
  /** The status of the offer email in the outbox (null before any offer). A failed, suppressed or cancelled one never reached the guest. */
  offerMessageStatus: string | null;
  lapsed: boolean;
  joinedAt: string;
  createdVia: string;
};

export type NoticeFact = {
  registrationId: string;
  noticeId: string;
  assignmentVersion: number;
  currentVersion: number;
  obsolete: boolean;
  sentAt: string;
  messageStatus: string | null;
};

export async function loadAssignmentFacts(client: Client, eventId: string, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const state = await loadPlanningState(client, eventId);
  const [registrations, requests, placeholders, waitlistRows, noticeRows, historyCounts, event, lodgingSettings] = await Promise.all([
    client.registration.findMany({
      where: { eventId, status: { not: "DRAFT" } },
      orderBy: { confirmationCode: "asc" },
      select: {
        id: true, status: true, confirmationCode: true,
        accountHolderPerson: { select: { firstName: true, lastName: true } },
        attendees: { orderBy: [{ position: "asc" }, { id: "asc" }], select: { id: true, personId: true, profileSnapshot: true, formResponses: true, person: { select: { firstName: true, lastName: true } } } },
      },
    }),
    loadCurrentRequests(client, eventId),
    client.eventLodgingPlaceholder.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } }),
    client.eventLodgingWaitlistEntry.findMany({
      where: { eventId },
      orderBy: { joinedAt: "asc" },
      include: { registration: { select: { confirmationCode: true, accountHolderPerson: { select: { firstName: true, lastName: true } } } } },
    }),
    client.eventLodgingAssignmentNotice.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } }),
    client.eventLodgingAssignmentHistory.groupBy({ by: ["attendeeId"], where: { eventId, attendeeId: { not: null } }, _count: { _all: true } }),
    client.event.findUniqueOrThrow({ where: { id: eventId }, select: { startsAt: true, timezone: true } }),
    client.eventLodging.findUniqueOrThrow({ where: { eventId }, select: { showAssignmentsToAttendees: true, showRoommateFirstNames: true, attendeeInstructions: true } }),
  ]);
  const requestByRegistration = new Map(requests.map((request) => [request.registrationId, request]));
  const startDate = eventStartDate(event.startsAt, state.context.timezone);
  const openWaitlist = new Map<string, WaitlistStatus>();
  for (const entry of waitlistRows) if (["JOINED", "OFFERED", "ACCEPTED"].includes(entry.status)) openWaitlist.set(entry.registrationId, entry.status as WaitlistStatus);

  const people: PersonFact[] = [];
  const registrationOfAttendee = new Map<string, string>();
  for (const registration of registrations) {
    const request = requestByRegistration.get(registration.id);
    const active = (assignableRegistrationStatuses as readonly string[]).includes(registration.status);
    for (const attendee of registration.attendees) {
      registrationOfAttendee.set(attendee.id, registration.id);
      const snapshot = attendee.profileSnapshot && typeof attendee.profileSnapshot === "object" && !Array.isArray(attendee.profileSnapshot) ? attendee.profileSnapshot as Record<string, unknown> : {};
      const responses = attendee.formResponses && typeof attendee.formResponses === "object" && !Array.isArray(attendee.formResponses) ? attendee.formResponses as Record<string, unknown> : {};
      people.push({
        occupantKey: attendee.id,
        occupantId: attendee.id,
        kind: "ATTENDEE",
        name: attendeeName(attendee),
        registrationId: registration.id,
        registrationCode: registration.confirmationCode,
        registrationStatus: registration.status,
        active,
        personId: attendee.personId,
        people: 1,
        minorStatus: minorStatusAt(personAgeFromAnswers(responses, snapshot), startDate).status,
        asksForLodging: request ? request.category !== null : true,
        hasRequest: Boolean(request),
        category: request?.category ?? null,
        wantedNights: request && request.category === null ? [] : request ? requestNights(request, state.context.nights) : [...state.context.nights],
        groundFloorNeeded: Boolean(request?.groundFloorNeeded),
        accessibleRoomNeeded: Boolean(request?.accessibleRoomNeeded),
        waitlistStatus: openWaitlist.get(registration.id) ?? null,
      });
    }
  }
  const linkedPlaceholderIds = new Set(placeholders.filter((placeholder) => placeholder.linkedAttendeeId).map((placeholder) => placeholder.id));
  for (const placeholder of placeholders) {
    if (placeholder.archivedAt || linkedPlaceholderIds.has(placeholder.id)) continue;
    people.push({
      occupantKey: placeholder.id,
      occupantId: placeholder.id,
      kind: "PLACEHOLDER",
      name: placeholder.displayName,
      registrationId: null,
      registrationCode: null,
      registrationStatus: null,
      active: true,
      personId: null,
      people: placeholder.headcount,
      minorStatus: null,
      asksForLodging: true,
      hasRequest: false,
      category: null,
      wantedNights: [...state.context.nights],
      groundFloorNeeded: false,
      accessibleRoomNeeded: false,
      waitlistStatus: null,
    });
  }
  const personByKey = new Map(people.map((person) => [person.occupantKey, person]));
  const together = await loadTogetherInput(client, eventId, people.flatMap((person) => (person.personId && person.registrationId && person.active ? [{ personId: person.personId, registrationId: person.registrationId }] : [])));
  const occupantKeyByPerson = new Map(people.flatMap((person) => (person.personId ? [[person.personId, person.occupantKey] as const] : [])));
  const warnings = assignmentWarnings({ nights: state.context.nights, segments: state.segments, together, occupantKeyByPerson });

  // Notices: the latest one per registration, and whether a later change made it obsolete.
  const versionByAttendee = new Map(historyCounts.flatMap((row) => (row.attendeeId ? [[row.attendeeId, row._count._all] as const] : [])));
  const versionOfRegistration = (registrationId: string) => {
    const registration = registrations.find((candidate) => candidate.id === registrationId);
    return (registration?.attendees ?? []).reduce((total, attendee) => total + (versionByAttendee.get(attendee.id) ?? 0), 0);
  };
  const messageIds = noticeRows.flatMap((notice) => (notice.outboxMessageId ? [notice.outboxMessageId] : []));
  const messages = messageIds.length === 0 ? [] : await client.messageOutbox.findMany({ where: { id: { in: messageIds } }, select: { id: true, status: true } });
  const messageStatus = new Map(messages.map((message) => [message.id, message.status]));
  const latestNotice = new Map<string, (typeof noticeRows)[number]>();
  for (const notice of noticeRows) latestNotice.set(notice.registrationId, notice);
  // What each registration would be told right now: a notice is current only while this still matches what it was sent with.
  const currentHashOf = (registrationId: string) => {
    const registration = registrations.find((candidate) => candidate.id === registrationId);
    const own = (registration?.attendees ?? []).map((attendee) => ({ occupantKey: attendee.id, name: attendeeName(attendee) }));
    const units = new Map([...state.units].map(([id, unit]) => [id, { name: unit.name, buildingName: state.meta.get(id)?.buildingName ?? "", state: unit }] as const));
    const others = new Map(people.map((person) => [person.occupantKey, { name: person.name, people: person.people, nameable: person.kind === "ATTENDEE" && person.active && person.minorStatus === "ADULT" }] as const));
    const stays: Stay[] = buildStays({
      own, segments: state.segments, units, bucketLabels: new Map(state.buckets.map((bucket) => [bucket.id, bucket.label])), others,
      showRoommates: lodgingSettings.showRoommateFirstNames,
    });
    return noticeContentHash(stays, lodgingSettings.attendeeInstructions, lodgingSettings.showAssignmentsToAttendees);
  };
  const notices: NoticeFact[] = [...latestNotice.values()].map((notice) => {
    const currentVersion = versionOfRegistration(notice.registrationId);
    return {
      registrationId: notice.registrationId,
      noticeId: notice.id,
      assignmentVersion: notice.assignmentVersion,
      currentVersion,
      // Obsolete when any of the registration's assignments changed, or anything the notice says did (roommates, a room
      // closed or held, the instructions, a renamed housing choice, unpublishing).
      obsolete: noticeIsObsolete(notice.assignmentVersion, currentVersion) || notice.contentHash !== currentHashOf(notice.registrationId),
      sentAt: notice.createdAt.toISOString(),
      messageStatus: notice.outboxMessageId ? messageStatus.get(notice.outboxMessageId) ?? null : null,
    };
  });

  const offerIds = waitlistRows.flatMap((entry) => (entry.offerMessageId ? [entry.offerMessageId] : []));
  const offerMessages = offerIds.length === 0 ? [] : await client.messageOutbox.findMany({ where: { id: { in: offerIds } }, select: { id: true, status: true } });
  const offerStatus = new Map(offerMessages.map((message) => [message.id, message.status]));
  const waitlist: WaitlistFact[] = waitlistRows.map((entry) => ({
    id: entry.id,
    registrationId: entry.registrationId,
    registrationCode: entry.registration.confirmationCode,
    holder: `${entry.registration.accountHolderPerson.firstName} ${entry.registration.accountHolderPerson.lastName}`.trim(),
    category: entry.category,
    firstNight: entry.firstNight ? toNight(entry.firstNight) : null,
    lastNight: entry.lastNight ? toNight(entry.lastNight) : null,
    partySize: entry.partySize,
    status: entry.status as WaitlistStatus,
    offerNumber: entry.offerNumber,
    offeredAt: entry.offeredAt?.toISOString() ?? null,
    offerExpiresAt: entry.offerExpiresAt?.toISOString() ?? null,
    offerMessageStatus: entry.offerMessageId ? offerStatus.get(entry.offerMessageId) ?? null : null,
    lapsed: isOfferLapsed({ status: entry.status as WaitlistStatus, offerExpiresAt: entry.offerExpiresAt }, now),
    joinedAt: entry.joinedAt.toISOString(),
    createdVia: entry.createdVia,
  }));

  const exceptions = buildExceptions({ state, people, personByKey, warnings, together, waitlist, notices, registrations: registrations.map((registration) => ({ id: registration.id, code: registration.confirmationCode })) });
  return { now, state, people, personByKey, together, warnings, waitlist, notices, exceptions, registrationOfAttendee, placeholders, requests };
}
export type AssignmentFacts = Awaited<ReturnType<typeof loadAssignmentFacts>>;

function buildExceptions(input: {
  state: PlanningState;
  people: readonly PersonFact[];
  personByKey: ReadonlyMap<string, PersonFact>;
  warnings: readonly AssignmentWarning[];
  together: TogetherInput;
  waitlist: readonly WaitlistFact[];
  notices: readonly NoticeFact[];
  registrations: ReadonlyArray<{ id: string; code: string }>;
}): ExceptionRow[] {
  const { state } = input;
  const nights = state.context.nights;
  const rows: ExceptionRow[] = [];
  const segments = state.segments.map((segment) => ({ ...segment, assignmentId: segment.id }));
  rows.push(...unitConflicts({ nights, units: state.units, segments }));

  // Rooms still held by registrations that are no longer submitted or confirmed.
  const inactiveByRegistration = new Map<string, string[]>();
  for (const segment of state.segments) {
    const person = input.personByKey.get(segment.occupantKey);
    if (person && person.kind === "ATTENDEE" && !person.active && person.registrationId) {
      inactiveByRegistration.set(person.registrationId, [...(inactiveByRegistration.get(person.registrationId) ?? []), segment.id]);
    }
  }
  const codeOf = new Map(input.registrations.map((registration) => [registration.id, registration.code]));
  for (const [registrationId, assignmentIds] of inactiveByRegistration) {
    rows.push({ kind: "INACTIVE_REGISTRATION", key: `inactive:${registrationId}`, title: `Registration ${codeOf.get(registrationId) ?? ""} still holds a room`, detail: "The registration is cancelled or waitlisted, but its room is still counted as taken. Release it when you are sure.", assignmentIds });
  }

  // People who still need a place for some of their nights.
  for (const person of input.people) {
    if (!person.active || !person.asksForLodging || person.wantedNights.length === 0) continue;
    const covered = new Set<string>();
    for (const segment of state.segments) {
      if (segment.occupantKey !== person.occupantKey) continue;
      for (let night = segment.firstNight; night <= segment.lastNight; night = nextDay(night)) covered.add(night);
    }
    const missing = person.wantedNights.filter((night) => !covered.has(night));
    if (missing.length === 0) continue;
    rows.push({
      kind: "UNASSIGNED", key: `unassigned:${person.occupantKey}`, title: `${person.name} is not placed for ${missing.length === person.wantedNights.length ? "any night" : `${missing.length} of ${person.wantedNights.length} nights`}`,
      detail: `First night without a place: ${missing[0]}.${person.waitlistStatus ? ` On the lodging waitlist (${person.waitlistStatus.toLowerCase()}).` : ""}`, assignmentIds: [], night: missing[0],
    });
  }

  // Accessibility (restricted): someone who needs the ground floor, placed above it.
  for (const person of input.people) {
    if (!(person.groundFloorNeeded || person.accessibleRoomNeeded)) continue;
    const upstairs = state.segments.filter((segment) => segment.occupantKey === person.occupantKey && segment.unitId && !state.meta.get(segment.unitId)?.groundLevel);
    if (upstairs.length === 0) continue;
    rows.push({ kind: "ACCESSIBILITY_UNMET", key: `access:${person.occupantKey}`, title: `${person.name} is placed above the ground floor`, detail: "Move them to a ground-level room.", assignmentIds: upstairs.map((segment) => segment.id), unitId: upstairs[0]!.unitId ?? undefined });
  }

  const nameOfPerson = new Map(input.people.flatMap((person) => (person.personId ? [[person.personId, person.name] as const] : [])));
  for (const warning of input.warnings) {
    if (warning.kind === "SPLIT_HOUSEHOLD") {
      rows.push({ kind: "SPLIT_HOUSEHOLD", key: `split:${[...warning.members].sort().join(",")}`, title: `${warning.members.map((id) => nameOfPerson.get(id) ?? "Someone").join(", ")} are not in one room`, detail: `A keep-together group is placed apart or only partly placed, first on ${warning.night}.`, assignmentIds: [], night: warning.night });
    } else {
      rows.push({ kind: "KEEP_APART", key: `apart:${warning.ruleId}`, title: `${warning.members.map((id) => nameOfPerson.get(id) ?? "Someone").join(" and ")} share a room`, detail: `A keep-apart rule says they should not, first on ${warning.night}.`, assignmentIds: [], unitId: warning.unitId, night: warning.night });
    }
  }

  for (const entry of input.waitlist) {
    if (!["JOINED", "OFFERED", "ACCEPTED"].includes(entry.status)) continue;
    rows.push({ kind: "OPEN_WAITLIST", key: `waitlist:${entry.id}`, title: `${entry.holder} (${entry.registrationCode}) is on the lodging waitlist`, detail: `${entry.partySize} ${entry.partySize === 1 ? "person" : "people"}, ${entry.status.toLowerCase()}${entry.lapsed ? " (the offer has expired)" : ""}.`, assignmentIds: [] });
  }
  for (const notice of input.notices) {
    if (!notice.obsolete) continue;
    rows.push({ kind: "OBSOLETE_NOTICE", key: `notice:${notice.registrationId}`, title: `Room notice for ${codeOf.get(notice.registrationId) ?? "a registration"} is out of date`, detail: "A room change was made after the notice. Send a new one.", assignmentIds: [] });
  }
  for (const person of input.people) {
    if (person.kind !== "PLACEHOLDER") continue;
    const placed = state.segments.filter((segment) => segment.occupantKey === person.occupantKey);
    if (placed.length === 0) continue;
    rows.push({ kind: "UNLINKED_PLACEHOLDER", key: `placeholder:${person.occupantKey}`, title: `${person.name} is an expected guest, not yet a registration`, detail: "Link them to their registration when they register.", assignmentIds: placed.map((segment) => segment.id) });
  }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

function nextDay(night: string) {
  const date = new Date(`${night}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** The exceptions a caller may see: restricted ones only with VIEW_SENSITIVE_DATA. Each carries its label and section. */
export function visibleExceptions(rows: readonly ExceptionRow[], canSeeSensitive: boolean) {
  return rows
    .filter((row) => canSeeSensitive || !sensitiveExceptionKinds.has(row.kind))
    .map((row) => ({ ...row, label: exceptionKindLabels[row.kind], section: exceptionSection[row.kind] }));
}
export type VisibleException = ReturnType<typeof visibleExceptions>[number];

export function currentSegments(state: PlanningState): Segment[] {
  return state.segments;
}
