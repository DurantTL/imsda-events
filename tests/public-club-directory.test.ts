import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ organization: { findMany: mocks.findMany } }) }));

import { listPublicClubs } from "@/modules/organizations/public-club-directory";

const disallowedFields = [
  "contactEmail",
  "contactPhone",
  "publicDescription",
  "meetingPlace",
  "director",
  "directors",
  "email",
  "phone",
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("public club directory privacy filter (#437)", () => {
  it("queries only listed, active clubs under an active church", async () => {
    mocks.findMany.mockResolvedValue([]);
    await listPublicClubs();
    expect(mocks.findMany).toHaveBeenCalledOnce();
    const call = mocks.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      type: "CLUB",
      isActive: true,
      clubProfile: { listPublicly: true },
      parentOrganization: { isActive: true },
    });
  });

  it("selects nothing beyond church name, club name, town, meeting time, and coordinates", async () => {
    mocks.findMany.mockResolvedValue([]);
    await listPublicClubs();
    const call = mocks.findMany.mock.calls[0][0];
    const select = call.select;
    // The exact contract: nothing else is ever fetched, so nothing else can
    // ever leak into the DTO, no matter what changes downstream.
    expect(select).toEqual({
      id: true,
      name: true,
      clubProfile: { select: { meetingSchedule: true } },
      parentOrganization: {
        select: {
          name: true,
          churchLocation: {
            select: { city: true, state: true, zip: true, latitude: true, longitude: true },
          },
        },
      },
    });
    const flattened = JSON.stringify(select).toLowerCase();
    for (const field of disallowedFields) {
      expect(flattened).not.toContain(field.toLowerCase());
    }
  });

  it("shapes the DTO to only the allowed public fields", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "club-1",
      name: "Trailblazers",
      clubProfile: { meetingSchedule: "Sundays, 2-4pm" },
      parentOrganization: {
        name: "First Church",
        churchLocation: { city: "Ames", state: "IA", zip: "50010", latitude: 42.03, longitude: -93.62 },
      },
    }]);
    const clubs = await listPublicClubs();
    expect(clubs).toEqual([{
      id: "club-1",
      clubName: "Trailblazers",
      churchName: "First Church",
      town: "Ames",
      state: "IA",
      zip: "50010",
      meetingSchedule: "Sundays, 2-4pm",
      latitude: 42.03,
      longitude: -93.62,
    }]);
    for (const club of clubs) {
      const serialized = JSON.stringify(club).toLowerCase();
      for (const field of disallowedFields) {
        expect(serialized).not.toContain(field.toLowerCase());
      }
    }
  });

  it("lists a club without a church location, just without coordinates", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "club-2",
      name: "Riverbend",
      clubProfile: { meetingSchedule: "" },
      parentOrganization: { name: "Second Church", churchLocation: null },
    }]);
    const [club] = await listPublicClubs();
    expect(club).toMatchObject({ clubName: "Riverbend", town: "", latitude: null, longitude: null });
  });

  it("never depends on caller-side filtering: the query itself excludes unlisted and inactive clubs", async () => {
    // Guards against a future regression that fetches everything and
    // filters in the page/component instead of in the query.
    mocks.findMany.mockResolvedValue([]);
    await listPublicClubs();
    const call = mocks.findMany.mock.calls[0][0];
    expect(call.where.clubProfile.listPublicly).toBe(true);
    expect(call.where.isActive).toBe(true);
    expect(call.where.parentOrganization.isActive).toBe(true);
  });
});
