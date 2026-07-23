import { createHash } from "node:crypto";
import { toCsv } from "@/modules/reporting/csv";

export type RankedAssignmentParticipantSource = {
  attendeeId: string;
  registrationId: string;
  registrationStatus: "SUBMITTED" | "CONFIRMED";
  confirmationCode: string;
  submittedAt: string | null;
  attendeePosition: number;
  firstName: string;
  lastName: string;
  attendeeType: string;
  preferences: unknown;
};

export type RankedAssignmentSource = {
  eventId: string;
  formId: string;
  formName: string;
  formVersionId: string;
  formVersionNumber: number;
  fieldId: string;
  fieldKey: string;
  fieldLabel: string;
  options: string[];
  choiceLimits: Record<string, number>;
  participants: RankedAssignmentParticipantSource[];
};

export type RankedAttendeeAssignment = {
  attendeeId: string;
  registrationId: string;
  confirmationCode: string;
  submittedAt: string | null;
  attendeePosition: number;
  stableOrder: number;
  firstName: string;
  lastName: string;
  attendeeType: string;
  preferences: string[];
  assignedOption: string | null;
  preferenceRank: number | null;
  outcome: "ASSIGNED" | "UNASSIGNED";
  unassignedReason: "NO_RANKED_CHOICES" | "CAPACITY_FULL" | null;
};

export type RankedChoiceAssignmentSummary = {
  option: string;
  capacity: number | null;
  capacityMode: "LIMITED" | "UNLIMITED_MISSING";
  demand: number;
  firstChoiceDemand: number;
  secondChoiceDemand: number;
  assigned: number;
  firstChoiceAssigned: number;
  secondChoiceAssigned: number;
  lowerChoiceAssigned: number;
  remaining: number | null;
};

export type RankedAssignmentPreview = {
  sourceFingerprint: string;
  eventId: string;
  formId: string;
  formName: string;
  formVersionId: string;
  formVersionNumber: number;
  fieldId: string;
  fieldKey: string;
  fieldLabel: string;
  generatedAt: string;
  summary: {
    attendees: number;
    assigned: number;
    firstChoiceAssigned: number;
    secondChoiceAssigned: number;
    lowerChoiceAssigned: number;
    unassigned: number;
    noRankedChoices: number;
    limitedOptions: number;
    unlimitedOptions: number;
  };
  choices: RankedChoiceAssignmentSummary[];
  assignments: RankedAttendeeAssignment[];
};

type Cost = readonly [nonFirst: number, rankPenalty: number, attendeeOrder: number, optionOrder: number];
type FlowEdge = {
  to: number;
  reverseIndex: number;
  capacity: number;
  cost: Cost;
};

const zeroCost: Cost = [0, 0, 0, 0];

function addCost(left: Cost, right: Cost): Cost {
  return [
    left[0] + right[0],
    left[1] + right[1],
    left[2] + right[2],
    left[3] + right[3],
  ];
}

function negateCost(cost: Cost): Cost {
  return [-cost[0], -cost[1], -cost[2], -cost[3]];
}

function compareCost(left: Cost, right: Cost) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function addFlowEdge(
  graph: FlowEdge[][],
  from: number,
  to: number,
  capacity: number,
  cost: Cost,
) {
  const forward: FlowEdge = {
    to,
    reverseIndex: graph[to].length,
    capacity,
    cost,
  };
  const reverse: FlowEdge = {
    to: from,
    reverseIndex: graph[from].length,
    capacity: 0,
    cost: negateCost(cost),
  };
  graph[from].push(forward);
  graph[to].push(reverse);
  return forward;
}

function normalizeText(value: string, fallback: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function normalizeOptions(options: string[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option)) return false;
    seen.add(option);
    return true;
  });
}

function stableParticipants(participants: RankedAssignmentParticipantSource[]) {
  return [...participants].sort((left, right) => (
    (left.submittedAt ?? "9999-12-31T23:59:59.999Z").localeCompare(
      right.submittedAt ?? "9999-12-31T23:59:59.999Z",
    )
    || left.registrationId.localeCompare(right.registrationId)
    || left.attendeePosition - right.attendeePosition
    || left.attendeeId.localeCompare(right.attendeeId)
  ));
}

