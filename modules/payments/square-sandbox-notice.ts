/**
 * The test-mode line on the payment card (#700). Only a staff preview shows
 * it: a public visitor never sees the Square environment.
 */
export function squareTestModeNotice(input: {
  environment: "sandbox" | "production";
  staffPreview: boolean;
}): string | null {
  if (input.environment !== "sandbox" || !input.staffPreview) return null;
  return "Test mode \u2014 no real charge will be made";
}
