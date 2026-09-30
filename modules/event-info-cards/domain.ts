import type { RegistrationFormDefinition } from "@/modules/forms/definition";
import { getPublicRegistrationStepPlan } from "@/modules/forms/public-registration-steps";

/**
 * Auto-built event info cards (#651). Pure view-model builders: everything a
 * card shows is derived from data the system already holds (locations, honor
 * offerings, published form pricing and steps), so the cards follow staff edits
 * with nothing to paste. Every string here is plain text; the component renders
 * it through React, which escapes it, and no builder accepts or emits markup.
 */

export const CONFERENCE_EYEBROW = "Iowa-Missouri Conference of Seventh-day Adventists";
/** The help address of a club event that set none. */
export const DEFAULT_CLUB_HELP_EMAIL = "youth@imsda.org";

export type InfoCardLocation = {
  id: string;
  name: string;
  address: string | null;
  firstDay: string | null;
  lastDay: string | null;
  registrationClosesOn: string | null;
  sortOrder: number;
};

export type InfoCardSession = {
  id: string;
  name: string;
  locationId: string | null;
  sortOrder: number;
};

export type InfoCardOffering = {
  id: string;
  honorName: string;
  teacherName: string;
  capacity: number;
  minimumAge: number | null;
  perClubLimit: number | null;
  additionalCostCents: number | null;
  requirementNote: string;
  span: "SINGLE_SESSION" | "ALL_SESSIONS";
  sessionId: string | null;
  locationId: string | null;
};

export type InfoCardForm = {
  title: string;
  definition: RegistrationFormDefinition;
};

export type InfoCardsInput = {
  event: {
    name: string;
    location: string | null;
    dateLabel: string;
    tagline: string | null;
    subtitle: string | null;
    helpEmail: string | null;
    audience: "GENERAL" | "CLUB";
    billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE";
    registrationClosesOn: string | null;
  };
  locations: InfoCardLocation[];
  sessions: InfoCardSession[];
  offerings: InfoCardOffering[];
  forms: InfoCardForm[];
};

// ---------------------------------------------------------------------------
// Formatting

