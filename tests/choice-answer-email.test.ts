import { describe, expect, it } from "vitest";
import { CHOICE_FILTER_UNANSWERED } from "@/modules/registrations/choice-answer-filter";
import { choiceEmailDraft, choiceEmailRegistrationIds } from "@/modules/registrations/choice-answer-email";
import { closeRegistrationUrlAction, followRegistrationParam, withoutRegistrationParam } from "@/lib/registration-param";

describe("Email these people on a Filter by answer result (#783)", () => {
  it("counts each registration once even when several attendees on it match", () => {
    const matches = [
      { registrationId: "R1" },
      { registrationId: "R2" },
      { registrationId: "R1" },
      { registrationId: "R3" },
      { registrationId: "R2" },
    ];
    expect(choiceEmailRegistrationIds(matches)).toEqual(["R1", "R2", "R3"]);
  });

  it("pre-fills an editable announcement for No answer that points at each recipient's own link", () => {
    const draft = choiceEmailDraft({ questionLabel: "Meal preference", value: CHOICE_FILTER_UNANSWERED });
    expect(draft).not.toBeNull();
    expect(draft!.templateKey).toBe("EVENT_ANNOUNCEMENT");
    expect(draft!.title).toBe("Please add your answer: Meal preference");
    expect(draft!.body).toContain("Meal preference");
    expect(draft!.body).toContain("link to your registration in this email");
    // No URL or token is written here: the announcement template adds each recipient's manage link at delivery.
    expect(draft!.body).not.toMatch(/https?:|__IMSDA_PRIVATE_MANAGE_LINK__/);
  });

  it("keeps a long question label inside the subject and body limits", () => {
    const draft = choiceEmailDraft({ questionLabel: "x".repeat(500), value: CHOICE_FILTER_UNANSWERED })!;
    expect(draft.title.length).toBeLessThanOrEqual(120);
    expect(draft.body.length).toBeLessThanOrEqual(4000);
  });

  it("offers no draft for an answered value or the other bucket", () => {
    expect(choiceEmailDraft({ questionLabel: "Meal preference", value: "Vegan" })).toBeNull();
    expect(choiceEmailDraft({ questionLabel: "Meal preference", value: "__other" })).toBeNull();
    expect(choiceEmailDraft({ questionLabel: "Meal preference", value: null })).toBeNull();
  });

  it("drops only the registration parameter, so closing a detail keeps the filter", () => {
    expect(withoutRegistrationParam("event=evt&registration=R1&answerQuestion=ATTENDEE%3Ameal_preference&answerValue=__unanswered"))
      .toBe("event=evt&answerQuestion=ATTENDEE%3Ameal_preference&answerValue=__unanswered");
    expect(withoutRegistrationParam("registration=R1")).toBe("");
  });

  it("follows the URL: the parameter opens, vanishing closes only a detail it opened", () => {
    expect(followRegistrationParam("R1", null)).toBe("open");
    expect(followRegistrationParam("R2", { id: "R1", hardLoad: false })).toBe("open");
    expect(followRegistrationParam(undefined, { id: "R1", hardLoad: false })).toBe("close-state");
    expect(followRegistrationParam(undefined, null)).toBe("none");
  });

  it("closes via back after a client navigation, via replace after a hard load, and never touches the URL otherwise", () => {
    expect(closeRegistrationUrlAction("R1", { id: "R1", hardLoad: false })).toBe("back");
    expect(closeRegistrationUrlAction("R1", { id: "R1", hardLoad: true })).toBe("replace");
    expect(closeRegistrationUrlAction("R1", null)).toBe("none");
    expect(closeRegistrationUrlAction(undefined, { id: "R1", hardLoad: false })).toBe("none");
  });
});
