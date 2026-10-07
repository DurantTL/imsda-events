import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma as PrismaErrors } from "@prisma/client";

/**
 * Create Event fixes (#617): the template picker lists starters and saved templates, the copy from a
 * previous event settles (fast batched writes, readable failures, never an endless spinner), and the
 * fee warning names and links to the exact builder field. Synthetic data only.
 */
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), logError: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));
vi.mock("@/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
  return { ...actual, logError: mocks.logError };
});
vi.mock("@/modules/events/repository", () => ({ getEventSettings: async (id: string) => ({ id, name: "Synthetic Camporee 2028" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { RegistrationBuilderWorkspace } from "@/components/registration-builder-workspace";
import { StartFromTemplate } from "@/components/start-from-template";
import { postJson } from "@/lib/post-json";
import { eventCloneApiError } from "@/modules/event-clones/api-errors";
import { cloneEvent, previewEventClone } from "@/modules/event-clones/repository";
import {
  getFeeWarnings,
  registrationBuilderFieldHref,
  REGISTRATION_FEE_INPUT_LABEL,
  unpricedFeeFields,
} from "@/modules/events/readiness";
import { collectEventReadinessWarnings } from "@/modules/events/readiness-warnings";
import { getFormTemplate, registrationFormDefinitionSchema } from "@/modules/forms/definition";
import type { EventTemplateRecord } from "@/modules/event-templates/repository";

function template(overrides: Partial<EventTemplateRecord> = {}): EventTemplateRecord {
  return {
    id: "tpl-1", name: "Women's Retreat", description: "", audience: "GENERAL", status: "DRAFT", canApply: false,
    createdBy: "Synthetic Admin", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    versions: [{ id: "v1", versionNumber: 1, status: "DRAFT", payload: {}, payloadIssues: [], publishedAt: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", createdBy: "Synthetic Admin" }],
    ...overrides,
  } as EventTemplateRecord;
}

const html = (templates: EventTemplateRecord[]) => renderToStaticMarkup(createElement(StartFromTemplate, { templates }));

describe("Start from template picker (#617)", () => {
  it("lists a starter that is still a draft, disabled, and says how to publish it", () => {
    const markup = html([template()]);
    expect(markup).toContain("Women&#x27;s Retreat (General) - not published yet");
    expect(markup).toMatch(/<option[^>]*disabled=""[^>]*>Women/);
    expect(markup).toContain("None of these templates is published yet");
    expect(markup).toContain("Add starter templates");
    expect(markup).toContain('href="/admin/event-templates"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Create draft event/);
  });

  it("lists published and saved templates, selecting the first one that can be applied", () => {
    const published = template({ id: "tpl-2", name: "Fall Camporee", audience: "CLUB", status: "PUBLISHED", canApply: true });
    const markup = html([template(), published]);
    expect(markup).toContain("Fall Camporee (Club)");
    expect(markup).toContain("Women&#x27;s Retreat (General) - not published yet");
    expect(markup).not.toContain("None of these templates is published yet");
    expect(markup).toMatch(/<option value="tpl-2" selected=""[^>]*>Fall Camporee/);
  });

  it("flags a published version whose payload no longer parses", () => {
    const markup = html([template({ status: "PUBLISHED", versions: [{ ...template().versions[0]!, status: "PUBLISHED" }] })]);
    expect(markup).toContain("published version needs repair");
  });

  it("says there are no templates and points at Add starter templates", () => {
    const markup = html([]);
    expect(markup).toContain("There are no event templates yet");
    expect(markup).toContain("Add starter templates");
    expect(markup).toContain('href="/admin/event-templates"');
  });

  it("the page lists every template that is not archived, not only published ones", () => {
    const source = readFileSync("app/event-setup/from-template/page.tsx", "utf8");
    expect(source).toContain('template.status !== "ARCHIVED"');
    expect(source).not.toContain("filter((template) => template.canApply)");
  });
});

describe("Fee warning names and links to the field (#617)", () => {
  const definition = {
    sections: [{ fields: [
      { id: "field_fee_1", type: "CALCULATED", scope: "ATTENDEE", label: "Fall Camporee fee" },
      { id: "field_fee_2", type: "CALCULATED", scope: "ATTENDEE", label: "Meals", priceCents: 500 },
    ] }],
  };

  it("names the exact builder path and input label, and links to the form and field", () => {
    const [warning] = getFeeWarnings(unpricedFeeFields(definition, "form_1"), "evt_1");
    expect(warning!.label).toBe("Set the Fall Camporee fee");
    expect(warning!.detail).toContain("Open the registration builder → Fall Camporee fee → set the amount");
    expect(warning!.detail).toContain(REGISTRATION_FEE_INPUT_LABEL);
    expect(warning!.href).toBe("/registration-builder?event=evt_1&form=form_1&field=field_fee_1");
  });

  it("still accepts bare labels, with a link to the builder when an event is given", () => {
    expect(getFeeWarnings(["Fee"])[0]).not.toHaveProperty("href");
    expect(getFeeWarnings(["Fee"], "evt_1")[0]!.href).toBe(registrationBuilderFieldHref("evt_1"));
  });

  it("collects the link from the stored form, reading the published version first", async () => {
    const feeForm = getFormTemplate("camp_meeting_export")!.definition;
    const prisma = {
      eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
      registrationForm: { findMany: vi.fn()
        .mockResolvedValueOnce([{ id: "form_9", versions: [] }])
        .mockResolvedValueOnce([{ id: "form_9", versions: [{ definition: feeForm }] }]) },
    };
    const warnings = await collectEventReadinessWarnings(prisma as never, "evt_7");
    const fee = unpricedFeeFields(feeForm, "form_9");
    expect(warnings.map((warning) => warning.href)).toEqual(fee.map((field) => `/registration-builder?event=evt_7&form=form_9&field=${field.fieldId}`));
  });

  it("the builder labels the amount input as the registration fee and can be focused by id", () => {
    const source = readFileSync("components/registration-builder-workspace.tsx", "utf8");
    expect(source).toContain(REGISTRATION_FEE_INPUT_LABEL);
    expect(source).toContain("id={`registration-fee-${field.id}`}");
    expect(source).toContain('document.getElementById(`registration-fee-${focusedFieldId}`)');
    expect(readFileSync("app/(workspace)/registration-builder/page.tsx", "utf8")).toContain("focusTarget");
  });
});

describe("The registration fee input is always visible (#617)", () => {
  const feeField = { id: "f_fee_1", key: "fall_fee", label: "Fall Camporee fee", helpText: "", type: "CALCULATED", scope: "ATTENDEE", required: false, options: [] };

  function renderBuilder(focusFieldId: string | null) {
    const definition = registrationFormDefinitionSchema.parse({
      title: "Fall Camporee", description: "", confirmationMessage: "Saved.",
      sections: [{ id: "s_fees", title: "Fees", description: "", fields: [feeField] }],
    });
    const version = { id: "ver_1", versionNumber: 1, status: "DRAFT", definition, updatedAt: "2026-09-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z", publishedAt: null, createdBy: "Synthetic Admin", testSubmissionCount: 0, choiceUsage: {}, testSubmissions: [] };
    const form = { id: "form_1", eventId: "evt_1", createdBy: "Synthetic Admin", createdAt: "2026-09-01T00:00:00.000Z", name: "Fall Camporee", slug: "fall", status: "DRAFT", updatedAt: "2026-09-01T00:00:00.000Z", activeVersion: version, versions: [version] };
    return renderToStaticMarkup(createElement(RegistrationBuilderWorkspace, {
      eventId: "evt_1", eventSlug: "fall", eventName: "Fall", initialForms: [form] as never, templates: [],
      focusTarget: focusFieldId ? { formId: "form_1", fieldId: focusFieldId } : null,
    }));
  }

  it("puts the fee input, labeled as the registration fee, outside the collapsed Advanced options", () => {
    const markup = renderBuilder("f_fee_1");
    const input = markup.indexOf('id="registration-fee-f_fee_1"');
    expect(input).toBeGreaterThan(0);
    expect(markup).toContain("Registration fee (standard price)");
    const advanced = markup.indexOf('<details class="field-advanced"');
    expect(advanced).toBeGreaterThan(0);
    // The input comes before the details element and appears once, so it is not inside one.
    expect(input).toBeLessThan(advanced);
    expect(markup.match(/id="registration-fee-f_fee_1"/g)).toHaveLength(1);
  });

  it("keeps the field editor closed when there is no deep link", () => {
    expect(renderBuilder(null)).not.toContain('id="registration-fee-');
  });
});

describe("postJson never leaves a spinner (#617)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the server's JSON body and status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Nope." }), { status: 409 })));
    expect(await postJson("/x", {}, "Failed.")).toMatchObject({ ok: false, status: 409, body: { message: "Nope." } });
  });

  it("turns a non-JSON error page into a readable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Gateway Timeout</html>", { status: 504 })));
    const result = await postJson("/x", {}, "The event could not be copied.");
    expect(result.ok).toBe(false);
    expect(result.body.message).toContain("The event could not be copied.");
    expect(result.body.message).toContain("504");
  });

  it("gives up on a request that never answers", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })));
    const result = await postJson("/x", {}, "The event could not be copied.", 20);
    expect(result.ok).toBe(false);
    expect(result.body.message).toContain("taking too long");
  });

  it("reports an unreachable server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect((await postJson("/x", {}, "Failed.")).body.message).toContain("could not be reached");
  });

  it("the copy screen posts through it, so every path stops the busy state", () => {
    const source = readFileSync("components/copy-from-past-event.tsx", "utf8");
    expect(source.match(/postJson\(/g)).toHaveLength(2);
    expect(source).not.toContain("await fetch(");
  });

  it.each([
    ["Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 30000 ms.", "took too long"],
    ["Transaction API error: Unable to start a transaction in the given time.", "could not start"],
    ["Transaction API error: something else", "couldn't finish"],
  ])("a transaction error on the route says what happened (%#)", async (message, expected) => {
    const response = eventCloneApiError(new PrismaErrors.PrismaClientKnownRequestError(message, { code: "P2028", clientVersion: "test" }), {
      failureMessage: "The event could not be copied.", logMessage: "Event clone failed", invalidInputCode: "INVALID_EVENT_CLONE",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "SOURCE_BUSY", message: expect.stringContaining(expected) });
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});

/**
 * A fake database for the real `previewEventClone` / `cloneEvent`: every model method answers empty
 * unless the source event fixture overrides it, and every write is recorded.
 */
function fakeDatabase(overrides: Record<string, Record<string, (args: never) => unknown>>) {
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
  const emptyFor = (method: string) => (method === "findMany" ? [] : method === "count" ? 0 : method === "findUnique" || method === "findFirst" ? null : { id: `new_${calls.length}` });
  const db: Record<string, unknown> = new Proxy({}, {
    get(_target, model: string) {
      if (model === "$transaction") return async (callback: (tx: unknown) => unknown) => callback(db);
      if (model === "$executeRawUnsafe") return async () => 0;
      if (model === "$queryRaw") return async () => [{ id: "evt_source" }];
      return new Proxy({}, {
        get(_inner, method: string) {
          return async (args: unknown) => {
            calls.push({ model, method, args });
            const override = overrides[model]?.[method];
            return override ? override(args as never) : emptyFor(method);
          };
        },
      });
    },
  });
  return { db, calls };
}

describe("Copy from a previous event with a realistic source (#617)", () => {
  const feeDefinition = getFormTemplate("camp_meeting_export")!.definition;
  const honorRows = Array.from({ length: 40 }, (_, index) => ({ honor: index % 20, session: index % 2 }));

  function source() {
    const locations = ["Des Moines", "Omaha"].map((name, index) => ({
      name, normalizedName: name.toLowerCase(), address: null, capacity: null, sortOrder: index,
      firstDay: "2027-05-05", lastDay: "2027-05-06", registrationClosesOn: "2027-04-20", coordinatorAccountId: null,
    }));
    const sessions = ["Friday", "Sabbath"].flatMap((name, sessionIndex) => locations.map((location, locationIndex) => ({
      id: `session_${sessionIndex}_${locationIndex}`, name, normalizedName: name.toLowerCase(), sortOrder: sessionIndex * 2 + locationIndex,
      location: { name: location.name, normalizedName: location.normalizedName },
    })));
    const offerings = sessions.flatMap((session) => honorRows.slice(0, 20).map((row, index) => ({
      id: `offering_${session.id}_${index}`, honorId: `honor_${row.honor + index}`, honors: [{ honor: { id: `honor_${row.honor + index}`, code: `H${row.honor + index}`, name: `Honor ${row.honor + index}`, isActive: true } }],
      sessionId: session.id, session: { name: session.name }, span: "SINGLE_SESSION", capacity: 30, minimumAge: null, perClubLimit: null,
      teacherName: "Synthetic Teacher", location: "", additionalCostCents: null, requirementNote: "", isActive: true, site: null,
    })));
    return { locations, sessions, offerings };
  }

  async function run() {
    const { locations, sessions, offerings } = source();
    const { db, calls } = fakeDatabase({
      event: {
        findUnique: () => ({
          id: "evt_source", name: "Synthetic Camporee 2027", slug: "synthetic-camporee-2027",
          startsAt: new Date("2027-05-05T12:00:00Z"), endsAt: new Date("2027-05-07T12:00:00Z"), timezone: "America/Chicago", isPublished: true,
          location: "Synthetic Lodge", publicInfoUrl: null, supportContact: "help@example.test", tagline: null, subtitle: null, helpEmail: null, calendarCategory: null, showOnCalendar: true,
          hotelName: null, hotelBookingUrl: null, hotelPhone: null, hotelGroupName: null, hotelRate: null, hotelInstructions: null,
          audience: "GENERAL", billingMode: "ATTENDEE_PAY", waitlistEnabled: false, autoPromoteWaitlist: false,
          collectsShirtSizes: false, checksAdultBackgrounds: false,
        }),
        create: () => ({ id: "evt_new", name: "Synthetic Camporee 2028", slug: "synthetic-camporee-2028" }),
      },
      registrationForm: {
        findMany: () => [{ id: "form_1", name: "Camporee", slug: "camporee", status: "PUBLISHED", versions: [{ id: "ver_1", versionNumber: 1, definition: feeDefinition }] }],
        create: () => ({ id: "form_new", name: "Camporee" }),
      },
      eventLocation: { findMany: (args: { where: { eventId: string } }) => (args.where.eventId === "evt_new"
        ? locations.map((location) => ({ id: `newloc_${location.normalizedName}`, normalizedName: location.normalizedName }))
        : locations) },
      honorSession: { findMany: () => sessions },
      honorOffering: { findMany: () => offerings },
      platformSettings: { upsert: () => ({ defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT" }) },
    });
    mocks.getPrisma.mockReturnValue(db);
    const plan = await previewEventClone("usr_admin", { sourceEventId: "evt_source" });
    const body = {
      sourceEventId: "evt_source", expectedFingerprint: plan.fingerprint, requestKey: "request-key-617", name: "Synthetic Camporee 2028", slug: "synthetic-camporee-2028",
      startsOn: "2028-05-04", endsOn: "2028-05-06", capacity: { value: 200 }, registrationOpensOn: { value: "2028-01-01" }, registrationClosesOn: { value: "2028-04-01" },
      include: Object.fromEntries(plan.domains.map((domain) => [domain.key, domain.count > 0])),
      formLatePricingDates: plan.review.latePricing.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: "2028-03-01" })),
      formChoiceLimits: plan.review.formChoiceLimits.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, choice: item.choice, limit: 9 })),
      promoCodeWindows: [],
      honorOfferingCapacities: plan.review.honorOfferings.map((offering) => ({ offeringId: offering.offeringId, capacity: 12, perClubLimit: 3 })),
    };
    const result = await cloneEvent("usr_admin", body);
    return { result, calls, plan, offerings, sessions };
  }

  beforeEach(() => vi.clearAllMocks());

  it("copies the locations, honors sessions and offerings, and the published form", async () => {
    const { result, calls, offerings, sessions } = await run();
    expect(result.alreadyCloned).toBe(false);
    expect(result.summary!.copiedCounts).toMatchObject({ locations: 2, honors: offerings.length, registrationForms: 1 });

    const createdLocations = calls.find((call) => call.model === "eventLocation" && call.method === "createMany")!.args as { data: Array<{ name: string; firstDay: string }> };
    // Two days earlier: the event's start moved from 2027-05-05 to 2028-05-04 (a leap year).
    expect(createdLocations.data.map((row) => row.firstDay)).toEqual(["2028-05-04", "2028-05-04"]);

    const sessionRows = (calls.find((call) => call.model === "honorSession" && call.method === "createMany")!.args as { data: Array<{ id: string; locationId: string | null }> }).data;
    expect(sessionRows).toHaveLength(sessions.length);
    const offeringRows = (calls.find((call) => call.model === "honorOffering" && call.method === "createMany")!.args as { data: Array<{ sessionId: string }> }).data;
    expect(offeringRows).toHaveLength(offerings.length);
    // Every copied offering points at a session created in this same copy.
    const sessionIds = new Set(sessionRows.map((row) => row.id));
    // Each session follows its site by name onto the new event's location id, never a source id.
    const wantedSite = new Map(sessions.map((session) => [`${session.name}|${session.location.normalizedName}`, `newloc_${session.location.normalizedName}`]));
    const copiedSites = sessionRows.map((row) => `${(row as unknown as { name: string }).name}|${row.locationId}`).sort();
    const expectedSites = sessions.map((session) => `${session.name}|${wantedSite.get(`${session.name}|${session.location.normalizedName}`)}`).sort();
    expect(copiedSites).toEqual(expectedSites);
    expect(sessionRows.every((row) => row.locationId?.startsWith("newloc_"))).toBe(true);
    expect(offeringRows.every((row) => sessionIds.has(row.sessionId))).toBe(true);
    expect(calls.some((call) => call.model === "registrationForm" && call.method === "create")).toBe(true);
  });

  it("writes honors in a fixed number of statements however many rows there are", async () => {
    const { calls, offerings } = await run();
    // A per-row loop held the transaction open until it timed out on a real event (#617).
    const honorWrites = calls.filter((call) => (call.model === "honorSession" || call.model === "honorOffering") && call.method !== "findMany");
    expect(offerings.length).toBeGreaterThan(50);
    expect(honorWrites).toHaveLength(2);
  });
});