/** "2026-12-05" as "Dec 5, 2026" without letting a time zone move the day. */
export function formatCardDate(calendarDate: string, withYear = true) {
  const [year, month, day] = calendarDate.split("-").map(Number);
  if (!year || !month || !day) return calendarDate;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

export function formatCardDateRange(firstDay: string | null, lastDay: string | null) {
  if (firstDay && lastDay && firstDay !== lastDay) {
    const sameYear = firstDay.slice(0, 4) === lastDay.slice(0, 4);
    return `${formatCardDate(firstDay, !sameYear)} – ${formatCardDate(lastDay)}`;
  }
  const single = firstDay ?? lastDay;
  return single ? formatCardDate(single) : null;
}

export function formatCardMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function dayBefore(calendarDate: string) {
  const [year, month, day] = calendarDate.split("-").map(Number);
  if (!year || !month || !day) return calendarDate;
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Header

export type HeaderCard = {
  eyebrow: string;
  title: string;
  tagline: string | null;
  meta: string;
  subtitle: string | null;
};

export function buildHeaderCard(input: InfoCardsInput): HeaderCard {
  const { event } = input;
  return {
    eyebrow: CONFERENCE_EYEBROW,
    title: event.name,
    tagline: event.tagline?.trim() || null,
    meta: [event.location?.trim() || null, event.dateLabel].filter(Boolean).join(" · "),
    subtitle: event.subtitle?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Class grids

export const classKinds = ["STANDARD", "LIMITED", "AGE", "COST", "SPECIAL"] as const;
export type ClassKind = (typeof classKinds)[number];

export const classKindLabels: Record<ClassKind, string> = {
  STANDARD: "Standard",
  LIMITED: "Limited spots",
  AGE: "Age requirement",
  COST: "Additional cost",
  SPECIAL: "Special requirement",
};

export type ClassBadge = { kind: Exclude<ClassKind, "STANDARD">; text: string };

export type ClassCardEntry = {
  id: string;
  honorName: string;
  teacherName: string | null;
  capacity: number;
  perClubLimit: number | null;
  /** The colour category; the badges carry the same facts as text. */
  kind: ClassKind;
  badges: ClassBadge[];
};

export type ClassSessionGroup = { id: string; title: string; classes: ClassCardEntry[] };

export type ClassGrid = {
  id: string;
  /** Null when the event has no locations. */
  locationName: string | null;
  sessions: ClassSessionGroup[];
};

export type ClassGridsCard = {
  grids: ClassGrid[];
  legend: { kind: ClassKind; label: string }[];
};

const ALL_SESSIONS_TITLE = "All sessions";
const NO_SITE_ID = "__no-site";

/** The capacity most classes share; a class below it is "limited". */
function standardCapacity(offerings: readonly InfoCardOffering[]) {
  const counts = new Map<number, number>();
  for (const offering of offerings) counts.set(offering.capacity, (counts.get(offering.capacity) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [capacity, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && capacity > best)) {
      best = capacity;
      bestCount = count;
    }
  }
  return best;
}

function classEntry(offering: InfoCardOffering, standard: number | null): ClassCardEntry {
  const badges: ClassBadge[] = [];
  if (standard !== null && offering.capacity < standard) {
    badges.push({ kind: "LIMITED", text: `Limited spots: ${offering.capacity}` });
  }
  if (offering.minimumAge !== null) {
    badges.push({ kind: "AGE", text: `Ages ${offering.minimumAge} and up` });
  }
  if (offering.additionalCostCents) {
    badges.push({ kind: "COST", text: `Additional cost: ${formatCardMoney(offering.additionalCostCents)}` });
  }
  const note = offering.requirementNote.trim();
  if (note) badges.push({ kind: "SPECIAL", text: `Requirement: ${note}` });
  return {
    id: offering.id,
    honorName: offering.honorName,
    teacherName: offering.teacherName.trim() || null,
    capacity: offering.capacity,
    perClubLimit: offering.perClubLimit,
    // One colour per class, most specific first, so colour is never the only signal.
    kind: badges.length === 0
      ? "STANDARD"
      : (["SPECIAL", "COST", "AGE", "LIMITED"] as const).find((kind) => badges.some((badge) => badge.kind === kind))!,
    badges,
  };
}

const byHonorName = (a: ClassCardEntry, b: ClassCardEntry) => a.honorName.localeCompare(b.honorName);

export function buildClassGridsCard(input: InfoCardsInput): ClassGridsCard | null {
  if (input.offerings.length === 0) return null;
  const standard = standardCapacity(input.offerings);
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]));

  const orderedLocations = [...input.locations].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const knownSites = new Set(orderedLocations.map((location) => location.id));
  // Site of a class: its own (all-sessions) or its session's. A class whose site
  // is missing or no longer exists (a legacy setup) lands in the no-site grid.
  const siteOf = (offering: InfoCardOffering) => {
    const site = offering.span === "ALL_SESSIONS"
      ? offering.locationId
      : sessionById.get(offering.sessionId ?? "")?.locationId ?? null;
    return site && knownSites.has(site) ? site : NO_SITE_ID;
  };

  const grids: ClassGrid[] = [];
  const buildGrid = (id: string, locationName: string | null): ClassGrid | null => {
    const inSite = input.offerings.filter((offering) => siteOf(offering) === id);
    if (inSite.length === 0) return null;
    const groups: ClassSessionGroup[] = [];
    const allSessions = inSite.filter((offering) => offering.span === "ALL_SESSIONS");
    if (allSessions.length > 0) {
      groups.push({
        id: `${id}:all`,
        title: ALL_SESSIONS_TITLE,
        classes: allSessions.map((offering) => classEntry(offering, standard)).sort(byHonorName),
      });
    }
    const sessionIds = [...new Set(inSite.filter((offering) => offering.span === "SINGLE_SESSION").map((offering) => offering.sessionId ?? ""))];
    const sessions = sessionIds
      .map((sessionId) => sessionById.get(sessionId))
      .filter((session): session is InfoCardSession => Boolean(session))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const session of sessions) {
      groups.push({
        id: session.id,
        title: session.name,
        classes: inSite
          .filter((offering) => offering.span === "SINGLE_SESSION" && offering.sessionId === session.id)
          .map((offering) => classEntry(offering, standard))
          .sort(byHonorName),
      });
    }
    return groups.length > 0 ? { id, locationName, sessions: groups } : null;
  };

  for (const location of orderedLocations) {
    const grid = buildGrid(location.id, location.name);
    if (grid) grids.push(grid);
  }
  const unplaced = buildGrid(
    NO_SITE_ID,
    orderedLocations.length > 0 ? "Other classes" : input.event.location?.trim() || null,
  );
  if (unplaced) grids.push(unplaced);
  if (grids.length === 0) return null;

  const used = new Set<ClassKind>();
  for (const grid of grids) for (const group of grid.sessions) for (const entry of group.classes) {
    used.add(entry.kind);
    for (const badge of entry.badges) used.add(badge.kind);
  }
  return {
    grids,
    legend: classKinds.filter((kind) => kind === "STANDARD" || used.has(kind)).map((kind) => ({ kind, label: classKindLabels[kind] })),
  };
}

