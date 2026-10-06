import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { getFormTemplate } from "@/modules/forms/definition";
import { CLUB_ONLY_NOTICES } from "@/modules/club-registrations/club-notices";

// The real public registration form for a church-billed club event, rendered signed out (#799 G7).
// Its church-invoice billing wording is intended public text and stays; the signed-in club notices must not appear.
function renderPublicForm() {
  const template = getFormTemplate("honors_weekend");
  if (!template) throw new Error("honors_weekend template missing");
  return renderToStaticMarkup(createElement(PublicRegistrationForm, {
    event: {
      name: "Synthetic Honors Weekend",
      slug: "synthetic-honors-weekend",
      startsAt: "2027-03-12T22:00:00.000Z",
      endsAt: "2027-03-14T17:00:00.000Z",
      timezone: "America/Chicago",
      location: "Fictitious Camp",
      capacity: null,
      registrationOpensOn: null,
      registrationClosesOn: null,
      waitlistEnabled: false,
      billingMode: "DEFERRED_ORGANIZATION_INVOICE",
      ageOfMajority: 18,
    } as never,
    form: { slug: "club-roster", versionId: "v1", versionNumber: 1, definition: structuredClone(template.definition) },
    choiceUsage: {},
    pricingDate: "2027-01-01",
    lifecycle: { phase: "OPEN", capacityDecision: "REGISTER", remainingSpots: null, waitingRegistrations: 0 },
    disableDrafts: true,
  }));
}

describe("the real public form of a church-billed club event", () => {
  it("renders, and shows none of the signed-in club notices", () => {
    const markup = renderPublicForm();
    expect(markup.length).toBeGreaterThan(1000);
    expect(markup).toContain("Synthetic Honors Weekend");
    for (const notice of CLUB_ONLY_NOTICES) expect(markup, notice).not.toContain(notice);
  });
});
