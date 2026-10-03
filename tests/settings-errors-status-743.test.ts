import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/more/event-settings",
}));

import { AttendeeAccountsWorkspace } from "@/components/attendee-accounts-workspace";
import { AttendeeConfigurationWorkspace } from "@/components/attendee-configuration-workspace";
import { ClubHonorsWorkspace } from "@/components/club-honors-workspace";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { EmptyState, emptyStateAction } from "@/components/empty-state";
import { EventSettingsWorkspace } from "@/components/event-settings-workspace";
import { FieldError, fieldErrorProps } from "@/components/field-error";
import { FormErrorSummary, errorSummaryHeading } from "@/components/form-error-summary";
import { SortOrderNote, SortableHeader } from "@/components/list-sort";
import { NeedsAttention } from "@/components/needs-attention";
import { PromoCodeWorkspace } from "@/components/promo-code-workspace";
import { StaffWorkspace } from "@/components/staff-workspace";
import { TagConfigurationWorkspace } from "@/components/tag-configuration-workspace";
import { ariaSortValue, compareByName, sortByName, sortOrderText } from "@/lib/list-sort";
import { getEventPublishReadiness } from "@/modules/events/readiness";
import type { EventSettingsRecord } from "@/modules/events/repository";
import {
  blockForControlId,
  blockSummary,
  fieldErrorsFromIssues,
  firstFieldWithError,
  hotelSummary,
  saveStatusLabel,
  settingsBlockDomId,
  settingsFieldDomId,
} from "@/modules/events/settings-layout";
import { namedIssueMessage } from "@/modules/forms/roster-cards";
import { accountSortOrderText } from "@/modules/system-admin/account-sort";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const css = read("app/globals.css");
const marker = "#743 slice: Settings, Errors and Status clarity.";
const block = css.slice(css.indexOf(marker));

const baseFields = {
  id: "event-1",
  name: "Synthetic Retreat",
  slug: "synthetic-retreat",
  startsOn: "2027-10-08",
  endsOn: "2027-10-10",
  timezone: "America/Chicago",
  location: "Camp Fixture",
  capacity: 350,
  publicInfoUrl: null,
  supportContact: "help@example.test",
  tagline: null,
  subtitle: null,
  helpEmail: null,
  hotelName: null,
  hotelBookingUrl: null,
  hotelPhone: null,
  hotelGroupName: null,
  hotelRate: null,
  hotelInstructions: null,
  approvedPaymentInstructions: null,
  isPublished: false,
  registrationOpensOn: "2027-05-01",
  registrationClosesOn: "2027-10-01",
  waitlistEnabled: false,
  collectsShirtSizes: false,
  checksAdultBackgrounds: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT" as const,
  billingMode: "ATTENDEE_PAY" as const,
  audience: "GENERAL" as const,
  seminarPreferenceClosesOn: null,
  seminarPreferenceSelfServiceLocked: false,
  autoPromoteWaitlist: false,
  publishedFormCount: 1,
  publishedForms: [],
  createdAt: "2027-01-01T00:00:00.000Z",
  updatedAt: "2027-01-01T00:00:00.000Z",
};
type Overrides = { [K in keyof typeof baseFields]?: unknown };
const event = (overrides: Overrides = {}): EventSettingsRecord => {
  const fields = { ...baseFields, ...overrides } as typeof baseFields & Record<string, never>;
  return { ...fields, readiness: getEventPublishReadiness(fields, fields.publishedFormCount), warnings: [] };
};
const settings = (overrides: Overrides = {}) =>
  renderToStaticMarkup(createElement(EventSettingsWorkspace, { mode: "edit", initialEvent: event(overrides) }));
/** The opening tag of one settings block. */
const blockTag = (markup: string, id: string) =>
  markup.match(new RegExp(`<details[^>]*id="${settingsBlockDomId(id as never)}"[^>]*>`))?.[0] ?? "";

