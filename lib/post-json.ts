/** Longer than the server's own transaction limit, so its readable error wins when there is one. */
export const postJsonTimeoutMs = 60_000;

export type PostJsonResult = { ok: boolean; status: number; body: Record<string, unknown> };

/**
 * POSTs JSON and always settles (#617): a request that outlasts the timeout, or an answer that is
 * not JSON (a gateway timeout page, for example), becomes a readable `message` instead of an
 * endless spinner. `fallbackMessage` starts every synthesized message.
 */
export async function postJson(
  url: string,
  payload: unknown,
  fallbackMessage: string,
  timeoutMs = postJsonTimeoutMs,
): Promise<PostJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // The body is read inside the timeout too: a response that starts and never ends is aborted.
    let body: unknown = null;
    try {
      body = await response.json();
    } catch (readError) {
      if (readError instanceof Error && readError.name === "AbortError") throw readError;
    }
    if (!body || typeof body !== "object") {
      return { ok: false, status: response.status, body: { message: `${fallbackMessage} The server answered with an error (${response.status}). Try again in a moment.` } };
    }
    return { ok: response.ok, status: response.status, body: body as Record<string, unknown> };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, status: 0, body: { message: `${fallbackMessage} It is taking too long. Check whether it finished before trying again.` } };
    }
    return { ok: false, status: 0, body: { message: `${fallbackMessage} The server could not be reached. Check your connection and try again.` } };
  } finally {
    clearTimeout(timer);
  }
}