// ---------------------------------------------------------------------------
// Dates and deadlines by location

export type LocationDateRow = { id: string; name: string; address: string | null; dates: string };
export type DeadlineRow = { id: string; name: string; deadline: string };

const activeOrdered = (locations: readonly InfoCardLocation[]) => (
  [...locations].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
);

export function buildDatesCard(input: InfoCardsInput): { rows: LocationDateRow[] } | null {
  const rows = activeOrdered(input.locations).flatMap((location) => {
    const dates = formatCardDateRange(location.firstDay, location.lastDay);
    return dates ? [{ id: location.id, name: location.name, address: location.address?.trim() || null, dates }] : [];
  });
  return rows.length > 0 ? { rows } : null;
}

export function buildDeadlinesCard(input: InfoCardsInput): { rows: DeadlineRow[] } | null {
  const rows: DeadlineRow[] = activeOrdered(input.locations).flatMap((location) => (
    location.registrationClosesOn
      ? [{ id: location.id, name: location.name, deadline: formatCardDate(location.registrationClosesOn) }]
      : []
  ));
  if (rows.length === 0 && input.locations.length === 0 && input.event.registrationClosesOn) {
    rows.push({ id: "event", name: input.event.name, deadline: formatCardDate(input.event.registrationClosesOn) });
  }
  return rows.length > 0 ? { rows } : null;
}

// ---------------------------------------------------------------------------
// Fees

export type FeeTier = { amountCents: number; note: string | null };
export type FeeLine = { label: string; unit: string | null; tiers: FeeTier[] };
export type FeeGroup = { title: string; lines: FeeLine[] };
export type FeesCard = { groups: FeeGroup[]; notes: string[] };

function unitFor(scope: "REGISTRATION" | "ATTENDEE", type: string) {
  if (type === "NUMBER") return "each";
  return scope === "ATTENDEE" ? "per person" : "per registration";
}

function tiersFor(regularCents: number | undefined, late: { startsOn: string; label: string; cents: number | undefined } | null): FeeTier[] {
  const tiers: FeeTier[] = [];
  if (regularCents !== undefined) {
    tiers.push({ amountCents: regularCents, note: late ? `through ${formatCardDate(dayBefore(late.startsOn))}` : null });
  }
  if (late && late.cents !== undefined) {
    tiers.push({ amountCents: late.cents, note: `from ${formatCardDate(late.startsOn)}` });
  }
  return tiers;
}

