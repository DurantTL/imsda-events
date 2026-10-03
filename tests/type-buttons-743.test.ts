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

import { ClubEventList } from "@/components/club-event-list";
import { DangerZone, DangerZoneItem } from "@/components/danger-zone";
import { DeleteEventDialogView } from "@/components/delete-event-dialog";
import { EventSettingsWorkspace } from "@/components/event-settings-workspace";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { RegistrationBuilderWorkspace } from "@/components/registration-builder-workspace";
import { SubmitButton, submitButtonState } from "@/components/submit-button";
import { UnpublishEventDialog } from "@/components/unpublish-event-dialog";
import {
  attendeeCountPhrase,
  lifecycleActionButtonClass,
  bulkScopeSummary,
  namedActionLabel,
  registrationLifecycleLabel,
} from "@/lib/confirmation-copy";
import { registrationFormDefinitionSchema, formTemplates, type RegistrationFormDefinition } from "@/modules/forms/definition";
import { getEventPublishReadiness } from "@/modules/events/readiness";
import type { EventSettingsRecord } from "@/modules/events/repository";
import type { ClubEventSummary } from "@/modules/club-registrations/repository";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const css = read("app/globals.css");
/** The #743 block, from its banner to the end of the file. */
const block = css.slice(css.indexOf("#743 slice: Type scale, Buttons and Destructive actions."));
const primaryCount = (markup: string) => (markup.match(/class="[^"]*\bprimary-button\b[^"]*"/g) ?? []).length;

