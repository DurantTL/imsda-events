import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventSetupChecklist } from "@/components/event-setup-checklist";
import { eventPermissions, rolePermissions, type EventPermission } from "@/modules/access/permissions";
import {
  buildSetupChecklist,
  setupStepIds,
  type SetupChecklistFacts,
} from "@/modules/events/setup-checklist";

/** The Dashboard setup checklist (#743): step order, done/not-done from existing data, and permission-gated steps and links. Synthetic data only. */

const blank: SetupChecklistFacts = {
  eventId: "event-1",
  slug: "synthetic-retreat",
  name: "Synthetic Retreat",
  startsOn: "2027-10-08",
  endsOn: "2027-10-10",
  isPublished: false,
  activeAttendeeTypeCount: 0,
  formCount: 0,
  testSubmissionCount: 0,
  publishedFormCount: 0,
};
const allDone: SetupChecklistFacts = {
  ...blank,
  isPublished: true,
  activeAttendeeTypeCount: 2,
  formCount: 1,
  testSubmissionCount: 3,
  publishedFormCount: 1,
};
const done = (facts: SetupChecklistFacts, permissions: readonly EventPermission[] = eventPermissions) =>
  Object.fromEntries(buildSetupChecklist(facts, permissions).steps.map((step) => [step.id, step.done]));

describe("the setup checklist steps", () => {
  it("lists the seven steps in order, each linked to its control", () => {
    const { steps } = buildSetupChecklist(blank, eventPermissions);
    expect(steps.map((step) => step.label)).toEqual([
      "Event basics",
      "Attendee types",
      "Registration forms and prices",
      "Test form",
      "Publish form",
      "Publish event",
      "View public page",
    ]);
    expect(steps.map((step) => step.id)).toEqual([...setupStepIds]);
    expect(steps.map((step) => step.href)).toEqual([
      "/more/event-settings?event=event-1#event-settings-block-basics",
      "/more/attendee-configuration?event=event-1",
      "/registration-builder?event=event-1",
      "/registration-builder?event=event-1#live-form-preview",
      "/registration-builder?event=event-1",
      "/more/event-settings?event=event-1#event-readiness-panel",
      "/events/synthetic-retreat",
    ]);
    // The public page opens in a new tab; every staff control stays in the workspace.
    expect(steps.filter((step) => step.external).map((step) => step.id)).toEqual(["public-page"]);
    // Not published yet: the public page is text, not a live link.
    expect(steps.filter((step) => !step.linkable).map((step) => step.id)).toEqual(["public-page"]);
  });

  it("points at the first step still to do", () => {
    expect(buildSetupChecklist(blank, eventPermissions).nextStepId).toBe("attendee-types");
    expect(buildSetupChecklist({ ...blank, name: " " }, eventPermissions).nextStepId).toBe("basics");
    expect(buildSetupChecklist({ ...allDone, testSubmissionCount: 0 }, eventPermissions).nextStepId).toBe("test-form");
  });
});

describe("done and not done come from existing data only", () => {
  it("event basics: a name, web address and both dates", () => {
    expect(done(blank).basics).toBe(true);
    expect(done({ ...blank, name: "  " }).basics).toBe(false);
    expect(done({ ...blank, slug: "" }).basics).toBe(false);
    expect(done({ ...blank, startsOn: null }).basics).toBe(false);
    expect(done({ ...blank, endsOn: null }).basics).toBe(false);
  });

  it("attendee types: done with one active type, so a free event can finish it", () => {
    expect(done(blank)["attendee-types"]).toBe(false);
    expect(done({ ...blank, activeAttendeeTypeCount: 1 })["attendee-types"]).toBe(true);
    expect(buildSetupChecklist(blank, eventPermissions).steps[1]!.label).toBe("Attendee types");
  });

  it("registration forms, test form and publish form each follow their own count", () => {
    expect(done(blank)).toMatchObject({ forms: false, "test-form": false, "publish-form": false });
    expect(done({ ...blank, formCount: 1 })).toMatchObject({ forms: true, "test-form": false, "publish-form": false });
    expect(done({ ...blank, formCount: 1, testSubmissionCount: 1 })).toMatchObject({ forms: true, "test-form": true, "publish-form": false });
    expect(done({ ...blank, formCount: 1, testSubmissionCount: 1, publishedFormCount: 1 })).toMatchObject({ "publish-form": true });
  });

  it("publish event follows isPublished; the public page also needs a published form", () => {
    expect(done(blank)).toMatchObject({ "publish-event": false, "public-page": false });
    expect(done({ ...blank, isPublished: true })).toMatchObject({ "publish-event": true, "public-page": false });
    expect(done({ ...blank, publishedFormCount: 1 })["public-page"]).toBe(false);
    expect(done({ ...blank, isPublished: true, publishedFormCount: 1 })["public-page"]).toBe(true);
  });
});