describe("event settings: collapsible blocks (#743)", () => {
  it("opens only the first block on load", () => {
    const markup = settings();
    expect(blockTag(markup, "basics")).toMatch(/\sopen=""/);
    for (const id of ["timing", "options", "public-info", "lodging"]) {
      expect(blockTag(markup, id), id).not.toBe("");
      expect(blockTag(markup, id), id).not.toMatch(/\sopen=""/);
    }
  });

  it("keeps a blank hotel section collapsed with a one-line summary", () => {
    const markup = settings();
    expect(blockTag(markup, "lodging")).not.toMatch(/\sopen=""/);
    expect(markup).toContain("No hotel set");
    expect(hotelSummary({})).toBe("No hotel set");
    expect(hotelSummary({ hotelName: "   ", hotelRate: null })).toBe("No hotel set");
    expect(blockSummary("lodging", {})).toBe("No hotel set");
  });

  it("summarizes a filled hotel and flags details entered without a hotel name", () => {
    expect(hotelSummary({ hotelName: "Fixture Inn", hotelRate: "$99 a night" })).toBe("Fixture Inn · $99 a night");
    expect(hotelSummary({ hotelName: "Fixture Inn" })).toBe("Fixture Inn");
    expect(hotelSummary({ hotelPhone: "555-0100" })).toMatch(/Hotel name missing/);
  });

  it("hides sections, never unmounts them: a collapsed block still renders its fields and values", () => {
    const markup = settings({ hotelName: "Fixture Inn", hotelRate: "$99 a night" });
    // Closed, yet the inputs are in the document with their typed values.
    expect(blockTag(markup, "lodging")).not.toMatch(/\sopen=""/);
    expect(markup).toMatch(/id="event-field-hotel-name"[^>]*value="Fixture Inn"/);
    expect(markup).toMatch(/id="event-field-hotel-rate"[^>]*value="\$99 a night"/);
    expect(markup).toMatch(/id="event-field-registration-closes-on"/);
    // The block never conditionally renders its children on `open`.
    const source = read("components/settings-block.tsx");
    expect(source).toContain("<details");
    expect(source).not.toMatch(/\{open\s*&&/);
    expect(source).toContain("{children}");
  });

  it("shows jump links and the persistent save status", () => {
    const markup = settings();
    expect(markup).toContain('aria-label="Jump to a settings section"');
    expect(markup).toContain(`href="#${settingsBlockDomId("lodging")}"`);
    expect(markup).toContain(`href="#${settingsBlockDomId("basics")}"`);
    expect(markup).toContain("No unsaved changes");
    expect(saveStatusLabel({ saving: false, dirty: true })).toBe("Changes not saved");
    expect(saveStatusLabel({ saving: false, dirty: false })).toBe("No unsaved changes");
    expect(saveStatusLabel({ saving: true, dirty: true })).toBe("Saving…");
  });

  it("keeps the sticky save bar, Publish blocker and Go to links working (#742)", () => {
    const markup = settings({ supportContact: null });
    expect(markup).toContain('id="event-save-button"');
    expect(markup).toContain("event-publish-blocker");
    expect(markup).toContain("Go to Registration support contact");
    expect(markup).toContain('id="event-field-support-contact"');
  });
});

describe("event settings: a field error or a Go to link opens its section (#743)", () => {
  it("maps every control, including the checklist's Go to targets, to its block", () => {
    expect(blockForControlId("event-field-support-contact")).toBe("public-info");
    expect(blockForControlId("event-field-starts-on")).toBe("basics");
    expect(blockForControlId("event-field-billing-mode")).toBe("timing");
    expect(blockForControlId(settingsFieldDomId("hotelBookingUrl"))).toBe("lodging");
    expect(blockForControlId(settingsFieldDomId("approvedPaymentInstructions"))).toBe("options");
    expect(blockForControlId("not-a-field")).toBeNull();
  });

  it("reads server issues by field and finds the first one in form order", () => {
    const errors = fieldErrorsFromIssues([
      { path: ["hotelBookingUrl"], message: "Enter a full web address." },
      { path: ["name"], message: "Use at least 3 characters." },
      { path: ["hotelBookingUrl"], message: "second message is ignored" },
      { path: ["unknownField"], message: "ignored" },
      { message: "no path" },
    ]);
    expect(errors).toEqual({ hotelBookingUrl: "Enter a full web address.", name: "Use at least 3 characters." });
    expect(firstFieldWithError(errors)).toEqual({ block: "basics", key: "name" });
    expect(firstFieldWithError({ hotelBookingUrl: "x" })).toEqual({ block: "lodging", key: "hotelBookingUrl" });
    expect(firstFieldWithError({})).toBeNull();
  });

  it("opens the block in state and the DOM, and focuses the field", () => {
    const source = read("components/event-settings-workspace.tsx");
    expect(source).toMatch(/function goToControl\(targetId: string\) \{\s*const blockId = blockForControlId\(targetId\);\s*if \(blockId\) setBlockOpen\(blockId, true\);/);
    expect(source).toContain("node.open = true");
    expect(source).toContain("target.focus({ preventScroll: true })");
    // A failed save opens the first problem's block and focuses its field.
    expect(source).toContain("setBlockOpen(first.block, true)");
    expect(source).toContain("pendingFocusRef.current = settingsFieldDomId(first.key)");
    // Native validation on a field inside a closed block opens that block.
    expect(source).toContain("onInvalidCapture={openBlockForInvalidField}");
  });

  it("labels a field error with an icon, aria-invalid and aria-describedby", () => {
    const aria = fieldErrorProps("event-field-hotel-booking-url-error", "Enter a full web address.");
    expect(aria).toEqual({ "aria-invalid": true, "aria-describedby": "event-field-hotel-booking-url-error" });
    expect(fieldErrorProps("x-error", undefined)).toEqual({ "aria-invalid": undefined, "aria-describedby": undefined });
    expect(fieldErrorProps("x-error", "Bad", "x-help")["aria-describedby"]).toBe("x-help x-error");
    const markup = renderToStaticMarkup(createElement(FieldError, { id: "x-error" }, "Enter a full web address."));
    expect(markup).toContain("<svg");
    expect(markup).toContain('id="x-error"');
    expect(markup).toContain("Enter a full web address.");
    expect(renderToStaticMarkup(createElement(FieldError, { id: "x-error" }, ""))).toBe("");
  });
});

describe("event settings: blocks follow the audience (#743)", () => {
  it("shows general-only seminar settings in view for a general event", () => {
    const markup = settings({ audience: "GENERAL" });
    expect(markup.indexOf("Seminar preference deadline")).toBeGreaterThan(-1);
    expect(markup.indexOf("Seminar preference deadline")).toBeLessThan(markup.indexOf(`id="${settingsBlockDomId("public-info")}"`));
  });

  it("moves general-only settings under More settings for a club event, keeping them", () => {
    const markup = settings({ audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" });
    const more = markup.indexOf(`id="${settingsBlockDomId("more")}"`);
    expect(more).toBeGreaterThan(-1);
    const seminar = markup.indexOf("Seminar preference deadline");
    expect(seminar).toBeGreaterThan(more);
    // Payment instructions only apply when attendees pay online.
    expect(markup.indexOf("Approved payment instructions")).toBeGreaterThan(more);
  });

  it("does not render a More settings block when every setting applies", () => {
    expect(settings({ audience: "GENERAL" })).not.toContain(`id="${settingsBlockDomId("more")}"`);
  });

  it("keeps a club event's hotel in view (lodging applies to both) but collapsed when blank", () => {
    const markup = settings({ audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" });
    expect(markup.indexOf(`id="${settingsBlockDomId("lodging")}"`)).toBeLessThan(markup.indexOf(`id="${settingsBlockDomId("more")}"`));
    expect(blockTag(markup, "lodging")).not.toMatch(/\sopen=""/);
  });
});

describe("error summary (#743)", () => {
  it("links every error to its control and takes focus", () => {
    const markup = renderToStaticMarkup(createElement(FormErrorSummary, {
      items: [
        { targetId: "public_attendee_a_shirt", message: "Guest Two — T-shirt size is required." },
        { targetId: "public_session_b", message: "Archery Basics — pick a time." },
        { targetId: null, message: "Something general." },
      ],
    }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('href="#public_attendee_a_shirt"');
    expect(markup).toContain("Guest Two — T-shirt size is required.");
    expect(markup).toContain("Archery Basics — pick a time.");
    expect(markup).toContain("3 problems to fix. Your answers are kept.");
    expect(markup).toContain("<svg");
    expect(errorSummaryHeading(1)).toBe("1 problem to fix. Your answers are kept.");
  });

  it("focuses the summary after a failed submit on the public form and keeps answers", () => {
    const source = read("components/public-registration-form.tsx");
    expect(source).toMatch(/window\.requestAnimationFrame\(\(\) => errorSummaryRef\.current\?\.focus\(\)\)/);
    expect(source).toContain("errorSummaryHeading(issues.length)");
    expect(source).toContain('<FieldError className="public-registration-field-error"');
    expect(source).toContain("issueSummaryMessage(issue)");
    // A failed submit never clears the entered answers.
    const showIssues = source.slice(source.indexOf("function showIssues("), source.indexOf("function showIssues(") + 900);
    expect(showIssues).not.toContain("setAttendees(");
    expect(showIssues).not.toContain("setResponses(");
  });

  it("names the attendee or session each message is about", () => {
    const names = ["Guest One", "Guest Two"];
    expect(namedIssueMessage("T-shirt size is required.", 1, names, "Attendee")).toBe("Guest Two — T-shirt size is required.");
    // Two people with the same name stay distinguishable.
    expect(namedIssueMessage("Age is required.", 1, ["Sam Fixture", "Sam Fixture"], "Attendee")).toBe("Sam Fixture (Attendee 2) — Age is required.");
    // Sessions use the same wording with their own names and position label.
    expect(namedIssueMessage("Pick a time.", 0, ["Archery Basics", "Knots"], "Session")).toBe("Archery Basics — Pick a time.");
    // A message that already names someone is not named twice, and a lone attendee stays plain.
    expect(namedIssueMessage("Guest Two — Age is required.", 1, names, "Attendee")).toBe("Guest Two — Age is required.");
    expect(namedIssueMessage("Age is required.", 0, ["Only One"], "Attendee")).toBe("Age is required.");
    expect(namedIssueMessage("Church is required.", null, names, "Attendee")).toBe("Church is required.");
  });

  it("styles the error with more than colour", () => {
    expect(block).toContain(".field-error-message");
    expect(block).toContain('[aria-invalid="true"]');
    expect(block).toContain(".form-error-summary");
  });
});

describe("empty states offer a create action only to an authorized viewer (#743)", () => {
  it("gates the action in the shared component", () => {
    const action = { label: "Add one", href: "/somewhere" };
    expect(emptyStateAction(true, action)).toEqual(action);
    expect(emptyStateAction(false, action)).toBeNull();
    const allowed = renderToStaticMarkup(createElement(EmptyState, { title: "Nothing yet", action, canCreate: true }, "Why it is empty."));
    expect(allowed).toContain("Nothing yet");
    expect(allowed).toContain("Why it is empty.");
    expect(allowed).toContain('href="/somewhere"');
    const denied = renderToStaticMarkup(createElement(EmptyState, { title: "Nothing yet", action, canCreate: false, hint: "Ask an administrator." }, "Why it is empty."));
    expect(denied).toContain("Why it is empty.");
    expect(denied).not.toContain("/somewhere");
    expect(denied).not.toContain("Add one");
    expect(denied).toContain("Ask an administrator.");
  });

  it("promo codes", () => {
    const render = (canCreate: boolean) => renderToStaticMarkup(createElement(PromoCodeWorkspace, { eventId: "e1", initialPromoCodes: [], canCreate }));
    expect(render(true)).toContain("Create first code");
    expect(render(true)).toContain("Create promo code");
    expect(render(false)).toContain("No promo codes yet");
    expect(render(false)).not.toContain("Create first code");
    expect(render(false)).not.toContain("Create promo code");
  });

  it("tags", () => {
    const render = (canCreate: boolean) => renderToStaticMarkup(createElement(TagConfigurationWorkspace, { eventId: "e1", eventName: "Synthetic", initialTags: [], canCreate }));
    expect(render(true)).toContain("Add the first tag");
    expect(render(true)).toContain("Add tag");
    expect(render(false)).toContain("No tags yet");
    expect(render(false)).not.toContain("Add the first tag");
    expect(render(false)).not.toContain(">Add tag<");
  });

  it("attendee types", () => {
    const render = (canCreate: boolean) => renderToStaticMarkup(createElement(AttendeeConfigurationWorkspace, {
      eventId: "e1", eventName: "Synthetic", initialTypes: [], initialClassifications: [], canCreate,
    }));
    expect(render(true)).toContain("Add the first attendee type");
    expect(render(false)).toContain("No attendee types yet");
    expect(render(false)).not.toContain("Add the first attendee type");
    expect(render(false)).not.toContain("Add attendee type");
  });

  it("team", () => {
    const render = (canAddStaff: boolean) => renderToStaticMarkup(createElement(StaffWorkspace, {
      eventId: "e1", eventName: "Synthetic", initialMemberships: [], currentUserId: "u1", currentUserIsSystemAdmin: false, canAddStaff,
    }));
    expect(render(true)).toContain("Add the first staff member");
    expect(render(false)).toContain("No staff on this event yet");
    expect(render(false)).not.toContain("Add the first staff member");
    expect(render(false)).not.toContain("Add staff");
  });

  it("club roster", () => {
    const render = (readOnly: boolean) => renderToStaticMarkup(createElement(ClubRosterWorkspace, {
      canSeeBirthDates: false, clubYear: "2026-27", initialMembers: [], organizationId: "org-1", readOnly,
    }));
    expect(render(false)).toContain("No one is on the roster yet");
    expect(render(false)).toContain(">Add to roster</button>");
    expect(render(true)).toContain("No one is on the roster yet");
    expect(render(true)).not.toContain("Add to roster");
  });

  it("registrations and forms pass the viewer's permission through", () => {
    const people = read("components/people-workspace.tsx");
    expect(people).toContain("canCreate={canEdit}");
    expect(people).toContain('title="No registrations yet"');
    const builder = read("components/registration-builder-workspace.tsx");
    expect(builder).toContain("canCreate={canEdit && !showTemplates}");
    expect(builder).toContain('title="No registration form yet"');
    expect(read("app/(workspace)/staff/page.tsx")).toContain('canAddStaff={permissions.includes("MANAGE_STAFF")}');
    expect(read("app/(workspace)/more/tags/page.tsx")).toContain('canCreate={permissions.includes("CONFIGURE_EVENT")}');
    expect(read("app/(workspace)/more/promo-codes/page.tsx")).toContain('canCreate={permissions.includes("MANAGE_FINANCE")}');
  });
});

describe("success states say what happened and what comes next (#743)", () => {
  it("names the next step after a save, a new code, a new tag and a roster add", () => {
    expect(read("components/event-settings-workspace.tsx")).toContain("Event settings saved. ${nextStep}");
    expect(read("components/promo-code-workspace.tsx")).toContain("Next: share it with registrants");
    expect(read("components/tag-configuration-workspace.tsx")).toContain("Next: staff can apply it");
    expect(read("components/club-roster-workspace.tsx")).toContain("Next: they can be chosen when the club registers");
  });
});

describe("status clarity (#743)", () => {
  it("shows Needs attention with an icon and bold text, not colour alone", () => {
    const markup = renderToStaticMarkup(createElement(NeedsAttention));
    expect(markup).toContain("<svg");
    expect(markup).toContain("<strong>Needs attention</strong>");
    expect(block).toMatch(/\.needs-attention \{[^}]*font-weight: 800/);
    expect(read("components/public-registration-form.tsx")).toContain("<NeedsAttention />");
    expect(read("app/(workspace)/overview/page.tsx")).toContain("<NeedsAttention />");
  });

  it("says how a list is sorted and shows the direction", () => {
    expect(sortOrderText("last name", "asc")).toBe("Sorted by last name, A to Z.");
    expect(sortOrderText("last name", "desc")).toBe("Sorted by last name, Z to A.");
    expect(sortOrderText("submitted date", "desc", "date")).toBe("Sorted by submitted date, newest first.");
    expect(ariaSortValue(true, "asc")).toBe("ascending");
    expect(ariaSortValue(true, "desc")).toBe("descending");
    expect(ariaSortValue(false, "desc")).toBe("none");
    const header = renderToStaticMarkup(createElement("table", null, createElement("thead", null, createElement("tr", null,
      createElement(SortableHeader, { label: "Name", active: true, direction: "desc", onSort: () => {} }),
      createElement(SortableHeader, { label: "Age", active: false, direction: "desc", onSort: () => {} }),
    ))));
    expect(header).toContain('aria-sort="descending"');
    expect(header).toContain('aria-sort="none"');
    expect(header).toContain("table-sort-button");
    expect(renderToStaticMarkup(createElement(SortOrderNote, null, "Sorted by x, A to Z."))).toContain("Sorted by x, A to Z.");
  });

  it("sorts by last then first name, with blanks last", () => {
    const people = [
      { firstName: "Zed", lastName: "Baker" },
      { firstName: "Amy", lastName: "Baker" },
      { firstName: "", lastName: "" },
      { firstName: "Cal", lastName: "Aaron" },
    ];
    expect(sortByName(people).map((person) => `${person.lastName}/${person.firstName}`)).toEqual(["Aaron/Cal", "Baker/Amy", "Baker/Zed", "/"]);
    expect(sortByName(people, "desc").map((person) => `${person.lastName}/${person.firstName}`)).toEqual(["Baker/Zed", "Baker/Amy", "Aaron/Cal", "/"]);
    expect(compareByName(people[0], people[1])).toBeGreaterThan(0);
  });

  it("accounts state their order, defaulting to newest first", () => {
    expect(accountSortOrderText(null)).toBe("Sorted by date created, newest first.");
    expect(accountSortOrderText({ key: "name", direction: "asc" })).toBe("Sorted by account, A to Z.");
    expect(accountSortOrderText({ key: "signin", direction: "desc" })).toBe("Sorted by last sign-in, newest first.");
    const account = (id: string) => ({
      id, email: `${id}@example.test`, displayName: id, disabled: false, lastSignedInAt: null, authenticatorOn: false,
      passkeyCount: 0, areaCoordinator: false, clubRoles: [], createdAt: "2026-01-01T00:00:00.000Z",
    });
    const html = renderToStaticMarkup(createElement(AttendeeAccountsWorkspace, {
      initialAccounts: [account("zed"), account("amy")] as never,
      initialSort: { key: "name", direction: "desc" },
    }));
    expect(html).toContain("Sorted by account, Z to A.");
    expect(html).toContain('aria-sort="descending"');
  });

  it("the club roster and honors roster state their order and mark the sorted column", () => {
    const roster = renderToStaticMarkup(createElement(ClubRosterWorkspace, {
      canSeeBirthDates: false, clubYear: "2026-27", organizationId: "org-1",
      initialMembers: [
        { id: "m1", firstName: "Zed", lastName: "Fixture", attendeeType: "YOUTH", role: "", classLevel: null, gender: null, status: "ACTIVE", source: "DIRECTOR", age: 12, reportedAge: null, birthDateNeeded: false, updatedAt: "2026-09-01T00:00:00.000Z" },
        { id: "m2", firstName: "Amy", lastName: "Fixture", attendeeType: "YOUTH", role: "", classLevel: null, gender: null, status: "ACTIVE", source: "DIRECTOR", age: 12, reportedAge: null, birthDateNeeded: false, updatedAt: "2026-09-01T00:00:00.000Z" },
      ] as never,
    }));
    expect(roster).toContain("Sorted by last name, A to Z.");
    expect(roster).toContain('aria-sort="ascending"');
    expect(roster.indexOf("Fixture, Amy")).toBeLessThan(roster.indexOf("Fixture, Zed"));
    const honors = renderToStaticMarkup(createElement(ClubHonorsWorkspace, {
      organizationId: "org-1", clubYear: "2026-27", honorOptions: [],
      initialRows: [
        { memberId: "b", firstName: "Zed", lastName: "Fixture", classLevel: null, honors: [] },
        { memberId: "a", firstName: "Amy", lastName: "Fixture", classLevel: null, honors: [] },
      ],
    }));
    expect(honors).toContain("Sorted by last name, A to Z.");
    expect(honors).toContain('aria-sort="ascending"');
    expect(honors.indexOf("Fixture, Amy")).toBeLessThan(honors.indexOf("Fixture, Zed"));
  });

  it("registrations and the check-in queue state their order", () => {
    expect(read("components/people-workspace.tsx")).toContain('sortOrderText("submitted date", "desc", "date")');
    const checkIn = read("components/check-in-workspace.tsx");
    expect(checkIn).toContain("sortOrderText(nameSortLabel, nameDirection)");
    expect(checkIn).toContain('sortOrderText("time saved", "asc", "date")');
  });
});

describe("the #743 settings/errors/status CSS block", () => {
  it("is one commented block at the end of the file with balanced braces", () => {
    expect(css.split(marker)).toHaveLength(2);
    expect(css.lastIndexOf("/* ====")).toBeLessThan(css.indexOf(marker));
    const stripped = block.replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    for (const char of stripped) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
