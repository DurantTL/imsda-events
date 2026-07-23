import { describe, expect, it } from "vitest";
import { messagingSettingsInputSchema } from "@/modules/communications/schemas";

const base = {
  senderName: "IMSDA Events",
  senderEmail: "",
  replyToEmail: "",
  internalNotificationEmails: [],
};

describe("messaging delivery settings", () => {
  it.each(["DISABLED", "LOCAL_CAPTURE"] as const)("accepts the %s UI mode", (deliveryMode) => {
    expect(messagingSettingsInputSchema.parse({
      ...base,
      deliveryMode,
    }).deliveryMode).toBe(deliveryMode);
  });

  it("accepts real email only with a sender address", () => {
    expect(messagingSettingsInputSchema.safeParse({
      ...base,
      deliveryMode: "EXTERNAL_EMAIL",
    }).success).toBe(false);
    expect(messagingSettingsInputSchema.parse({
      ...base,
      deliveryMode: "EXTERNAL_EMAIL",
      senderEmail: "registration@imsda.org",
    }).deliveryMode).toBe("EXTERNAL_EMAIL");
  });
});
