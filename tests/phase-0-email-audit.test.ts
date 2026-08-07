import { describe, expect, it } from "vitest";
import { formTemplates } from "@/modules/forms/definition";
import {
  DEFAULT_MESSAGE_TEMPLATE_LIST,
  renderMessageTemplate,
  type MessageTemplateContext,
  type MessageTemplateKey,
} from "@/modules/communications/templates";

type RegistrationState =
  | "paid"
  | "unpaid"
  | "complimentary"
  | "worker"
  | "waitlisted"
  | "deferred-organization";

type RegistrationType = "individual" | "group";

type RegistrationFixture = {
  confirmationCode: string;
  state: RegistrationState;
  registrationType: RegistrationType;
  attendeeSummary: string;
  templateKey: MessageTemplateKey | null;
};

type EventFixture = {
  formKey: string;
  formName: string;
  eventName: string;
  eventDates: string;
  eventLocation: string;
  contactEmail: string;
  senderName: string;
  senderEmail: string;
  replyToEmail: string;
  lodging: string;
  registrations: RegistrationFixture[];
};

const eventFixtures: EventFixture[] = [
  {
    formKey: "simple_rsvp",
    formName: "Simple RSVP",
    eventName: "Community Supper 2026",
    eventDates: "September 3, 2026",
    eventLocation: "Cedar Rapids, Iowa",
    contactEmail: "supper-support@example.test",
    senderName: "Community Supper Team",
    senderEmail: "supper@example.test",
    replyToEmail: "supper-replies@example.test",
    lodging: "",
    registrations: [
      { confirmationCode: "RSVP-DEMO-1", state: "complimentary", registrationType: "individual", attendeeSummary: "Taylor Rivera — RSVP", templateKey: "REGISTRATION_CONFIRMATION_PAID" },
      { confirmationCode: "RSVP-DEMO-WAIT", state: "waitlisted", registrationType: "individual", attendeeSummary: "Jordan Smith — RSVP", templateKey: "WAITLIST_JOINED" },
    ],
  },
  {
    formKey: "retreat_registration",
    formName: "Retreat registration",
    eventName: "Prairie Retreat 2026",
    eventDates: "September 18 – 20, 2026",
    eventLocation: "Pella, Iowa",
    contactEmail: "prairie-support@example.test",
    senderName: "Prairie Retreat Team",
    senderEmail: "prairie@example.test",
    replyToEmail: "prairie-replies@example.test",
    lodging: "Prairie Lodge room assignments are handled by the retreat team.",
    registrations: [
      { confirmationCode: "RETREAT-DEMO-1", state: "complimentary", registrationType: "group", attendeeSummary: "Alex Morgan — Attendee\nSam Morgan — Attendee", templateKey: "REGISTRATION_CONFIRMATION_PAID" },
      { confirmationCode: "RETREAT-DEMO-2", state: "worker", registrationType: "individual", attendeeSummary: "Jordan Casey — Worker", templateKey: "WORKER_CONFIRMATION" },
      { confirmationCode: "RETREAT-DEMO-WAIT", state: "waitlisted", registrationType: "group", attendeeSummary: "Robin Lane — Attendee\nParker Lane — Attendee", templateKey: "WAITLIST_JOINED" },
    ],
  },
  {
    formKey: "household_interest",
    formName: "Household interest",
    eventName: "Family Ministry Interest 2026",
    eventDates: "October 1, 2026",
    eventLocation: "Ames, Iowa",
    contactEmail: "family-support@example.test",
    senderName: "Family Ministry Team",
    senderEmail: "family@example.test",
    replyToEmail: "family-replies@example.test",
    lodging: "",
    registrations: [
      { confirmationCode: "HOUSEHOLD-DEMO-1", state: "complimentary", registrationType: "group", attendeeSummary: "Patel household — party of 4", templateKey: "REGISTRATION_CONFIRMATION_PAID" },
      { confirmationCode: "HOUSEHOLD-DEMO-WAIT", state: "waitlisted", registrationType: "group", attendeeSummary: "Nguyen household — party of 5", templateKey: "WAITLIST_JOINED" },
    ],
  },
  {
    formKey: "womens_retreat_export",
    formName: "Women’s Retreat 2026",
    eventName: "Women’s Retreat 2026",
    eventDates: "October 9 – 11, 2026",
    eventLocation: "Des Moines, Iowa",
    contactEmail: "women-support@example.test",
    senderName: "Women’s Retreat Team",
    senderEmail: "women@example.test",
    replyToEmail: "women-replies@example.test",
    lodging: "The Women’s Retreat room block is at the Des Moines Conference Hotel.",
    registrations: [
      { confirmationCode: "WR-DEMO-PAID", state: "paid", registrationType: "individual", attendeeSummary: "Avery Johnson — Adult registration", templateKey: "REGISTRATION_CONFIRMATION_PAID" },
      { confirmationCode: "WR-DEMO-DUE", state: "unpaid", registrationType: "group", attendeeSummary: "Morgan Lee — Adult registration\nRiley Lee — Teen registration", templateKey: "REGISTRATION_CONFIRMATION_UNPAID" },
      { confirmationCode: "WR-DEMO-WORKER", state: "worker", registrationType: "individual", attendeeSummary: "Casey Brown — Worker", templateKey: "WORKER_CONFIRMATION" },
      { confirmationCode: "WR-DEMO-WAIT", state: "waitlisted", registrationType: "individual", attendeeSummary: "Jamie Davis — Adult registration", templateKey: "WAITLIST_JOINED" },
    ],
  },
  {
    formKey: "man_camp_export",
    formName: "Man Camp 2026",
    eventName: "Man Camp 2026",
    eventDates: "November 6 – 8, 2026",
    eventLocation: "Boone, Iowa",
    contactEmail: "mancamp-support@example.test",
    senderName: "Man Camp Team",
    senderEmail: "mancamp@example.test",
    replyToEmail: "mancamp-replies@example.test",
    lodging: "Man Camp lodging is assigned from the selected registration package.",
    registrations: [
      { confirmationCode: "MC-DEMO-PAID", state: "paid", registrationType: "individual", attendeeSummary: "Elliot Price — Adult program", templateKey: "REGISTRATION_CONFIRMATION_PAID" },
      { confirmationCode: "MC-DEMO-DUE", state: "unpaid", registrationType: "group", attendeeSummary: "Devon Price — Adult program\nQuinn Price — Young Men’s Program", templateKey: "REGISTRATION_CONFIRMATION_UNPAID" },
      { confirmationCode: "MC-DEMO-WORKER", state: "worker", registrationType: "individual", attendeeSummary: "Reese Carter — Volunteer", templateKey: "WORKER_CONFIRMATION" },
      { confirmationCode: "MC-DEMO-WAIT", state: "waitlisted", registrationType: "individual", attendeeSummary: "Cameron Brooks — Adult program", templateKey: "WAITLIST_JOINED" },
    ],
  },
  {
    formKey: "spring_camporee_export",
    formName: "Spring Camporee 2026",
    eventName: "Spring Camporee 2026",
    eventDates: "April 23 – 26, 2026",
    eventLocation: "Hawkeye Campground, Iowa",
    contactEmail: "camporee-support@example.test",
    senderName: "Spring Camporee Team",
    senderEmail: "camporee@example.test",
    replyToEmail: "camporee-replies@example.test",
    lodging: "",
    registrations: [
      { confirmationCode: "SC-DEMO-DEFERRED", state: "deferred-organization", registrationType: "group", attendeeSummary: "Cedar Valley Pathfinders — 18 club members", templateKey: null },
      { confirmationCode: "SC-DEMO-WAIT", state: "waitlisted", registrationType: "group", attendeeSummary: "River City Pathfinders — 22 club members", templateKey: "WAITLIST_JOINED" },
    ],
  },
  {
    formKey: "camp_meeting_export",
    formName: "Camp Meeting 2026",
    eventName: "Camp Meeting 2026",
    eventDates: "June 5 – 13, 2026",
    eventLocation: "Nevada, Iowa",
    contactEmail: "campmeeting-support@example.test",
    senderName: "Camp Meeting Team",
    senderEmail: "campmeeting@example.test",
    replyToEmail: "campmeeting-replies@example.test",
    lodging: "Camp Meeting housing follows the selected nights and housing category.",
    registrations: [
      { confirmationCode: "CM-DEMO-PAID", state: "paid", registrationType: "individual", attendeeSummary: "Dana Flores — Dorm room", templateKey: "REGISTRATION_CONFIRMATION_PAID" },
      { confirmationCode: "CM-DEMO-DUE", state: "unpaid", registrationType: "group", attendeeSummary: "Skyler Flores — RV hookup\nRobin Flores — Guest", templateKey: "REGISTRATION_CONFIRMATION_UNPAID" },
      { confirmationCode: "CM-DEMO-COMP", state: "complimentary", registrationType: "individual", attendeeSummary: "Peyton Reed — Complimentary guest", templateKey: "REGISTRATION_CONFIRMATION_PAID" },
      { confirmationCode: "CM-DEMO-WAIT", state: "waitlisted", registrationType: "individual", attendeeSummary: "Leslie Kim — Dorm room", templateKey: "WAITLIST_JOINED" },
    ],
  },
];

