import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  findEventSlug: vi.fn(),
  listRegistrations: vi.fn(),
  writeAuditLog: vi.fn(),
}));
const realRequirePermission = vi.hoisted(() => ({
  current: null as null | typeof import("@/modules/access/authorization").requirePermission,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/access/authorization")>();
  realRequirePermission.current = actual.requirePermission;
  return { ...actual, requirePermission: dependencies.requirePermission };
});
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
  findEventSlug: dependencies.findEventSlug,
}));
vi.mock("@/modules/registrations/repository", () => ({
  listRegistrations: dependencies.listRegistrations,
}));
vi.mock("@/modules/audit/audit-service", () => ({
  writeAuditLog: dependencies.writeAuditLog,
}));

import { GET } from "@/app/api/events/[eventId]/exports/badge-labels-csv/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import {
  badgeCsvFilename,
  badgePositionOptions,
  buildBadgeCsvRows,
} from "@/modules/checkin/badge-csv";
import { badgeTemplates } from "@/modules/checkin/badge-labels";
import { toCsv } from "@/modules/reporting/csv";
import type { RegistrationRecord } from "@/modules/registrations/repository";

// Synthetic data only.
function field(
  key: string,
  label: string,
  type: string,
  scope: "ATTENDEE" | "REGISTRATION" = "ATTENDEE",
  extra: Record<string, unknown> = {},
) {
  const isChoice = ["SELECT", "RADIO", "MULTISELECT"].includes(type);
  return {
    id: `field_${key}`, key, label, helpText: "", type, scope, required: false,
    options: isChoice ? ["Option A", "Option B"] : [], ...extra,
  };
}

function definitionWith(...fields: Array<ReturnType<typeof field>>) {
  return {
    title: "Synthetic Form",
    description: "",
    confirmationMessage: "Thanks",
    sections: [{ id: "sec_one", title: "Section", description: "", fields }],
  };
}

const goodDefinition = definitionWith(
  field("church_role", "Church role", "TEXT"),
  field("ministry_area", "Ministry area", "SELECT", "REGISTRATION"),
  field("favourite_hymn", "Title of your favourite hymn", "TEXT"),
  field("emergency_role", "Emergency contact role", "TEXT"),
  field("medical_team_role", "Medical team role or health condition", "TEXT"),
  field("guardian_title", "Guardian's title", "TEXT"),
  field("medical_question", "Any medical needs?", "RADIO"),
  field("needs_detail", "Tell us more", "TEXT", "ATTENDEE", {
    conditional: { fieldKey: "medical_question", operator: "EQUALS", value: "Option A" },
  }),
  field("notes_area", "Notes", "LONG_TEXT"),
);

function registration(
  code: string,
  attendees: Array<{ id: string; first: string; last: string; responses?: Record<string, unknown> }>,
  responses: Record<string, unknown> = {},
  definition: unknown = goodDefinition,
) {
  return {
    id: `id-${code}`,
    confirmationCode: code,
    attendees: attendees.map((attendee) => ({
      id: attendee.id,
      attendeeType: "Adult",
      firstName: attendee.first,
      lastName: attendee.last,
      responses: attendee.responses ?? {},
      passToken: "imsda-pass.v1.secret.signature",
    })),
    publicSubmission: { definition, responses },
  } as unknown as RegistrationRecord;
}

const registrations = [
  registration("REG-BBBB2222", [
    { id: "a2", first: "Zed", last: "Zimmer", responses: { church_role: "Usher" } },
  ], { ministry_area: "Option B" }),
  registration("REG-AAAA1111", [
    { id: "a1", first: "Amy", last: "Adams", responses: { church_role: "Greeter" } },
    { id: "a3", first: "=Evil", last: "Formula", responses: {} },
  ], { ministry_area: "Option A" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: { id: "user_one" } });
  dependencies.requirePermission.mockResolvedValue({ user: { id: "user_one" } });
  dependencies.findEventSlug.mockResolvedValue("womens-retreat-2026");
  dependencies.listRegistrations.mockResolvedValue(registrations);
});

function call(query = "", eventId = "event_1") {
  return GET(
    new Request(`https://events.imsda.test/api/events/${eventId}/exports/badge-labels-csv${query}`),
    { params: Promise.resolve({ eventId }) },
  );
}

describe("badge CSV Position options", () => {
  it("offers only non-sensitive text and single-choice fields", () => {
    const keys = badgePositionOptions(registrations).map((option) => option.key);
    expect(keys).toEqual(["church_role", "ministry_area", "favourite_hymn"]);
  });

  it("never offers sensitive fields, and a field that only shows after a medical question is excluded", () => {
    const keys = badgePositionOptions(registrations).map((option) => option.key);
    for (const blocked of [
      "emergency_role", "medical_team_role", "guardian_title",
      "medical_question", "needs_detail", "notes_area",
    ]) {
      expect(keys).not.toContain(blocked);
    }
  });
});