function rankedPreferences(value: unknown, configuredOptions: Set<string>) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((choice): choice is string => {
    if (typeof choice !== "string" || !configuredOptions.has(choice) || seen.has(choice)) {
      return false;
    }
    seen.add(choice);
    return true;
  });
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function assignmentSourceFingerprint(
  source: RankedAssignmentSource,
) {
  const options = normalizeOptions(source.options);
  const configuredOptions = new Set(options);
  const fingerprintSource = {
    eventId: source.eventId,
    formId: source.formId,
    formVersionId: source.formVersionId,
    formVersionNumber: source.formVersionNumber,
    fieldId: source.fieldId,
    fieldKey: source.fieldKey,
    fieldLabel: source.fieldLabel,
    options,
    choiceLimits: Object.fromEntries(options.map((option) => [
      option,
      source.choiceLimits[option] ?? null,
    ])),
    participants: stableParticipants(source.participants).map((participant) => ({
      attendeeId: participant.attendeeId,
      registrationId: participant.registrationId,
      registrationStatus: participant.registrationStatus,
      confirmationCode: participant.confirmationCode,
      submittedAt: participant.submittedAt,
      attendeePosition: participant.attendeePosition,
      firstName: participant.firstName,
      lastName: participant.lastName,
      attendeeType: participant.attendeeType,
      preferences: rankedPreferences(participant.preferences, configuredOptions),
    })),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(fingerprintSource)))
    .digest("hex");
}

/**
 * Runs a deterministic minimum-cost maximum-flow assignment.
 *
 * Flow cardinality maximizes the number assigned. The tuple cost then minimizes
 * non-first choices, total lower-rank distance, attendee source order, and form
 * option order—in that order—without unsafe large-number weighting.
 */