/** WCAG 2.x contrast ratio between two #rrggbb colors. */
function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("type scale tokens (#743)", () => {
  it("floors meta at 12px and body, inputs, labels and buttons at 14px on every screen size", () => {
    expect(css).toMatch(/@media screen \{\s*:root \{\s*--type-floor: 0\.75rem;\s*--type-body-floor: 0\.875rem;/);
    expect(css).toMatch(/--type-public-body: 1rem;/);
    expect(css).toMatch(/--type-public-label: 0\.875rem;/);
    expect(css).toMatch(/--type-public-title: 1\.5rem;/);
    expect(css).toMatch(/--type-button: 0\.875rem;/);
    expect(css).toMatch(/--type-button-cta: 1rem;/);
  });

  it("sets public body and inputs to 16px, the step title to at most 24px, and admin body to 14px", () => {
    expect(block).toMatch(/\.public-registration-page \{ font-size: var\(--type-public-body\); \}/);
    expect(block).toMatch(/\.public-registration-field input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),[^{]*\{ font-size: var\(--type-public-body\); \}/);
    expect(block).toMatch(/\.public-registration-step-heading h2 \{ font-size: clamp\(1\.25rem, 3vw, var\(--type-public-title\)\); \}/);
    expect(block).toMatch(/\.app-shell \{ font-size: var\(--type-admin-body\); \}/);
  });

  it("keeps muted text at 4.5:1 on every background it sits on, and the sidebar group label on navy", () => {
    const muted = css.match(/--muted:\s*(#[0-9a-f]{6})/i)?.[1] ?? "";
    for (const background of ["#ffffff", "#f4f7f8", "#e6f0f4", "#f1eaf7", "#fff5d7", "#e5f3ed", "#f8fafb", "#f9fbfb", "#fbfcfd", "#dce6ea", "#eee6f5", "#fff1ef"]) {
      expect(contrast(muted, background), `${muted} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    const label = block.match(/\.nav-group-label \{ color: (#[0-9a-f]{6}); \}/i)?.[1] ?? "";
    expect(contrast(label, "#003b5c")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(label, "#002c45")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("type floors never apply in print (#743)", () => {
  it("sets the floor variables to a non-zero value only inside @media screen, anywhere in the file", () => {
    const stack: boolean[] = [];
    let offenders = 0;
    let screenDeclarations = 0;
    const tokens = css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]*)\{|\}|(--type-(?:body-)?floor):\s*([^;}]+)/g);
    for (const token of tokens) {
      if (token[0] === "}") stack.pop();
      else if (token[1] !== undefined && token[0].endsWith("{")) stack.push(/@media[^{]*\bscreen\b/.test(token[1]));
      else if (token[2]) {
        const value = token[3].trim();
        if (stack.some(Boolean)) screenDeclarations += 1;
        else if (value !== "0px" && value !== "0") offenders += 1;
      }
    }
    expect(offenders).toBe(0);
    expect(screenDeclarations).toBeGreaterThanOrEqual(2);
  });
});

describe("CSS hygiene for the #743 block", () => {
  it("keeps brace depth at zero", () => {
    let depth = 0;
    let lowest = 0;
    for (const char of css) {
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      lowest = Math.min(lowest, depth);
    }
    expect(lowest).toBe(0);
    expect(depth).toBe(0);
  });

  it("adds no global button rule, and no print rule", () => {
    expect(block).not.toMatch(/(^|\n)\s*(button|\.primary-button|\.secondary-button)\s*[,{]/);
    expect(block).not.toContain("@media print");
    // Tap targets are named containers and named public controls.
    expect(block).toContain(".public-registration-attendee-actions button");
    expect(block).toContain(":where(.form-actions, .page-intro-actions");
  });

  it("scopes the public tap target rule away from table cells and inline text buttons", () => {
    expect(block).toContain(":not(:where(td, th) *)");
    expect(block).toContain(".public-registration-page .text-button:not(:where(td, th, p, small, summary, label, li, dd, dt) *)");
    expect(block).not.toMatch(/\.public-registration-page :is\(\.primary-button, \.secondary-button, \.text-button\)/);
  });

  it("keeps floored subtitles from outgrowing their headings", () => {
    expect(block).toMatch(/\.report-field-heading h3[^}]*\{ font-size: 1rem; \}/);
    expect(block).toMatch(/\.danger-zone-item > h3 \{[^}]*font-size: 1rem;/);
  });
});

describe("Add another attendee (#743)", () => {
  const rule = block.match(/\.public-registration-roster-footer button\.public-registration-add-attendee \{([^}]*)\}/)?.[1] ?? "";

  it("is a full-width secondary button: 14px, weight 800, solid border", () => {
    expect(rule).toContain("width: 100%");
    expect(rule).toContain("font-size: var(--type-button)");
    expect(rule).toContain("font-weight: 800");
    expect(rule).toMatch(/border: 2px solid/);
    expect(rule).toContain("background: #fff");
  });

  it("no longer uses the filled accent button, so Continue is the one filled action on that step", () => {
    const source = read("components/public-registration-form.tsx");
    expect(source).toContain('className="public-registration-add-attendee"');
    expect(source).not.toContain("accent-button");
  });

  it("renders with the secondary class in the attendee step", () => {
    const definition = registrationFormDefinitionSchema.parse({
      title: "Synthetic roster form", description: "Synthetic.", confirmationMessage: "Received.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 8, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
      sections: [{ id: "people", title: "People", description: "", fields: [
        { id: "first_field", key: "first_name", label: "First name", type: "TEXT", scope: "ATTENDEE", required: true, helpText: "", options: [] },
        { id: "last_field", key: "last_name", label: "Last name", type: "TEXT", scope: "ATTENDEE", required: true, helpText: "", options: [] },
      ] }],
    });
    const markup = renderToStaticMarkup(createElement(PublicRegistrationForm, {
      event: { name: "Synthetic Retreat", slug: "synthetic-retreat", startsAt: "2027-02-19T21:00:00.000Z", endsAt: "2027-02-21T17:00:00.000Z", timezone: "America/Chicago", location: "Camp", capacity: null, billingMode: "ATTENDEE_PAY" },
      form: { slug: "registration", versionId: "version-1", versionNumber: 1, definition },
      choiceUsage: {},
      pricingDate: "2026-09-29",
      lifecycle: { phase: "OPEN", capacityDecision: "REGISTER", remainingSpots: null, waitingRegistrations: 0 },
      initialResponses: {},
      disableDrafts: true,
    } as never));
    expect(markup).toMatch(/<button[^>]*class="public-registration-add-attendee"[^>]*>[\s\S]*?Add another attendee/);
    // Continue is the one filled primary on a registration step.
    expect(markup.match(/class="is-continue"/g)).toHaveLength(1);
  });
});

describe("submitting state (#743)", () => {
  it("shows Submitting… with a spinner, disabled and busy, while a request is in flight", () => {
    expect(submitButtonState({ submitting: true, label: "Submit registration" })).toEqual({
      label: "Submitting…", disabled: true, ariaBusy: true, showSpinner: true,
    });
    const markup = renderToStaticMarkup(createElement(SubmitButton, { label: "Submit registration", submitting: true }));
    expect(markup).toContain("Submitting…");
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("is-spinning");
    expect(markup).not.toContain("Submit registration");
    expect(markup).toContain('type="submit"');
  });

  it("re-enables with the normal label once a failed request lets go", () => {
    const failed = submitButtonState({ submitting: false, label: "Submit registration" });
    expect(failed).toEqual({ label: "Submit registration", disabled: false, ariaBusy: false, showSpinner: false });
    const markup = renderToStaticMarkup(createElement(SubmitButton, { label: "Submit registration", submitting: false }));
    expect(markup).toContain("Submit registration");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("aria-busy");
    expect(markup).not.toContain("is-spinning");
  });

  it("stays disabled for its own reason when idle, and accepts a saving label", () => {
    expect(submitButtonState({ submitting: false, disabled: true, label: "Save" }).disabled).toBe(true);
    expect(submitButtonState({ submitting: true, label: "Save", submittingLabel: "Saving…" }).label).toBe("Saving…");
  });

  it("is wired into public registration with a failure path that keeps the answers and re-enables", () => {
    const source = read("components/public-registration-form.tsx");
    expect(source).toMatch(/<SubmitButton[\s\S]{0,400}?submitting=\{submitting\}/);
    const submit = source.slice(source.indexOf("async function submit("), source.indexOf("function startAnotherRegistration"));
    // Both failure routes leave the form state alone and the finally block re-enables the button.
    expect(submit).toContain("Your answers are still here; please try again.");
    expect(submit).not.toMatch(/catch \{[^}]*setResponses/);
    expect(submit.match(/finally \{\s*setSubmitting\(false\);/g)?.length).toBe(2);
  });

  it("is wired into event settings (Saving…) and the registration status change", () => {
    expect(read("components/event-settings-workspace.tsx")).toMatch(/<SubmitButton[\s\S]*?submitting=\{saving\}[\s\S]*?submittingLabel="Saving…"/);
    expect(read("components/people-workspace.tsx")).toMatch(/<SubmitButton[\s\S]*?submittingLabel="Updating…"/);
  });
});

describe("confirmation copy names the object and the consequence (#743)", () => {
  it("builds named action labels, never a bare OK", () => {
    expect(namedActionLabel("Delete", "Women's Retreat 2027")).toBe("Delete Women's Retreat 2027");
    expect(namedActionLabel("Delete", "   ")).toBe("Delete this item");
    expect(registrationLifecycleLabel("cancel", "Pat Example")).toBe("Cancel registration for Pat Example");
    expect(registrationLifecycleLabel("promote", "Pat Example")).toBe("Promote Pat Example from the waitlist");
    expect(attendeeCountPhrase(1)).toBe("1 attendee");
    expect(attendeeCountPhrase(12)).toBe("12 attendees");
  });

  it("previews the count and scope of a bulk action", () => {
    expect(bulkScopeSummary({ count: 3, singular: "person", plural: "people", scope: "the 2026-27 roster" })).toBe("3 people in the 2026-27 roster");
    expect(bulkScopeSummary({ count: 1, singular: "person", plural: "people" })).toBe("1 person");
  });

  it("delete event: the confirm button is 'Delete <event name>' and the body states the consequence", () => {
    const markup = renderToStaticMarkup(createElement(DeleteEventDialogView, {
      busy: false, error: "", loadFailed: false, onCancel: () => {}, onConfirm: () => {}, onTyped: () => {}, open: true, typed: "",
      preview: { name: "Women's Retreat 2027", counts: { locations: 1, forms: 2 } as never, decision: { allowed: true } },
    }));
    expect(markup).toContain("Delete Women&#x27;s Retreat 2027?");
    expect(markup).toContain(">Permanently delete Women&#x27;s Retreat 2027</button>");
    expect(markup).toContain("cannot be undone");
    expect(markup).not.toContain("Delete event permanently");
  });

  it("unpublish: the confirm button names the event", () => {
    const markup = renderToStaticMarkup(createElement(UnpublishEventDialog, {
      busy: false, eventName: "Women's Retreat 2027", error: "", onCancel: () => {}, onConfirm: () => {}, open: true,
    }));
    expect(markup).toContain(">Unpublish Women&#x27;s Retreat 2027</button>");
  });

  it("other destructive confirmations label their button with the object, not 'Remove' or 'OK'", () => {
    const expectations: Array<[string, RegExp]> = [
      ["components/calendar-admin-workspace.tsx", /confirmLabel=\{removeTarget \? `Remove "\$\{removeTarget\.title\}"`/],
      ["components/club-team-workspace.tsx", /`Remove \$\{confirmTarget\.member\.displayName\}`/],
      ["components/club-team-workspace.tsx", /`Cancel invite to \$\{confirmTarget\.invite\.email\}`/],
      ["components/merchandise-admin-workspace.tsx", /confirmLabel=\{archiveTarget \? `Archive /],
      ["components/registration-amendment-editor.tsx", /`Remove \$\{removeAttendeeName\(removeAttendeeIndex\)\}`/],
      ["components/registration-builder-workspace.tsx", /`Remove "\$\{removeFieldTarget\.field\.label\}"`/],
      ["components/registration-builder-workspace.tsx", /`Remove "\$\{removeSectionTarget\.section\.title\}"`/],
      ["components/registration-builder-workspace.tsx", /`Withdraw \$\{selectedForm\.name\}`/],
      ["components/public-registration-form.tsx", /confirmLabel=\{`Remove \$\{pendingName\}`\}/],
      ["components/attendee-accounts-workspace.tsx", /`Sign \$\{account\.email\} out everywhere`/],
      ["components/organization-directory-workspace.tsx", /`Delete \$\{editor\.check\.name\}`/],
      ["components/tag-configuration-workspace.tsx", /`Deactivate "\$\{deactivateTarget\.name\}"`/],
      ["components/check-in-workspace.tsx", /`Discard retry for \$\{discardTarget\.attendeeLabel\}`/],
    ];
    for (const [file, pattern] of expectations) expect(read(file), file).toMatch(pattern);
  });

  it("the bulk honors record shows its count and scope in a confirmation before anything is saved", () => {
    const source = read("components/club-honors-workspace.tsx");
    expect(source).toContain("bulkScopeSummary({ count: selected.size");
    expect(source).toContain("onClick={() => { setError(\"\"); setConfirmingBulk(true); }}");
    expect(source).toMatch(/<ConfirmDialog[\s\S]*?onConfirm=\{\(\) => void applyBulk\(\)\}/);
  });
});

describe("Danger zone (#743)", () => {
  it("renders a labelled red section with an icon, a heading, and its items", () => {
    const markup = renderToStaticMarkup(createElement(
      DangerZone, { heading: "Delete this thing" } as never,
      createElement(DangerZoneItem, { title: "Delete it" } as never, createElement("p", null, "Gone for good.")),
    ));
    expect(markup).toContain('class="panel danger-zone"');
    expect(markup).toContain("Danger zone");
    expect(markup).toContain("<svg");
    expect(markup).toContain("Delete this thing");
    expect(markup).toContain("Gone for good.");
  });

  it("is styled red with an outlined trigger; only the confirm button is filled (white on #8f3a30)", () => {
    expect(block).toMatch(/\.danger-zone \{[^}]*border-left: 5px solid var\(--danger, #8f3a30\)/);
    expect(block).toMatch(/\.danger-outline-button \{ border: 2px solid var\(--danger, #8f3a30\); background: #fff; color: var\(--danger, #8f3a30\); \}/);
    expect(contrast("#8f3a30", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#8f3a30", "#fdf4f2")).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/\.lifecycle-danger-button \{ border-color: #8f3a30; background: #8f3a30; color: #fff; \}/);
  });
});

const baseEventFields = {
  id: "event-1", name: "Synthetic Retreat", slug: "synthetic-retreat", startsOn: "2027-10-08", endsOn: "2027-10-10",
  timezone: "America/Chicago", location: "Camp Heritage", capacity: 350, publicInfoUrl: null, supportContact: "registration@example.test",
  tagline: null, subtitle: null, helpEmail: null, hotelName: null, hotelBookingUrl: null, hotelPhone: null, hotelGroupName: null,
  hotelRate: null, hotelInstructions: null, approvedPaymentInstructions: null, isPublished: false, registrationOpensOn: "2027-05-01",
  registrationClosesOn: "2027-10-01", waitlistEnabled: false, collectsShirtSizes: false, checksAdultBackgrounds: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT" as const, billingMode: "ATTENDEE_PAY" as const, audience: "GENERAL" as const,
  seminarPreferenceClosesOn: null, seminarPreferenceSelfServiceLocked: false, autoPromoteWaitlist: false, publishedFormCount: 1,
  publishedForms: [], createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z",
};
const settingsEvent = (over: Partial<typeof baseEventFields> = {}): EventSettingsRecord => {
  const fields = { ...baseEventFields, ...over };
  return { ...fields, readiness: getEventPublishReadiness(fields, fields.publishedFormCount), warnings: [] };
};

describe("one filled primary per screen (#743)", () => {
  it("event settings: Save is the only filled primary, and Publish is outlined", () => {
    const markup = renderToStaticMarkup(createElement(EventSettingsWorkspace, { mode: "edit", initialEvent: settingsEvent() }));
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/class="primary-button"[^>]*id="event-save-button"|id="event-save-button"[^>]*class="primary-button"/);
    expect(markup).toMatch(/class="secondary-button outline-action full-button event-publish-button"/);
  });

  it("event settings: unpublish and delete live in a red Danger zone, outlined, and Save is still the only primary", () => {
    const markup = renderToStaticMarkup(createElement(EventSettingsWorkspace, {
      mode: "edit", initialEvent: settingsEvent({ isPublished: true }), canDeleteEvent: true,
    }));
    expect(primaryCount(markup)).toBe(1);
    const zone = markup.slice(markup.indexOf('class="panel danger-zone'));
    expect(zone).toContain("Danger zone");
    expect(zone).toContain("Unpublish event…");
    expect(zone).toContain("Delete event…");
    expect(zone.match(/danger-outline-button/g)?.length).toBe(2);
    expect(zone).not.toContain("lifecycle-danger-button");
    // The Unpublish button is no longer inside the publish toggle.
    const toggle = markup.slice(markup.indexOf("event-publish-toggle"), markup.indexOf('class="panel danger-zone'));
    expect(toggle).not.toContain("Unpublish event");
  });

  it("event settings: a draft with nothing to delete or unpublish shows no Danger zone", () => {
    const markup = renderToStaticMarkup(createElement(EventSettingsWorkspace, { mode: "edit", initialEvent: settingsEvent() }));
    expect(markup).not.toContain("Danger zone");
  });

  const clubEvent = (id: string, over: Partial<ClubEventSummary> = {}): ClubEventSummary => ({
    id, name: `Synthetic event ${id}`, startsAt: "2026-11-06T15:00:00.000Z", endsAt: "2026-11-08T20:00:00.000Z", timezone: "America/Chicago",
    location: "Camp", phase: "OPEN", registrationClosesOn: null, available: true, problem: null, registration: null, draft: null,
    registeredLocation: null, hasLocations: false, ...over,
  });

  it("club events: only the first open event is filled; the others, and registered events, are outlined", () => {
    const markup = renderToStaticMarkup(createElement(ClubEventList, {
      organizationId: "org-1",
      events: [
        clubEvent("a", { registration: { confirmationCode: "ABC123", status: "CONFIRMED", attendeeCount: 4 } }),
        clubEvent("b"),
        clubEvent("c"),
      ],
    }));
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/class="primary-button club-event-action" href="\/account\/clubs\/org-1\/events\/b"/);
    expect(markup).toMatch(/class="secondary-button club-event-action" href="\/account\/clubs\/org-1\/events\/c"/);
    expect(markup).toMatch(/class="secondary-button club-event-action" href="\/account\/clubs\/org-1\/events\/a"/);
  });

  it("club home: only the first To do step is filled", () => {
    const source = read("app/(public)/account/(portal)/clubs/[organizationId]/page.tsx");
    expect(source).toContain('stepIndex === 0 ? "primary-button" : "secondary-button"');
  });

  it("registrations: Start registration is the filled action and Email selected is outlined", () => {
    const source = read("components/people-workspace.tsx");
    expect(source).toContain('<button className="secondary-button outline-action" type="button" onClick={() => setEmailingSelection(true)}>');
    expect(source.match(/lifecycleActionButtonClass\(Boolean\(selected\.publicSubmission\?\.rosterEnabled\)\)/g)).toHaveLength(2);
    // Roster form: Edit is the one filled button. No roster (rosterEnabled false): Promote and Reactivate are.
    expect(lifecycleActionButtonClass(true)).toBe("secondary-button");
    expect(lifecycleActionButtonClass(false)).toBe("primary-button");
  });

  it("check-in: Start camera hands the filled primary to the resolved pass", () => {
    expect(read("components/check-in-scanner.tsx")).toContain('className={resolution ? "secondary-button" : "primary-button"}');
  });

  it("form builder: Publish version is the one filled form action; template, test and preview Continue are outlined", () => {
    const definition = structuredClone(formTemplates[0].definition) as RegistrationFormDefinition;
    const version = {
      id: "version-1", versionNumber: 1, status: "DRAFT" as const, definition, publishedAt: null,
      createdAt: "2028-08-01T00:00:00.000Z", updatedAt: "2028-08-01T00:00:00.000Z", createdBy: "Synthetic Staff",
      testSubmissionCount: 0, choiceUsage: {}, testSubmissions: [],
    };
    const markup = renderToStaticMarkup(createElement(RegistrationBuilderWorkspace, {
      eventId: "event-1", eventSlug: "fall-camporee-2028", eventName: "Fall Camporee 2028",
      initialForms: [{
        id: "form-1", eventId: "event-1", name: definition.title, slug: "synthetic-form", status: "DRAFT",
        createdAt: "2028-08-01T00:00:00.000Z", updatedAt: "2028-08-01T00:00:00.000Z", createdBy: "Synthetic Staff",
        activeVersion: version, versions: [version],
      }],
      templates: [],
    } as never));
    expect(primaryCount(markup)).toBe(1);
    expect(markup).toMatch(/class="primary-button"[^>]*>(?:(?!<\/button>)[\s\S])*Publish version/);
  });

  it("form builder: the Danger zone renders inside builder-canvas, not as a third grid column", () => {
    const definition = structuredClone(formTemplates[0].definition) as RegistrationFormDefinition;
    const version = {
      id: "version-1", versionNumber: 1, status: "PUBLISHED" as const, definition, publishedAt: "2028-08-01T00:00:00.000Z",
      createdAt: "2028-08-01T00:00:00.000Z", updatedAt: "2028-08-01T00:00:00.000Z", createdBy: "Synthetic Staff",
      testSubmissionCount: 0, choiceUsage: {}, testSubmissions: [],
    };
    const markup = renderToStaticMarkup(createElement(RegistrationBuilderWorkspace, {
      eventId: "event-1", eventSlug: "fall-camporee-2028", eventName: "Fall Camporee 2028",
      initialForms: [{
        id: "form-1", eventId: "event-1", name: definition.title, slug: "synthetic-form", status: "PUBLISHED",
        createdAt: "2028-08-01T00:00:00.000Z", updatedAt: "2028-08-01T00:00:00.000Z", createdBy: "Synthetic Staff",
        activeVersion: version, versions: [version],
      }],
      templates: [],
    } as never));
    const canvasStart = markup.lastIndexOf("<div", markup.indexOf('class="builder-canvas"'));
    const zoneStart = markup.indexOf('class="panel danger-zone');
    expect(canvasStart).toBeGreaterThan(-1);
    expect(zoneStart).toBeGreaterThan(markup.indexOf('class="panel confirmation-editor"'));
    // Walk the div nesting from the canvas open tag to find where the canvas closes.
    let depth = 0;
    let canvasEnd = -1;
    for (const tag of markup.slice(canvasStart).matchAll(/<div\b|<\/div>/g)) {
      depth += tag[0] === "</div>" ? -1 : 1;
      if (depth === 0) { canvasEnd = canvasStart + tag.index! ; break; }
    }
    expect(canvasEnd).toBeGreaterThan(zoneStart);
    expect(markup.indexOf('class="panel builder-preview"')).toBeGreaterThan(canvasEnd);
  });

  it("form builder: Withdraw moves into a Danger zone for a published form", () => {
    const definition = structuredClone(formTemplates[0].definition) as RegistrationFormDefinition;
    const version = {
      id: "version-1", versionNumber: 1, status: "PUBLISHED" as const, definition, publishedAt: "2028-08-01T00:00:00.000Z",
      createdAt: "2028-08-01T00:00:00.000Z", updatedAt: "2028-08-01T00:00:00.000Z", createdBy: "Synthetic Staff",
      testSubmissionCount: 0, choiceUsage: {}, testSubmissions: [],
    };
    const markup = renderToStaticMarkup(createElement(RegistrationBuilderWorkspace, {
      eventId: "event-1", eventSlug: "fall-camporee-2028", eventName: "Fall Camporee 2028",
      initialForms: [{
        id: "form-1", eventId: "event-1", name: definition.title, slug: "synthetic-form", status: "PUBLISHED",
        createdAt: "2028-08-01T00:00:00.000Z", updatedAt: "2028-08-01T00:00:00.000Z", createdBy: "Synthetic Staff",
        activeVersion: version, versions: [version],
      }],
      templates: [],
    } as never));
    const zone = markup.slice(markup.indexOf('class="panel danger-zone'));
    expect(zone).toContain("Danger zone");
    expect(zone).toContain("Withdraw from public page");
    expect(zone).toContain(`Withdraw ${definition.title}`);
    expect(markup.slice(0, markup.indexOf('class="panel danger-zone'))).not.toContain("Withdraw from public page");
  });
});
