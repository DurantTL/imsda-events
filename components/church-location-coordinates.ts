/** Text in a coordinate field → the value the PATCH sends (#480). */
export function numberOrNull(value: string) {
  const text = value.trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : text;
}

/** A coordinate rounded for display after a map click or drag. */
export function displayCoordinate(value: number) {
  return value.toFixed(6);
}