describe("badge CSV rows", () => {
  it("starts with the exact ID,Name,Position header and keeps badge order", () => {
    const rows = buildBadgeCsvRows(registrations);
    expect(rows[0]).toEqual(["ID", "Name", "Position"]);
    expect(rows.slice(1).map((row) => row[1])).toEqual(["Amy Adams", "=Evil Formula", "Zed Zimmer"]);
    expect(rows.slice(1).map((row) => row[0])).toEqual([
      "REG-AAAA1111", "REG-AAAA1111", "REG-BBBB2222",
    ]);
  });

  it("leaves Position blank when no field is chosen", () => {
    const rows = buildBadgeCsvRows(registrations);
    expect(rows.slice(1).map((row) => row[2])).toEqual(["", "", ""]);
  });

  it("uses an attendee-scope answer, blank when that attendee did not answer", () => {
    const rows = buildBadgeCsvRows(registrations, "church_role");
    expect(rows.slice(1).map((row) => row[2])).toEqual(["Greeter", "", "Usher"]);
  });

  it("carries a registration-scope answer to every attendee on it", () => {
    const rows = buildBadgeCsvRows(registrations, "ministry_area");
    expect(rows.slice(1).map((row) => row[2])).toEqual(["Option A", "Option A", "Option B"]);
  });

  it("ignores a sensitive key even if asked for directly", () => {
    const rows = buildBadgeCsvRows([
      registration("REG-CCCC3333", [
        { id: "c1", first: "Cy", last: "Cole", responses: { emergency_role: "Aunt" } },
      ]),
    ], "emergency_role");
    expect(rows[1][2]).toBe("");
  });

  it("neutralises formula injection in every cell", () => {
    const csv = toCsv(buildBadgeCsvRows(registrations));
    expect(csv).toContain('"\'=Evil Formula"');
    expect(csv).not.toMatch(/,"=/);
  });

  it("names the file safely from the event slug", () => {
    expect(badgeCsvFilename("Womens-Retreat 2026")).toBe("womens-retreat-2026-avery-94237.csv");
    expect(badgeCsvFilename("")).toBe("event-avery-94237.csv");
    const hostile = badgeCsvFilename('bad"name\r\nX-Injected: 1');
    expect(hostile).toBe("bad-name-x-injected-1-avery-94237.csv");
    expect(hostile).toMatch(/^[a-z0-9.-]+$/);
  });
});

describe("badge CSV option labels, form names and mixed form versions", () => {
  const withForm = (base: RegistrationRecord, formName: string) => ({
    ...base,
    publicSubmission: { ...base.publicSubmission, formName },
  }) as unknown as RegistrationRecord;

  it("exports the option label of a SELECT answer, not the stored value", () => {
    const definition = definitionWith(
      field("ministry_area", "Ministry area", "SELECT", "REGISTRATION", {
        options: ["music", "welcome"],
        optionLabels: { music: "Music ministry", welcome: "Welcome team" },
      }),
    );
    const rows = buildBadgeCsvRows([
      registration("REG-DDDD4444", [{ id: "d1", first: "Di", last: "Dale" }], { ministry_area: "music" }, definition),
      registration("REG-EEEE5555", [{ id: "e1", first: "Ed", last: "Eve" }], { ministry_area: "other" }, definition),
    ], "ministry_area");
    expect(rows.slice(1).map((row) => row[2])).toEqual(["Music ministry", "other"]);
  });

  it("names the forms when the same key is offered by more than one form", () => {
    const options = badgePositionOptions([
      withForm(registration("REG-A", [{ id: "x1", first: "A", last: "A" }]), "Retreat form"),
      withForm(registration("REG-B", [{ id: "x2", first: "B", last: "B" }]), "Camp form"),
    ]);
    expect(options.find((option) => option.key === "church_role")?.label)
      .toBe("Church role (Camp form, Retreat form)");
    const single = badgePositionOptions([
      withForm(registration("REG-C", [{ id: "x3", first: "C", last: "C" }]), "Retreat form"),
    ]);
    expect(single.find((option) => option.key === "church_role")?.label).toBe("Church role");
  });

  it.each([
    ["sensitive", definitionWith(field("church_role", "Church role or health condition", "TEXT"))],
    ["conditional on a medical question", definitionWith(
      field("medical_question", "Any medical needs?", "RADIO"),
      field("church_role", "Church role", "TEXT", "ATTENDEE", {
        conditional: { fieldKey: "medical_question", operator: "EQUALS", value: "Option A" },
      }),
    )],
  ])("leaves Position blank for a registration whose form version makes the key %s", (_name, otherDefinition) => {
    const rows = buildBadgeCsvRows([
      registration("REG-AAAA1111", [{ id: "m1", first: "Amy", last: "Adams", responses: { church_role: "Greeter" } }]),
      registration("REG-BBBB2222", [{ id: "m2", first: "Bo", last: "Brown", responses: { church_role: "Secret" } }], {}, otherDefinition),
    ], "church_role");
    expect(rows.slice(1)).toEqual([
      ["REG-AAAA1111", "Amy Adams", "Greeter"],
      ["REG-BBBB2222", "Bo Brown", ""],
    ]);
  });
});

describe("badge CSV route", () => {
  it("returns private, no-store CSV with the right headers and an audit row with counts only", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(dependencies.requirePermission).toHaveBeenCalledWith(
      expect.anything(), "event_1", "MANAGE_CHECK_IN", dependencies.findActiveMembership,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="womens-retreat-2026-avery-94237.csv"',
    );
    const body = await response.text();
    expect(body.startsWith('"ID","Name","Position"\r\n')).toBe(true);
    expect(body).not.toContain("imsda-pass");
    expect(dependencies.writeAuditLog).toHaveBeenCalledTimes(1);
    const audit = dependencies.writeAuditLog.mock.calls[0][0];
    expect(audit.metadata).toEqual({ rowCount: 3 });
    expect(JSON.stringify(audit)).not.toMatch(/Adams|Zimmer|Formula/);
  });

  it("fills Position from an eligible chosen field", async () => {
    const body = await (await call("?positionField=church_role")).text();
    expect(body).toContain('"REG-AAAA1111","Amy Adams","Greeter"');
  });

  it.each(["emergency_role", "medical_team_role", "guardian_title", "needs_detail", "no_such_field"])(
    "rejects the ineligible Position field %s with 400 before anything is audited",
    async (key) => {
      const response = await call(`?positionField=${key}`);
      expect(response.status).toBe(400);
      expect(dependencies.writeAuditLog).not.toHaveBeenCalled();
    },
  );

  it("reads only active registrations, like the badge page", async () => {
    await call();
    expect(dependencies.listRegistrations.mock.calls[0][1].statuses).toEqual(["SUBMITTED", "CONFIRMED"]);
  });

  it("returns 404 for an unknown event and writes no audit row", async () => {
    dependencies.findEventSlug.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(404);
    expect(dependencies.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses staff without MANAGE_CHECK_IN and reads nothing", async () => {
    dependencies.requirePermission.mockRejectedValue(
      new AccessDeniedError("The MANAGE_CHECK_IN permission is required for this event.", 403, "PERMISSION_DENIED"),
    );
    const response = await call();
    expect(response.status).toBe(403);
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
    expect(dependencies.writeAuditLog).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    dependencies.requirePermission.mockImplementation(realRequirePermission.current!);
    dependencies.getCurrentSession.mockResolvedValue({ user: null });
    const response = await call();
    expect(response.status).toBe(401);
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
    expect(dependencies.writeAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 for a member of another event", async () => {
    dependencies.requirePermission.mockImplementation(realRequirePermission.current!);
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "user_one", email: "staff@example.test", displayName: "Staff" },
    });
    dependencies.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => (
      eventId === "event_a"
        ? { eventId, userId, role: "CHECK_IN_STAFF", status: "ACTIVE", permissions: ["MANAGE_CHECK_IN"] }
        : null
    ));
    const refused = await call("", "event_b");
    expect(refused.status).toBe(403);
    expect(dependencies.listRegistrations).not.toHaveBeenCalled();
    expect((await call("", "event_a")).status).toBe(200);
  });

  it("puts only a sanitised slug in Content-Disposition", async () => {
    dependencies.findEventSlug.mockResolvedValue('x"\r\nSet-Cookie: a=b');
    const response = await call();
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="x-set-cookie-a-b-avery-94237.csv"',
    );
  });
});

describe("Presta 94237 sheet geometry", () => {
  const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const block = css.match(/\.badge-sheet-avery-presta-94237 \{([\s\S]*?)\n\}/)![1];
  const inches = (name: string) => {
    const match = block.match(new RegExp(`${name}:\\s*([\\d.]+)in`));
    expect(match, name).not.toBeNull();
    return Number(match![1]);
  };

  it("adds up to 8.5 x 11 inches from the custom properties and the slot size", () => {
    const { slotWidthIn, slotHeightIn, perSheet } = badgeTemplates["avery-presta-94237"];
    const across = 2 * inches("--sheet-pad-left") + 2 * slotWidthIn + inches("--col-gap");
    const down = 2 * inches("--sheet-pad-top") + 4 * slotHeightIn + 3 * inches("--row-gap");
    expect(perSheet).toBe(8);
    expect(across).toBeCloseTo(8.5, 4);
    expect(down).toBeCloseTo(11, 4);
  });
});
