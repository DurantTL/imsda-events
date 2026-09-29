import "server-only";

import { headers } from "next/headers";
import { REQUEST_TARGET_HEADER, staffLoginPathFor } from "@/modules/access/login-routing";

/**
 * Where a signed-out staff request should go: `/login?next=<the page they
 * asked for>` when `proxy.ts` recorded the request path, otherwise plain
 * `/login`. Outside a request scope (or when the header is missing or
 * unsafe) it degrades to `/login`.
 */
export async function staffLoginRedirectPath(): Promise<string> {
  try {
    const requestHeaders = await headers();
    return staffLoginPathFor(requestHeaders.get(REQUEST_TARGET_HEADER));
  } catch {
    return staffLoginPathFor(null);
  }
}
