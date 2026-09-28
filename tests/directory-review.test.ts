import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { listDirectoryReviewEntries } from "@/modules/forms/directory-review";

/**
 * The staff review list for "Not listed" directory answers (#482): every
 * active registration that couldn't find its club or church in the live
 * directory, with the free text the director typed instead. Nothing here is
 * blocked from registering — only surfaced for staff to reconcile.
 */
const directoryDefinition = {
  title: "Honors Weekend registration",
  description: "",
  confirmationMessage: "Done",
  sections: [{
    id: "s_club",
    title: "Club & contact",
    description: "",
    fields: [
      { id: "f_club", key: "club_name", label: "Pathfinder club", helpText: "", type: "SELECT", scope: "REGISTRATION", required: true, options: [], optionSource: "CLUBS_DIRECTORY" },
      { id: "f_club_other", key: "club_name_other", label: "Club — not listed", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [], conditional: { fieldKey: "club_name", operator: "EQUALS", value: "Not listed" } },
      { id: "f_church", key: "church_name", label: "Church", helpText: "", type: "SELECT", scope: "REGISTRATION", required: false, options: [], optionSource: "CHURCHES_DIRECTORY" },
    ],
  }],
};

const plainDefinition = {
  title: "Simple RSVP",
  description: "",
  confirmationMessage: "Done",
  sections: [{ id: "s", title: "Section", description: "", fields: [
    { id: "f_email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
  ] }],
};

function fixture(forms: Array<{ versions: Array<{ id: string; definition: unknown }> }>, submissions: Array<{
  formVersionId: string;
  responses: Record<string, unknown>;
  registration: { id: string; confirmationCode: string; operations?: Array<{ afterSnapshot: unknown }> };
}>) {
  const db = {
    registrationForm: { findMany: vi.fn().mockResolvedValue(forms) },
    publicRegistrationSubmission: { findMany: vi.fn().mockResolvedValue(submissions) },
  };
  dependencies.getPrisma.mockReturnValue(db);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listDirectoryReviewEntries", () => {
  it("lists a \"Not listed\" club answer with its free text", async () => {
    const db = fixture(
      [{ versions: [{ id: "version-1", definition: directoryDefinition }] }],
      [{
        formVersionId: "version-1",
        responses: { club_name: "Not listed", club_name_other: "Made-Up Club" },
        registration: { id: "registration-1", confirmationCode: "REG-1" },
      }],
    );

    const entries = await listDirectoryReviewEntries("event-1");
    expect(entries).toEqual([{
      registrationId: "registration-1",
      confirmationCode: "REG-1",
      source: "CLUBS_DIRECTORY",
      fieldLabel: "Pathfinder club",
      freeText: "Made-Up Club",
    }]);
    expect(db.publicRegistrationSubmission.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } }),
    }));
  });

  it("skips a registration that matched a real directory entry", async () => {
    fixture(
      [{ versions: [{ id: "version-1", definition: directoryDefinition }] }],
      [{
        formVersionId: "version-1",
        responses: { club_name: "Test Pathfinders", church_name: "Test SDA Church" },
        registration: { id: "registration-1", confirmationCode: "REG-1" },
      }],
    );
    expect(await listDirectoryReviewEntries("event-1")).toEqual([]);
  });

  it("reports both a not-listed club and a not-listed church on the same registration", async () => {
    fixture(
      [{ versions: [{ id: "version-1", definition: directoryDefinition }] }],
      [{
        formVersionId: "version-1",
        responses: { club_name: "Not listed", club_name_other: "New Club", church_name: "Not listed" },
        registration: { id: "registration-1", confirmationCode: "REG-1" },
      }],
    );
    const entries = await listDirectoryReviewEntries("event-1");
    expect(entries.map((entry) => entry.source)).toEqual(["CLUBS_DIRECTORY", "CHURCHES_DIRECTORY"]);
    expect(entries[1]!.freeText).toBe("");
  });

  it("reads the latest amendment's answers, so an entry staff corrected to a real club drops off", async () => {
    fixture(
      [{ versions: [{ id: "version-1", definition: directoryDefinition }] }],
      [{
        formVersionId: "version-1",
        responses: { club_name: "Not listed", club_name_other: "Made-Up Club" },
        registration: {
          id: "registration-1",
          confirmationCode: "REG-1",
          operations: [{ afterSnapshot: { registrationResponses: { club_name: "Test Pathfinders", club_name_other: null } } }],
        },
      }, {
        formVersionId: "version-1",
        responses: { club_name: "Test Pathfinders" },
        registration: {
          id: "registration-2",
          confirmationCode: "REG-2",
          operations: [{ afterSnapshot: { registrationResponses: { club_name: "Test Pathfinders", church_name: "Not listed", church_name_other: "Test Chapel" } } }],
        },
      }],
    );
    const entries = await listDirectoryReviewEntries("event-1");
    expect(entries).toEqual([expect.objectContaining({ registrationId: "registration-2", source: "CHURCHES_DIRECTORY" })]);
  });

  it("skips the database entirely when no form for the event uses a directory source", async () => {
    const db = fixture([{ versions: [{ id: "version-1", definition: plainDefinition }] }], []);
    expect(await listDirectoryReviewEntries("event-1")).toEqual([]);
    expect(db.publicRegistrationSubmission.findMany).not.toHaveBeenCalled();
  });
});