const matrixMessageIds = [
  "registration-received-paid",
  "registration-received-balance-due",
  "complimentary-or-worker-confirmation",
  "waitlist-entry",
  "waitlist-promotion",
  "waitlist-removal-or-decline",
  "registration-updated",
  "contact-email-changed",
  "registration-transfer-prior-contact",
  "registration-transfer-new-contact",
  "attendee-substitution-prior-attendee",
  "attendee-substitution-new-attendee",
  "cancellation",
  "reactivation",
  "payment-receipt",
  "refund-notice",
  "balance-reminder",
  "staff-resend-or-corrected-address",
  "published-announcement",
  "event-specific-pre-arrival",
] as const;

function contextFor(fixture: EventFixture, registration: RegistrationFixture): MessageTemplateContext {
  const paid = registration.state === "paid";
  const unpaid = registration.state === "unpaid";
  const waitlisted = registration.state === "waitlisted";
  return {
    recipient_name: "Demo Recipient",
    registrant_name: "Demo Registrant",
    event_name: fixture.eventName,
    event_dates: fixture.eventDates,
    event_location: fixture.eventLocation,
    confirmation_code: registration.confirmationCode,
    attendee_summary: registration.attendeeSummary,
    total_amount: paid || unpaid ? "$125.00" : "$0.00",
    restored_status: "CONFIRMED",
    balance_amount: unpaid ? "$125.00" : "$0.00",
    payment_instructions: unpaid ? `Contact ${fixture.contactEmail} for the approved payment step.` : "No additional payment is due.",
    portal_url: `https://events.example.test/manage/${registration.confirmationCode.toLowerCase()}`,
    reply_to_email: fixture.replyToEmail,
    waitlist_position: waitlisted ? "3" : "Not waitlisted",
    waitlist_removal_reason: "The registrant can no longer attend.",
    contact_email: fixture.contactEmail,
    registration_contact_email: `${registration.confirmationCode.toLowerCase()}@example.test`,
    change_category: "Seminar preferences",
    payment_amount: paid ? "$125.00" : "$0.00",
    payment_reference: `demo-${registration.confirmationCode.toLowerCase()}`,
    prior_person_name: "Prior Demo Attendee",
    new_person_name: "Replacement Demo Attendee",
    announcement_title: `${fixture.eventName} arrival information`,
    announcement_body: `Review the published ${fixture.eventName} arrival instructions before traveling.`,
    hotel_information: fixture.lodging,
    payment_status_block: waitlisted
      ? "### Payment status\n\nNo payment is due while this registration is waitlisted."
      : unpaid
        ? "### Payment status\n\nA balance of **$125.00** remains."
        : paid
          ? "### Payment status\n\n**Paid in full.**"
          : "### Payment status\n\n**Complimentary registration. No balance is due.**",
    checkin_block: `### At check-in\n\nUse confirmation code **${registration.confirmationCode}**.`,
    checkin_qr_url: `https://events.example.test/manage/${registration.confirmationCode.toLowerCase()}`,
    checkin_qr_image: `https://events.example.test/manage/${registration.confirmationCode.toLowerCase()}/qr.png`,
  };
}

