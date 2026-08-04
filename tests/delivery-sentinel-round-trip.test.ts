import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REGISTRATION_MANAGE_API_SENTINEL,
  REGISTRATION_MANAGE_LINK_SENTINEL,
} from "@/modules/communications/manage-link";

/**
 * The full path a private link takes: rendered into both snapshots at enqueue as
 * a sentinel, carried through storage untouched, and swapped for a real
 * one-per-message URL in memory at delivery.
 *
 * This exists because the enqueue-time HTML snapshot broke exactly here once
 * already. The renderer validated URL schemes, the sentinels matched none of
 * them, and rejected links are rendered as inert text — so the `href` and `src`
 * were stripped before delivery ever saw them, and every HTML email silently
 * lost its buttons and its QR while the plain-text part still looked correct.
 * Preview tests did not catch it: their sample context uses ordinary HTTPS URLs,
 * which pass validation and never exercise the sentinel path.
 */

const issuedToken = "private-token-abc123";
const createStableRegistrationAccessToken = vi.fn(async () => ({
  token: issuedToken,
  managePath: `/manage/${issuedToken}`,
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }),
}));

vi.mock("@/modules/public-access/repository", () => ({
  createStableRegistrationAccessToken,
  revokeRegistrationAccessToken: vi.fn(async () => undefined),
}));

const { prepareEmailBodyForDelivery } = await import(
  "@/modules/communications/email-delivery"
);
const { DEFAULT_MESSAGE_TEMPLATES, renderMessageTemplate } = await import(
  "@/modules/communications/templates"
);
const { buildRegistrationCheckinTokens } = await import(
  "@/modules/communications/message-blocks"
);

const attendeeId = "attendee-solo-1";

function renderRegistrationConfirmation() {
  return renderMessageTemplate(DEFAULT_MESSAGE_TEMPLATES.REGISTRATION_CONFIRMATION_PAID, {
    recipient_name: "Avery Johnson",
    event_name: "IMSDA Women's Retreat 2026",
    event_dates: "October 9 – 11, 2026",
    event_location: "Des Moines, Iowa",
    confirmation_code: "REG-DEMO123",
    attendee_summary: "Avery Johnson — Adult registration",
    contact_email: "registration@imsda.org",
    portal_url: REGISTRATION_MANAGE_LINK_SENTINEL,
    payment_status_block: "### Payment status\n\nPaid in full.",
    // One attendee, so the block inlines the pass image.
    ...buildRegistrationCheckinTokens({
      confirmationCode: "REG-DEMO123",
      attendeeIds: [attendeeId],
    }),
  });
}

describe("delivery sentinel round trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the sentinels inside href and src in the stored HTML snapshot", () => {
    const rendered = renderRegistrationConfirmation();

    // The portal link is a real anchor, and its destination survived rendering.
    expect(rendered.bodyHtml).toContain(
      `<a href="${REGISTRATION_MANAGE_LINK_SENTINEL}"`,
    );
    expect(rendered.bodyHtml).toContain("View, pay, or edit your registration");

    // The pass image is a real <img>, not alt text.
    expect(rendered.bodyHtml).toContain(
      `<img src="${REGISTRATION_MANAGE_API_SENTINEL}/attendee-passes/${attendeeId}/qr?format=png"`,
    );
    expect(rendered.bodyHtml).toContain('alt="Check-in QR code"');

    // And the plain-text part carries the same placeholders.
    expect(rendered.body).toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
    expect(rendered.body).toContain(REGISTRATION_MANAGE_API_SENTINEL);
  });

  it("resolves both snapshots to the same private URL at delivery", async () => {
    const rendered = renderRegistrationConfirmation();

    const prepared = await prepareEmailBodyForDelivery({
      messageId: "message-1",
      registrationId: "registration-1",
      bodyText: rendered.body,
      bodyHtml: rendered.bodyHtml,
      now: new Date("2026-08-01T12:00:00.000Z"),
    });

    const manageUrl = `https://events.imsda.test/manage/${issuedToken}`;
    const passUrl = `https://events.imsda.test/api/public/manage/${issuedToken}`
      + `/attendee-passes/${attendeeId}/qr?format=png`;

    // The formatted part now points at the real, working URLs.
    expect(prepared.bodyHtml).toContain(`<a href="${manageUrl}"`);
    expect(prepared.bodyHtml).toContain(`<img src="${passUrl}"`);

    // The plain-text fallback offers the same link, from the same grant.
    expect(prepared.bodyText).toContain(manageUrl);
    expect(prepared.bodyText).toContain(passUrl);

    // No sentinel escapes into a delivered body.
    expect(prepared.bodyHtml).not.toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
    expect(prepared.bodyHtml).not.toContain(REGISTRATION_MANAGE_API_SENTINEL);
    expect(prepared.bodyText).not.toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
    expect(prepared.bodyText).not.toContain(REGISTRATION_MANAGE_API_SENTINEL);
    expect(createStableRegistrationAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ renewExpired: false }),
    );
  });

  it("allows an expired recovery-email link to renew during a delayed retry", async () => {
    const rendered = renderRegistrationConfirmation();

    await prepareEmailBodyForDelivery({
      messageId: "recovery-message-1",
      registrationId: "registration-1",
      templateKey: "REGISTRATION_ACCESS_RECOVERY",
      bodyText: rendered.body,
      bodyHtml: rendered.bodyHtml,
      now: new Date("2026-08-01T12:31:00.000Z"),
    });

    expect(createStableRegistrationAccessToken).toHaveBeenCalledWith({
      registrationId: "registration-1",
      deliveryKey: "message:recovery-message-1",
      now: new Date("2026-08-01T12:31:00.000Z"),
      expiresAt: new Date("2026-08-01T13:01:00.000Z"),
      renewExpired: true,
    });
  });

  it("leaves the stored snapshots untouched", async () => {
    const rendered = renderRegistrationConfirmation();
    const storedText = rendered.body;
    const storedHtml = rendered.bodyHtml;

    await prepareEmailBodyForDelivery({
      messageId: "message-1",
      registrationId: "registration-1",
      bodyText: rendered.body,
      bodyHtml: rendered.bodyHtml,
      now: new Date("2026-08-01T12:00:00.000Z"),
    });

    // Resolution happens in memory. A token must never reach a stored row.
    expect(rendered.body).toBe(storedText);
    expect(rendered.bodyHtml).toBe(storedHtml);
    expect(storedHtml).toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
    expect(storedHtml).not.toContain(issuedToken);
  });

  /**
   * The sentinels are accepted by exact shape, not by "looks internal". A body
   * that merely starts with the API sentinel must not reach an attribute, or
   * the exemption becomes a way past the scheme check.
   */
  it("accepts only the exact generated sentinel shapes", async () => {
    const { renderEmailBodyHtml } = await import("@/modules/communications/email-html");

    const forged = renderEmailBodyHtml([
      `[Almost](${REGISTRATION_MANAGE_LINK_SENTINEL}/../elsewhere)`,
      "",
      `![Almost](${REGISTRATION_MANAGE_API_SENTINEL}/attendee-passes/x/qr?format=svg)`,
      "",
      `![Almost](${REGISTRATION_MANAGE_API_SENTINEL}.evil.example/attendee-passes/x/qr?format=png)`,
      "",
      "[Almost](__IMSDA_SOMETHING_ELSE__)",
    ].join("\n"));

    expect(forged).not.toContain("<a href=");
    expect(forged).not.toContain("<img");
  });
});