export function buildRankedAssignmentPreview(
  source: RankedAssignmentSource,
  now = new Date(),
): RankedAssignmentPreview {
  const options = normalizeOptions(source.options);
  const configuredOptions = new Set(options);
  const participants = stableParticipants(source.participants).map((participant) => ({
    ...participant,
    firstName: normalizeText(participant.firstName, "Unknown"),
    lastName: normalizeText(participant.lastName, "attendee"),
    preferences: rankedPreferences(participant.preferences, configuredOptions),
  }));

  const sourceNode = 0;
  const participantOffset = 1;
  const optionOffset = participantOffset + participants.length;
  const sinkNode = optionOffset + options.length;
  const graph: FlowEdge[][] = Array.from({ length: sinkNode + 1 }, () => []);
  const preferenceEdges = new Map<string, Array<{ option: string; rank: number; edge: FlowEdge }>>();

  participants.forEach((participant, participantIndex) => {
    const participantNode = participantOffset + participantIndex;
    addFlowEdge(graph, sourceNode, participantNode, 1, zeroCost);
    const edges: Array<{ option: string; rank: number; edge: FlowEdge }> = [];
    participant.preferences.forEach((option, preferenceIndex) => {
      const optionIndex = options.indexOf(option);
      const rank = preferenceIndex + 1;
      const edge = addFlowEdge(
        graph,
        participantNode,
        optionOffset + optionIndex,
        1,
        [
          rank === 1 ? 0 : 1,
          rank === 1 ? 0 : rank - 1,
          participantIndex,
          optionIndex,
        ],
      );
      edges.push({ option, rank, edge });
    });
    preferenceEdges.set(participant.attendeeId, edges);
  });

  options.forEach((option, optionIndex) => {
    const configuredLimit = source.choiceLimits[option];
    const capacity = Number.isInteger(configuredLimit) && configuredLimit > 0
      ? Math.min(configuredLimit, participants.length)
      : participants.length;
    addFlowEdge(graph, optionOffset + optionIndex, sinkNode, capacity, zeroCost);
  });

  while (true) {
    const distances: Array<Cost | null> = Array.from({ length: graph.length }, () => null);
    const previousNode = Array.from({ length: graph.length }, () => -1);
    const previousEdge = Array.from({ length: graph.length }, () => -1);
    distances[sourceNode] = zeroCost;

    for (let pass = 0; pass < graph.length - 1; pass += 1) {
      let changed = false;
      for (let node = 0; node < graph.length; node += 1) {
        const distance = distances[node];
        if (!distance) continue;
        graph[node].forEach((edge, edgeIndex) => {
          if (edge.capacity <= 0) return;
          const candidate = addCost(distance, edge.cost);
          const existing = distances[edge.to];
          if (existing && compareCost(candidate, existing) >= 0) return;
          distances[edge.to] = candidate;
          previousNode[edge.to] = node;
          previousEdge[edge.to] = edgeIndex;
          changed = true;
        });
      }
      if (!changed) break;
    }

    if (!distances[sinkNode]) break;
    let node = sinkNode;
    while (node !== sourceNode) {
      const from = previousNode[node];
      const edgeIndex = previousEdge[node];
      if (from < 0 || edgeIndex < 0) {
        throw new Error("Assignment flow path was incomplete.");
      }
      const edge = graph[from][edgeIndex];
      edge.capacity -= 1;
      graph[node][edge.reverseIndex].capacity += 1;
      node = from;
    }
  }

  const assignments: RankedAttendeeAssignment[] = participants.map((participant, stableOrder) => {
    const selected = preferenceEdges.get(participant.attendeeId)
      ?.find(({ edge }) => edge.capacity === 0);
    const assignedOption = selected?.option ?? null;
    const preferenceRank = selected?.rank ?? null;
    return {
      attendeeId: participant.attendeeId,
      registrationId: participant.registrationId,
      confirmationCode: participant.confirmationCode,
      submittedAt: participant.submittedAt,
      attendeePosition: participant.attendeePosition,
      stableOrder,
      firstName: participant.firstName,
      lastName: participant.lastName,
      attendeeType: participant.attendeeType,
      preferences: participant.preferences,
      assignedOption,
      preferenceRank,
      outcome: assignedOption ? "ASSIGNED" : "UNASSIGNED",
      unassignedReason: assignedOption
        ? null
        : participant.preferences.length === 0
          ? "NO_RANKED_CHOICES"
          : "CAPACITY_FULL",
    };
  });

  const choices = options.map((option): RankedChoiceAssignmentSummary => {
    const capacity = source.choiceLimits[option] ?? null;
    const interested = assignments.filter((assignment) => (
      assignment.preferences.includes(option)
    ));
    const assigned = assignments.filter((assignment) => (
      assignment.assignedOption === option
    ));
    return {
      option,
      capacity,
      capacityMode: capacity === null ? "UNLIMITED_MISSING" : "LIMITED",
      demand: interested.length,
      firstChoiceDemand: interested.filter((assignment) => (
        assignment.preferences[0] === option
      )).length,
      secondChoiceDemand: interested.filter((assignment) => (
        assignment.preferences[1] === option
      )).length,
      assigned: assigned.length,
      firstChoiceAssigned: assigned.filter((assignment) => assignment.preferenceRank === 1).length,
      secondChoiceAssigned: assigned.filter((assignment) => assignment.preferenceRank === 2).length,
      lowerChoiceAssigned: assigned.filter((assignment) => (
        assignment.preferenceRank !== null && assignment.preferenceRank > 2
      )).length,
      remaining: capacity === null ? null : Math.max(capacity - assigned.length, 0),
    };
  });
  const assigned = assignments.filter((assignment) => assignment.outcome === "ASSIGNED");

  return {
    sourceFingerprint: assignmentSourceFingerprint(source),
    eventId: source.eventId,
    formId: source.formId,
    formName: source.formName,
    formVersionId: source.formVersionId,
    formVersionNumber: source.formVersionNumber,
    fieldId: source.fieldId,
    fieldKey: source.fieldKey,
    fieldLabel: source.fieldLabel,
    generatedAt: now.toISOString(),
    summary: {
      attendees: assignments.length,
      assigned: assigned.length,
      firstChoiceAssigned: assigned.filter((assignment) => assignment.preferenceRank === 1).length,
      secondChoiceAssigned: assigned.filter((assignment) => assignment.preferenceRank === 2).length,
      lowerChoiceAssigned: assigned.filter((assignment) => (
        assignment.preferenceRank !== null && assignment.preferenceRank > 2
      )).length,
      unassigned: assignments.length - assigned.length,
      noRankedChoices: assignments.filter((assignment) => (
        assignment.unassignedReason === "NO_RANKED_CHOICES"
      )).length,
      limitedOptions: choices.filter((choice) => choice.capacityMode === "LIMITED").length,
      unlimitedOptions: choices.filter((choice) => choice.capacityMode === "UNLIMITED_MISSING").length,
    },
    choices,
    assignments,
  };
}

export type AppliedAssignmentRoster = {
  id: string;
  eventName: string;
  formName: string;
  formVersionNumber: number;
  fieldLabel: string;
  appliedAt: string;
  appliedByName: string;
  assignments: RankedAttendeeAssignment[];
};

export function programAssignmentRosterCsv(roster: AppliedAssignmentRoster) {
  const rows: Array<Array<string | number>> = [[
    "Assignment",
    "Preference rank",
    "Attendee last name",
    "Attendee first name",
    "Attendee type",
    "Confirmation code",
    "Outcome",
  ]];
  for (const assignment of roster.assignments) {
    rows.push([
      assignment.assignedOption ?? "Unassigned",
      assignment.preferenceRank ?? "",
      assignment.lastName,
      assignment.firstName,
      assignment.attendeeType,
      assignment.confirmationCode,
      assignment.unassignedReason === "NO_RANKED_CHOICES"
        ? "No ranked choices"
        : assignment.unassignedReason === "CAPACITY_FULL"
          ? "No room remained"
          : "Assigned",
    ]);
  }
  return toCsv(rows);
}