describe("the checklist hides once every step is done", () => {
  it("is shown while any step is open and hidden when all are done", () => {
    expect(buildSetupChecklist(blank, eventPermissions)).toMatchObject({ hidden: false, doneCount: 1 });
    const complete = buildSetupChecklist(allDone, eventPermissions);
    expect(complete).toMatchObject({ hidden: true, doneCount: 7, nextStepId: null });
    expect(renderToStaticMarkup(createElement(EventSetupChecklist, { eventId: "event-1", checklist: complete }))).toBe("");
  });

  it("shows the public page as a live link only once the event is published", () => {
    const unpublished = renderToStaticMarkup(createElement(EventSetupChecklist, { eventId: "event-1", checklist: buildSetupChecklist(blank, eventPermissions) }));
    expect(unpublished).not.toContain('href="/events/synthetic-retreat"');
    expect(unpublished).toContain("Available once the event is published.");
    const published = renderToStaticMarkup(createElement(EventSetupChecklist, { eventId: "event-1", checklist: buildSetupChecklist({ ...blank, isPublished: true }, eventPermissions) }));
    expect(published).toContain('href="/events/synthetic-retreat"');
    expect(published).not.toContain("Available once the event is published.");
  });

  it("can be collapsed: a labelled toggle controls the steps", () => {
    const html = renderToStaticMarkup(createElement(EventSetupChecklist, { eventId: "event-1", checklist: buildSetupChecklist(blank, eventPermissions) }));
    expect(html).toContain("Set up this event");
    expect(html).toContain("1 of 7 done");
    expect(html).toContain('aria-controls="setup-checklist-steps"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Hide steps");
    expect(html).toContain('id="setup-checklist-steps"');
  });
});

describe("steps follow what the viewer can act on", () => {
  const ids = (permissions: readonly EventPermission[]) => buildSetupChecklist(blank, permissions).steps.map((step) => step.id);

  it("shows an event administrator and a system administrator every step", () => {
    expect(ids(rolePermissions.EVENT_ADMIN)).toEqual([...setupStepIds]);
    expect(ids(eventPermissions)).toEqual([...setupStepIds]);
  });

  it("shows a registration manager only the form steps and the public page", () => {
    expect(ids(rolePermissions.REGISTRATION_MANAGER)).toEqual(["forms", "test-form", "publish-form", "public-page"]);
  });

  it("shows a viewer who only configures the event the settings steps and the public page, never the form builder", () => {
    const steps = buildSetupChecklist(blank, ["VIEW_EVENT", "CONFIGURE_EVENT"]).steps;
    expect(steps.map((step) => step.id)).toEqual(["basics", "attendee-types", "publish-event", "public-page"]);
    expect(steps.some((step) => step.href.startsWith("/registration-builder"))).toBe(false);
  });

  it("shows nothing, and no public-page link on its own, to staff with no setup permission", () => {
    for (const role of ["FINANCE_MANAGER", "COMMUNICATIONS_MANAGER", "CHECK_IN_STAFF", "READ_ONLY_STAFF"] as const) {
      const checklist = buildSetupChecklist(blank, rolePermissions[role]);
      expect(checklist.steps).toEqual([]);
      expect(checklist.hidden).toBe(true);
    }
  });

  it("never lists a link to a page the viewer cannot open", () => {
    const pagePermission: Array<[prefix: string, needs: EventPermission]> = [
      ["/more/event-settings", "CONFIGURE_EVENT"],
      ["/more/attendee-configuration", "CONFIGURE_EVENT"],
      ["/registration-builder", "MANAGE_FORMS"],
    ];
    for (const role of Object.keys(rolePermissions) as Array<keyof typeof rolePermissions>) {
      const permissions = rolePermissions[role];
      for (const step of buildSetupChecklist(blank, permissions).steps) {
        const rule = pagePermission.find(([prefix]) => step.href.startsWith(prefix));
        if (rule) expect(permissions, `${role} -> ${step.href}`).toContain(rule[1]);
      }
    }
  });

  it("is hidden for a viewer whose own steps are all done, even if another role's are not", () => {
    // Forms are done; settings are not. A registration manager has nothing left to act on.
    const formsDone = { ...blank, formCount: 1, testSubmissionCount: 1, publishedFormCount: 1, isPublished: true };
    expect(buildSetupChecklist(formsDone, rolePermissions.REGISTRATION_MANAGER).hidden).toBe(true);
    expect(buildSetupChecklist(formsDone, rolePermissions.EVENT_ADMIN).hidden).toBe(false);
  });
});
