/**
 * Reads a JSON request body the way the club import does: as text first, so an
 * oversized body is refused (413) and malformed JSON is a 400, and neither
 * path logs the body, which for an import holds organization contact details.
 */
export async function readJsonBody(request: Request, maxChars: number): Promise<{ body: unknown } | { response: Response }> {
  const text = await request.text();
  if (text.length > maxChars) {
    return { response: Response.json({ error: "REQUEST_TOO_LARGE", message: "That request is too large." }, { status: 413 }) };
  }
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { response: Response.json({ error: "INVALID_JSON", message: "The request isn't valid JSON." }, { status: 400 }) };
  }
}