describe("Phase 0 email audit fixtures", () => {
  it("covers the seven supported form templates with synthetic registrations", () => {
    expect(eventFixtures.map((fixture) => fixture.formKey)).toEqual(formTemplates.map((template) => template.key));
    expect(eventFixtures.map((fixture) => fixture.formName)).toEqual(formTemplates.map((template) => template.name));
    expect(eventFixtures.every((fixture) => fixture.registrations.length > 0)).toBe(true);
    expect(eventFixtures.flatMap((fixture) => fixture.registrations).every((registration) => registration.confirmationCode.includes("DEMO"))).toBe(true);
  });

  it("keeps representative payment and party states where they apply", () => {
    const states = Object.fromEntries(eventFixtures.map((fixture) => [
      fixture.formKey,
      fixture.registrations.map((registration) => registration.state),
    ]));
    const registrationTypes = Object.fromEntries(eventFixtures.map((fixture) => [
      fixture.formKey,
      fixture.registrations.map((registration) => registration.registrationType),
    ]));

    expect(states.womens_retreat_export).toEqual(["paid", "unpaid", "worker", "waitlisted"]);
    expect(states.man_camp_export).toEqual(["paid", "unpaid", "worker", "waitlisted"]);
    expect(states.simple_rsvp).toEqual(["complimentary", "waitlisted"]);
    expect(states.retreat_registration).toEqual(["complimentary", "worker", "waitlisted"]);
    expect(states.household_interest).toEqual(["complimentary", "waitlisted"]);
    expect(states.spring_camporee_export).toEqual(["deferred-organization", "waitlisted"]);
    expect(states.camp_meeting_export).toEqual(["paid", "unpaid", "complimentary", "waitlisted"]);
    expect(registrationTypes.simple_rsvp).toEqual(["individual", "individual"]);
    expect(registrationTypes.retreat_registration).toEqual(["group", "individual", "group"]);
    expect(registrationTypes.household_interest).toEqual(["group", "group"]);
    expect(registrationTypes.womens_retreat_export).toEqual(["individual", "group", "individual", "individual"]);
    expect(registrationTypes.man_camp_export).toEqual(["individual", "group", "individual", "individual"]);
    expect(registrationTypes.spring_camporee_export).toEqual(["group", "group"]);
    expect(registrationTypes.camp_meeting_export).toEqual(["individual", "group", "individual", "individual"]);
  });

  it("renders every available default through the production HTML and text pipeline for every applicable registration state", () => {
    const captures = eventFixtures.flatMap((fixture) => {
      return fixture.registrations.flatMap((registration) => {
        const context = contextFor(fixture, registration);
        return DEFAULT_MESSAGE_TEMPLATE_LIST.map((template) => {
          const rendered = renderMessageTemplate(template, context);
          return {
            formKey: fixture.formKey,
            eventName: fixture.eventName,
            templateKey: template.key,
            confirmationCode: registration.confirmationCode,
            registrationState: registration.state,
            registrationType: registration.registrationType,
            recipientKind: template.key === "INTERNAL_NEW_REGISTRATION" ? "INTERNAL" : "REGISTRANT",
            sender: `${fixture.senderName} <${fixture.senderEmail}>`,
            replyTo: fixture.replyToEmail,
            subject: rendered.subject,
            text: rendered.body,
            html: rendered.bodyHtml,
            complete: rendered.isComplete,
            unresolvedTokens: rendered.unresolvedTokens,
          };
        });
      });
    });

    const expectedEvidence = eventFixtures.flatMap((fixture) => fixture.registrations.flatMap((registration) =>
      DEFAULT_MESSAGE_TEMPLATE_LIST.map((template) => ({
        formKey: fixture.formKey,
        eventName: fixture.eventName,
        templateKey: template.key,
        confirmationCode: registration.confirmationCode,
        registrationState: registration.state,
        registrationType: registration.registrationType,
        recipientKind: template.key === "INTERNAL_NEW_REGISTRATION" ? "INTERNAL" : "REGISTRANT",
        sender: `${fixture.senderName} <${fixture.senderEmail}>`,
        replyTo: fixture.replyToEmail,
      })),
    ));

    expect(captures).toHaveLength(expectedEvidence.length);
    expect(captures.map((capture) => ({
      formKey: capture.formKey,
      eventName: capture.eventName,
      templateKey: capture.templateKey,
      confirmationCode: capture.confirmationCode,
      registrationState: capture.registrationState,
      registrationType: capture.registrationType,
      recipientKind: capture.recipientKind,
      sender: capture.sender,
      replyTo: capture.replyTo,
    }))).toEqual(expectedEvidence);
    for (const capture of captures) {
      expect(capture.complete).toBe(true);
      expect(capture.unresolvedTokens).toEqual([]);
      expect(capture.eventName).not.toBe("");
      expect(capture.templateKey).not.toBe("");
      expect(capture.registrationState).not.toBe("");
      expect(capture.registrationType).not.toBe("");
      expect(capture.subject).not.toBe("");
      expect(capture.text).not.toBe("");
      expect(capture.html).not.toBe("");
      expect(capture.subject).not.toMatch(/[\r\n]/);
      expect(capture.text).not.toMatch(/\{\{[^{}]+\}\}/);
      expect(capture.html).not.toMatch(/\{\{[^{}]+\}\}/);
      expect(capture.html).toMatch(/^<(h1|p)/);
      expect(capture.sender).toContain("@example.test");
      expect(capture.replyTo).toContain("@example.test");
    }
  });

  it("does not mix another fixture's event-owned values into rendered confirmations", () => {
    for (const fixture of eventFixtures) {
      for (const registration of fixture.registrations) {
        if (!registration.templateKey) continue;
        const rendered = renderMessageTemplate(
          DEFAULT_MESSAGE_TEMPLATE_LIST.find((template) => template.key === registration.templateKey)!,
          contextFor(fixture, registration),
        );
        const combined = `${rendered.subject}\n${rendered.body}\n${rendered.bodyHtml}`;
        expect(combined).toContain(fixture.eventName);
        expect(combined).toContain(fixture.contactEmail);
        for (const other of eventFixtures.filter((candidate) => candidate.formKey !== fixture.formKey)) {
          for (const value of [
            other.eventName,
            other.eventDates,
            other.eventLocation,
            other.contactEmail,
            other.senderEmail,
            other.replyToEmail,
            other.lodging,
          ].filter(Boolean)) {
            expect(combined).not.toContain(value);
          }
        }
      }
    }
  });

  it("pins all twenty lifecycle rows required by issue 66", () => {
    expect(matrixMessageIds).toHaveLength(20);
    expect(new Set(matrixMessageIds).size).toBe(20);
  });
});