export function buildFeesCard(input: InfoCardsInput): FeesCard | null {
  const groups: FeeGroup[] = [];
  const singles: FeeLine[] = [];
  const seen = new Set<string>();

  for (const form of input.forms) {
    for (const section of form.definition.sections) {
      for (const field of section.fields) {
        if (field.creditCentsPerUnit !== undefined) continue;
        const unit = unitFor(field.scope, field.type);
        const late = field.latePricing
          ? { startsOn: field.latePricing.startsOn, label: field.latePricing.label }
          : null;

        if (field.choicePricesCents && Object.keys(field.choicePricesCents).length > 0) {
          const choices = field.options.filter((option) => field.choicePricesCents?.[option] !== undefined);
          const lines = choices.map((option): FeeLine => ({
            label: field.optionLabels?.[option] ?? option,
            unit: null,
            tiers: tiersFor(
              field.choicePricesCents?.[option],
              late ? { ...late, cents: field.latePricing?.choicePricesCents?.[option] } : null,
            ),
          })).filter((line) => line.tiers.length > 0);
          const key = `choice:${field.label}:${JSON.stringify(lines)}`;
          if (lines.length > 0 && !seen.has(key)) {
            seen.add(key);
            groups.push({ title: field.label, lines });
          }
          continue;
        }

        if (field.priceCents !== undefined || field.latePricing?.priceCents !== undefined) {
          const line: FeeLine = {
            label: field.label,
            unit,
            tiers: tiersFor(field.priceCents, late ? { ...late, cents: field.latePricing?.priceCents } : null),
          };
          const key = `single:${JSON.stringify(line)}`;
          if (line.tiers.length > 0 && !seen.has(key)) {
            seen.add(key);
            singles.push(line);
          }
        }
      }
    }
  }
  if (singles.length > 0) groups.unshift({ title: "Fees", lines: singles });
  if (groups.length === 0) return null;

  const notes: string[] = [];
  if (input.event.billingMode === "DEFERRED_ORGANIZATION_INVOICE") {
    if (input.event.audience === "CLUB") notes.push("Billed to your church");
    notes.push("Billed after the event");
  }
  return { groups, notes };
}

// ---------------------------------------------------------------------------
// How to register

export type RegisterStep = { title: string; description: string | null };
export type StepsCard = { forms: { title: string | null; steps: RegisterStep[] }[] };

export function buildRegisterStepsCard(input: InfoCardsInput): StepsCard | null {
  const forms = input.forms
    .map((form) => ({
      title: input.forms.length > 1 ? form.title : null,
      steps: getPublicRegistrationStepPlan(form.definition).map((step) => ({
        title: step.title,
        description: step.description.trim() || null,
      })),
    }))
    .filter((form) => form.steps.length > 0);
  return forms.length > 0 ? { forms } : null;
}

// ---------------------------------------------------------------------------
// Help

export function resolveHelpEmail(event: Pick<InfoCardsInput["event"], "helpEmail" | "audience">) {
  return event.helpEmail?.trim() || (event.audience === "CLUB" ? DEFAULT_CLUB_HELP_EMAIL : null);
}

export function buildHelpCard(input: InfoCardsInput): { email: string } | null {
  const email = resolveHelpEmail(input.event);
  return email ? { email } : null;
}

// ---------------------------------------------------------------------------

export type EventInfoCards = {
  header: HeaderCard;
  classes: ClassGridsCard | null;
  dates: { rows: LocationDateRow[] } | null;
  deadlines: { rows: DeadlineRow[] } | null;
  fees: FeesCard | null;
  steps: StepsCard | null;
  help: { email: string } | null;
};

export function buildEventInfoCards(input: InfoCardsInput): EventInfoCards {
  return {
    header: buildHeaderCard(input),
    classes: buildClassGridsCard(input),
    dates: buildDatesCard(input),
    deadlines: buildDeadlinesCard(input),
    fees: buildFeesCard(input),
    steps: buildRegisterStepsCard(input),
    help: buildHelpCard(input),
  };
}
