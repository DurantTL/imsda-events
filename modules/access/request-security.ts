export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function rejectCrossOriginRequest(request: Request) {
  return isSameOriginRequest(request)
    ? null
    : Response.json({ error: "INVALID_REQUEST_ORIGIN", message: "This request must come from the IMSDA Events workspace." }, { status: 403 });
}
