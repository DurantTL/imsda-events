import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttendeePassGrid } from "@/components/attendee-pass-grid";

const attendees = [{ id: "attendee-1", name: "Avery Person" }];
const render = (via: "attendee" | "staff" | null) =>
  renderToStaticMarkup(createElement(AttendeePassGrid, { registrationId: "registration-1", attendees, via }));

describe("retreat hub attendee pass grid (#744)", () => {
  it("renders QR images for the attendee's own session", () => {
    const html = render("attendee");
    expect(html).toContain("/api/attendee/registrations/registration-1/attendee-passes/attendee-1/qr");
    expect(html).not.toContain("switch-to-attendee");
  });

  it.each(["staff", null] as const)("shows a switch prompt, not images, when via is %s", (via) => {
    const html = render(via);
    expect(html).not.toContain("<img");
    expect(html).toContain("Switch to your attendee account to show passes.");
    expect(html).toContain('action="/api/auth/switch-to-attendee"');
    expect(html).toContain('method="post"');
  });
});
