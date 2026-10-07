import { describe, expect, it } from "vitest";
import { isSensitiveField, isSensitiveFieldText } from "@/modules/forms/sensitive-fields";

describe("Sterling Volunteers fields are screened as sensitive (#443)", () => {
  it("catches a custom field named for Sterling Volunteers", () => {
    expect(isSensitiveFieldText("Sterling Volunteers clearance")).toBe(true);
    expect(isSensitiveField({ key: "sterling_volunteers_status", label: "Status", helpText: "", options: [] })).toBe(true);
    expect(isSensitiveField({ key: "adult_clearance", label: "Sterling Volunteers", helpText: "", options: [] })).toBe(true);
  });

  it("still lets an ordinary field through", () => {
    expect(isSensitiveField({ key: "club_name", label: "Club name", helpText: "", options: [] })).toBe(false);
  });
});
