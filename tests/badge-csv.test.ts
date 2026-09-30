import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  getEventSettings: vi.fn(),
  listRegistrations: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/access/authorization")>();
  return { ...actual, requirePermission: dependencies.requirePermission };
});
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
  getEventSettings: dependencies.getEventSettings,
}));
vi.mock("@/modules/registrations/repository", () => ({
  listRegistrations: dependencies.listRegistrations,
}));
vi.mock("@/modules/audit/audit-service", () => ({
  writeAuditLog: dependencies.writeAuditLog,
}));

import { GET } from "@/app/api/events/[eventId]/exports/badge-labels-csv/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { badgeCsvFilename, buildBadgeCsvRows } from "@/modules/checkin/badge-csv";
import { badgeTemplates } from "@/modules/checkin/badge-labels";
import { toCsv } from "@/modules/reporting/csv";
import type { RegistrationRecord } from "@/modules/registrations/repository";

const definitionWithPosition = {
  sections: [{
    fields: [
      { key: "shirt_size", label: "Shirt size", scope: "ATTENDEE" },
      { key: "ministry_role", label: "Ministry role", scope: "ATTENDEE" },
    ],
  }],
};
const definitionWithoutPosition = {
  sections: [{ fields: [{ key: "shirt_size", label: "Shirt size", scope: "ATTENDEE" }] }],
};

function registration(
  code: string,
  attendees: Array<{ id: string; first: string; last: string; responses?: Record<string, unknown> }>,
  definition: unknown = definitionWithPosition,
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
    publicSubmission: { definition },
  } as unknown as RegistrationRecord;
}

const registrations = [
  registration("REG-BBBB2222", [
    { id: "a2", first: "Zed", last: "Zimmer", responses: { ministry_role: "Usher" } },
  ]),
  registration("REG-AAAA1111", [
    { id: "a1", first: "Amy", last: "Adams", responses: { ministry_role: ["Greeter", "Prayer team"] } },
    { id: "a3", first: "=Evil", last: "Formula", responses: {} },
  ]),
];

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: { id: "user_one" } });
  dependencies.requirePermission.mockResolvedValue({ user: { id: "user_one" } });
  dependencies.getEventSettings.mockResolvedValue({ slug: "womens-retreat-2026" });
  dependencies.listRegistrations.mockResolvedValue(registrations);
});

function call() {
  return GET(
    new Request("https://events.imsda.test/api/events/event_1/exports/badge-labels-csv"),
    { params: Promise.resolve({ eventId: "event_1" }) },
  );
}

describe("badge CSV rows", () => {
  it("starts with the exact ID,Name,Position header and keeps badge order", () => {
    const rows = buildBadgeCsvRows(registrations);
    expect(rows[0]).toEqual(["ID", "Name", "Position"]);
    // Sorted by last name, exactly like the printed badges.
    expect(rows.slice(1).map((row) => row[1])).toEqual([
      "Amy Adams",
      "=Evil Formula",
      "Zed Zimmer",
    ]);
    expect(rows.slice(1).map((row) => row[0])).toEqual([
      "REG-AAAA1111",
      "REG-AAAA1111",
      "REG-BBBB2222",
    ]);
  });

  it("maps Position from a position-like field, blank when the field or answer is absent", () => {
    const rows = buildBadgeCsvRows(registrations);
    expect(rows[1][2]).toBe("Greeter; Prayer team");
    expect(rows[2][2]).toBe("");
    expect(rows[3][2]).toBe("Usher");
    const none = buildBadgeCsvRows([
      registration("REG-CCCC3333", [
        { id: "c1", first: "Cy", last: "Cole", responses: { shirt_size: "Adult L" } },
      ], definitionWithoutPosition),
    ]);
    expect(none[1]).toEqual(["REG-CCCC3333", "Cy Cole", ""]);
  });

  it("never uses the attendee type as a position", () => {
    const rows = buildBadgeCsvRows(registrations);
    expect(rows.flat()).not.toContain("Adult");
  });

  it("neutralises formula injection in every cell", () => {
    const csv = toCsv(buildBadgeCsvRows(registrations));
    expect(csv).toContain('"\'=Evil Formula"');
    expect(csv).not.toMatch(/,"=/);
  });

  it("names the file after the event slug", () => {
    expect(badgeCsvFilename("Womens-Retreat 2026")).toBe("womens-retreat-2026-avery-94237.csv");
    expect(badgeCsvFilename("")).toBe("event-avery-94237.csv");
  });
});

describe("badge CSV route", () => {
  it("returns private, no-store CSV with the right headers and an audit row with counts only", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(dependencies.requirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "event_1",
      "MANAGE_CHECK_IN",
      dependencies.findActiveMembership,
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

  it("reads only active registrations, like the badge page", async () => {
    await call();
    const options = dependencies.listRegistrations.mock.calls[0][1];
    expect(options.statuses).toEqual(["SUBMITTED", "CONFIRMED"]);
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
    expect(inches("--sheet-pad-left")).toBe(0.85);
    expect(inches("--col-gap")).toBe(0.8);
    expect(inches("--sheet-pad-top")).toBe(1);
  });
});
