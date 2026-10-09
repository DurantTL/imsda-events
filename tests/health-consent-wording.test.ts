import { describe, expect, it } from "vitest";
import { HEALTH_CONSENT_TEXT, HEALTH_CONSENT_VERSION } from "@/modules/health-records/domain";

describe("health record consent wording (#389)", () => {
  it("uses the 2026 Pathfinder Health Record text, not placeholders", () => {
    expect(HEALTH_CONSENT_VERSION).toBe("pathfinder-health-record-2026");
    for (const text of Object.values(HEALTH_CONSENT_TEXT)) {
      expect(text).not.toMatch(/placeholder|\[|\]/i);
    }
    expect(HEALTH_CONSENT_TEXT.emergencyTreatment).toMatch(/^In case of emergency, I hereby give permission/);
    expect(HEALTH_CONSENT_TEXT.activities).toMatch(/give my full consent to the terms found therein\.$/);
    expect(HEALTH_CONSENT_TEXT.photocopy).toBe("Permission for photo copying of this health record is granted.");
  });
});
