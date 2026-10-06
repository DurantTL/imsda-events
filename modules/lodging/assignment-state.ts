import "server-only";

import type { UnitNightState } from "@/modules/lodging/domain";
import type { PlanUnit, Segment } from "@/modules/lodging/assignment-domain";
import type { GuardianLink, RuleRow, RulePerson, TogetherInput, LodgingRuleKind } from "@/modules/lodging/preferences-domain";
import { loadContext, loadCurrentRequests, type Client } from "@/modules/lodging/preferences-service";

/**
 * What the assignment writers, the staff workspace and the reports all read: the event's units with their per-event
 * state and holds, the alternate-housing buckets, and the current (not cancelled) assignments as night-range segments.
 */

export const toDate = (night: string) => new Date(`${night}T00:00:00Z`);
export const toNight = (date: Date) => date.toISOString().slice(0, 10);

export type UnitMeta = {
  name: string;
  key: string;
  buildingName: string;
  buildingSort: number;
  floor: number | null;
  groundLevel: boolean;
};

export async function loadPlanningState(client: Client, eventId: string) {
  const context = await loadContext(client, eventId);
  const [unitRows, bucketRows, assignments] = await Promise.all([
    client.eventLodgingUnit.findMany({
      where: { eventLodgingId: context.eventLodgingId },
      include: { unit: { include: { building: true } }, holds: { where: { releasedAt: null }, select: { id: true, firstNight: true, lastNight: true } } },
    }),
    client.eventLodgingBucket.findMany({ where: { eventLodgingId: context.eventLodgingId }, orderBy: { kind: "asc" } }),
    client.eventLodgingAssignment.findMany({ where: { eventId, cancelledAt: null }, orderBy: [{ firstNight: "asc" }, { createdAt: "asc" }] }),
  ]);
  const units = new Map<string, PlanUnit>();
  const meta = new Map<string, UnitMeta>();
  for (const row of unitRows) {
    const state: UnitNightState = {
      unitId: row.id,
      assignable: row.assignable,
      retired: row.retired,
      defaultCapacity: row.defaultCapacity,
      capacityOverride: row.capacityOverride,
      unavailable: row.unavailable,
      activeFrom: row.unit.activeFrom ? toNight(row.unit.activeFrom) : null,
      activeUntil: row.unit.activeUntil ? toNight(row.unit.activeUntil) : null,
      holds: row.holds.map((hold) => ({ id: hold.id, firstNight: toNight(hold.firstNight), lastNight: toNight(hold.lastNight) })),
    };
    units.set(row.id, { ...state, name: row.unit.name, specialUse: row.unit.specialUse });
    meta.set(row.id, {
      name: row.unit.name,
      key: row.unit.key,
      buildingName: row.unit.building.name,
      buildingSort: row.unit.building.sortOrder,
      floor: row.unit.floor,
      // An RV site or a tent has nothing to climb.
      groundLevel: row.unit.groundLevel || row.unit.kind !== "ROOM",
    });
  }
  const segments: Segment[] = assignments.map((row) => ({
    id: row.id,
    occupantKey: (row.attendeeId ?? row.placeholderId)!,
    unitId: row.eventLodgingUnitId,
    bucketId: row.bucketId,
    people: row.people,
    firstNight: toNight(row.firstNight),
    lastNight: toNight(row.lastNight),
  }));
  return {
    context,
    unitRows,
    units,
    meta,
    buckets: bucketRows,
    bucketIds: new Set(bucketRows.map((bucket) => bucket.id)),
    assignments,
    rowsById: new Map(assignments.map((row) => [row.id, row])),
    segments,
  };
}
export type PlanningState = Awaited<ReturnType<typeof loadPlanningState>>;

/**
 * The keep-together inputs for the people given: staff rules, responsible-adult links and the registrations that asked
 * to be placeable in more than one unit. The same groups the requests screen (#199) and the review queue use.
 */
export async function loadTogetherInput(client: Client, eventId: string, people: readonly RulePerson[]): Promise<TogetherInput> {
  const [rules, authorities, requests] = await Promise.all([
    client.eventLodgingRule.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } }),
    client.guardianAuthority.findMany({ where: { eventId, state: "ACTIVE", adultPersonId: { not: null } }, select: { id: true, minorPersonId: true, adultPersonId: true, declaredAt: true } }),
    loadCurrentRequests(client, eventId),
  ]);
  const ruleRows: RuleRow[] = rules.map((rule) => ({
    id: rule.id,
    kind: rule.kind as LodgingRuleKind,
    personAId: rule.personAId,
    personBId: rule.personBId,
    effectiveFrom: rule.effectiveFrom ? toNight(rule.effectiveFrom) : null,
    effectiveUntil: rule.effectiveUntil ? toNight(rule.effectiveUntil) : null,
    ended: rule.endedAt !== null,
    reason: rule.reason,
  }));
  const guardians: GuardianLink[] = authorities.flatMap((authority) => authority.adultPersonId
    ? [{ authorityId: authority.id, minorPersonId: authority.minorPersonId, adultPersonId: authority.adultPersonId, declaredAt: authority.declaredAt.toISOString() }]
    : []);
  return {
    people,
    rules: ruleRows,
    guardians,
    flexibleRegistrationIds: requests.filter((request) => request.householdPreference === "FLEXIBLE").map((request) => request.registrationId),
  };
}
