import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Portal labels (#742): the menu label, page heading and Back text agree. Reads source; synthetic only. */
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const portal = "app/(public)/account/(portal)";

describe("portal labels (#742)", () => {
  it("calls the account tab and its page My registrations", () => {
    expect(read(`${portal}/layout.tsx`)).toContain('label: "My registrations"');
    expect(read(`${portal}/registrations/page.tsx`)).toContain("<h1>My registrations</h1>");
  });

  it("keeps the account tab order: Overview, My registrations, club, Waitlists, Profile", () => {
    const layout = read(`${portal}/layout.tsx`);
    const order = ['label: "Overview"', 'label: "My registrations"', '"Waitlists"', 'label: "Profile"'].map((text) => layout.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("names the club events tab, heading and Back link alike", () => {
    expect(read("components/club-event-list.tsx")).toContain(">Club events</h2>");
    expect(read(`${portal}/clubs/[organizationId]/events/[eventId]/page.tsx`)).toContain("Back to club events");
  });

  it("names the club settings page and its form alike", () => {
    expect(read(`${portal}/clubs/[organizationId]/club-info/page.tsx`)).toContain('title: "Club settings"');
    expect(read("components/club-profile-form.tsx")).toContain(">Club settings</p>");
  });

  it("has no tab-level Back link on the Area Coordinator health list", () => {
    expect(read(`${portal}/area/health/page.tsx`)).not.toContain("Back to your account");
  });
});
