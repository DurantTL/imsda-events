import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn(() => { throw new Error("use the client passed in"); }) }));

import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  hasDirectoryOptionSource,
  stripDirectoryOptions,
  withDirectoryOptions,
} from "@/modules/organizations/directory-form-options";
import { getOrganizationDirectory } from "@/modules/organizations/directory-options";
import { hydrateFormOptions } from "@/modules/forms/form-options-repository";

const directory = { clubs: ["Test Pathfinders", "Sample Explorers"], churches: ["Test SDA Church"], schools: ["Sample Junior Academy"] };

const sourcedDefinition = registrationFormDefinitionSchema.parse({
  title: "Directory-sourced form",
  description: "",
  confirmationMessage: "Done",
  sections: [{
    id: "s_contact",
    title: "Contact",
    description: "",
    fields: [
      { id: "f_club", key: "club_name", label: "Club", helpText: "", type: "SELECT", scope: "REGISTRATION", required: true, options: [], optionSource: "CLUBS_DIRECTORY" },
      { id: "f_church", key: "church_name", label: "Church", helpText: "", type: "SELECT", scope: "REGISTRATION", required: false, options: [], optionSource: "CHURCHES_DIRECTORY" },
      { id: "f_email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
    ],
  }],
});

const plainDefinition = registrationFormDefinitionSchema.parse({
  title: "Plain form",
  description: "",
  confirmationMessage: "Done",
  sections: [{ id: "s_email", title: "Section", description: "", fields: [
    { id: "f_email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
  ] }],
});

describe("directory form options (#482)", () => {
  it("reports whether a definition uses a directory option source", () => {
    expect(hasDirectoryOptionSource(sourcedDefinition)).toBe(true);
    expect(hasDirectoryOptionSource(plainDefinition)).toBe(false);
  });

  it("hydrates a directory-sourced field with the live directory plus \"Not listed\"", () => {
    const hydrated = withDirectoryOptions(sourcedDefinition, directory);
    const fields = hydrated.sections[0].fields;
    expect(fields.find((f) => f.key === "club_name")!.options).toEqual(["Test Pathfinders", "Sample Explorers", "Not listed"]);
    expect(fields.find((f) => f.key === "church_name")!.options).toEqual(["Test SDA Church", "Not listed"]);
    // An ordinary field is untouched.
    expect(fields.find((f) => f.key === "email")!.options).toEqual([]);
  });

  it("leaves a form with no directory field untouched", () => {
    expect(withDirectoryOptions(plainDefinition, directory)).toBe(plainDefinition);
  });

  it("strips hydrated options back out before persisting, leaving only the source designation", () => {
    const hydrated = withDirectoryOptions(sourcedDefinition, directory);
    const stripped = stripDirectoryOptions(hydrated);
    const club = stripped.sections[0].fields.find((f) => f.key === "club_name")!;
    expect(club.options).toEqual([]);
    expect(club.optionSource).toBe("CLUBS_DIRECTORY");
  });

  it("round-trips: stripped-and-rehydrated options match a direct hydration", () => {
    const hydrated = withDirectoryOptions(sourcedDefinition, directory);
    const rehydrated = withDirectoryOptions(stripDirectoryOptions(hydrated), directory);
    expect(rehydrated).toEqual(hydrated);
  });

  it("keeps a registration's own historical club or church as a choice, but never re-adds \"Not listed\" twice", () => {
    const hydrated = withDirectoryOptions(sourcedDefinition, directory, { club_name: "Renamed Test Club", church_name: "Not listed" });
    const fields = hydrated.sections[0].fields;
    expect(fields.find((f) => f.key === "club_name")!.options).toEqual(["Test Pathfinders", "Sample Explorers", "Renamed Test Club", "Not listed"]);
    expect(fields.find((f) => f.key === "church_name")!.options).toEqual(["Test SDA Church", "Not listed"]);
  });
});

type DirectoryRow = { name: string; normalizedName: string };

function organizationClient(rows: Record<string, DirectoryRow[]>) {
  return {
    organization: {
      findMany: vi.fn(async ({ where }: { where: { type: string | { in: string[] }; isActive: boolean } }) => {
        expect(where.isActive).toBe(true);
        const types = typeof where.type === "string" ? [where.type] : where.type.in;
        return types.flatMap((type) => rows[type] ?? []);
      }),
    },
  };
}

describe("live directory reads (#482)", () => {
  it("returns active names only, one per normalized name, in a stable order", async () => {
    const client = organizationClient({
      CLUB: [
        { name: "Test Pathfinders", normalizedName: "test pathfinders" },
        { name: "test  Pathfinders", normalizedName: "test pathfinders" },
        { name: "Sample Explorers", normalizedName: "sample explorers" },
      ],
      CHURCH: [{ name: "Test SDA Church", normalizedName: "test sda church" }],
      SCHOOL: [{ name: "Sample Junior Academy", normalizedName: "sample junior academy" }],
    });
    const result = await getOrganizationDirectory(client as never);
    expect(result).toEqual({ clubs: ["Test Pathfinders", "Sample Explorers"], churches: ["Test SDA Church"], schools: ["Sample Junior Academy"] });
    expect(client.organization.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { type: { in: ["CHURCH", "COMPANY", "GROUP"] }, isActive: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { name: true, normalizedName: true },
    }));
  });

  it("hydrates through the client it is given, and never reads the directory for a form without a directory field", async () => {
    const client = organizationClient({ CLUB: [{ name: "Test Pathfinders", normalizedName: "test pathfinders" }], CHURCH: [] });
    const hydrated = await hydrateFormOptions(sourcedDefinition, { client: client as never });
    expect(hydrated.sections[0].fields[0].options).toEqual(["Test Pathfinders", "Not listed"]);
    expect(client.organization.findMany).toHaveBeenCalledTimes(3);

    const untouched = organizationClient({ CLUB: [], CHURCH: [] });
    expect(await hydrateFormOptions(plainDefinition, { client: untouched as never })).toBe(plainDefinition);
    expect(untouched.organization.findMany).not.toHaveBeenCalled();
  });
});