import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The check-in book CSV (#600) through the real report permission checks:
 * only the session, membership lookup, database and repository are stubbed.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  findUnique: vi.fn(),
  getCheckInBookData: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ event: { findUnique: mocks.findUnique } }) }));
vi.mock("@/modules/reporting/check-in-book-repository", () => ({ getCheckInBookData: mocks.getCheckInBookData }));

import { GET } from "@/app/api/events/[eventId]/check-in-book/route";

const staff = { id: "staff-1", email: "staff@example.test", displayName: "Staff Member" };
const context = { params: Promise.resolve({ eventId: "event-1" }) };
const request = (query = "") => new Request(`https://events.imsda.test/api/events/event-1/check-in-book${query}`);

function membership(role: string) {
  return { eventId: "event-1", userId: "staff-1", role, status: "ACTIVE", permissions: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: staff });
  mocks.getCheckInBookData.mockResolvedValue({
    book: {
      event: { name: "Synthetic Camporee", startsOn: "", endsOn: "", timezone: "UTC" },
      mode: "CLUB",
      extraColumn: null,
      cover: { pageCount: 0, peopleCount: 0 },
      pages: [],
    },
    extraOptions: [],
  });
});

describe("GET /api/events/[eventId]/check-in-book", () => {
  it("serves the CSV to staff with report access, passing the status and extra column filters", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    const response = await GET(request("?status=WAITLISTED&status=CONFIRMED&extra=skill_induction"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(mocks.getCheckInBookData).toHaveBeenCalledWith("event-1", {
      statuses: ["CONFIRMED", "WAITLISTED"],
      extraFieldKey: "skill_induction",
      location: null,
    });
  });

  it("defaults to submitted and confirmed registrations", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    await GET(request(), context);
    expect(mocks.getCheckInBookData).toHaveBeenCalledWith("event-1", { statuses: ["SUBMITTED", "CONFIRMED"], extraFieldKey: null, location: null });
  });

  it("passes ?location= through to narrow the book (#413)", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    await GET(request("?location=loc-mo"), context);
    expect(mocks.getCheckInBookData).toHaveBeenCalledWith("event-1", expect.objectContaining({ location: "loc-mo" }));
  });

  it("denies staff without report access", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF"));
    const response = await GET(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.getCheckInBookData).not.toHaveBeenCalled();
  });

  it("denies someone with no membership on the event", async () => {
    mocks.findActiveMembership.mockResolvedValue(null);
    const response = await GET(request(), context);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.getCheckInBookData).not.toHaveBeenCalled();
  });
});
