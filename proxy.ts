import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { REQUEST_TARGET_HEADER } from "@/modules/access/login-routing";

/**
 * Records the requested path and query on the *request* so server
 * components can send a signed-out staff member to `/login?next=...` (#108).
 * It only overwrites one request header: no redirects, no rewrites, and no
 * response headers, so noindex and CSP behaviour come unchanged from
 * `next.config.ts` and the pages. A client-supplied value is overwritten,
 * and the reader validates it with `safeReturnTo` anyway.
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_TARGET_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// Staff workspace pages and the signed-in account area, so a signed-out visit
// can sign in and come back (#568). Not /api, /_next, static files or public pages.
export const config = {
  matcher: [
    "/account/:path*",
    "/admin/:path*",
    "/check-in/:path*",
    "/communications/:path*",
    "/community/:path*",
    "/finance/:path*",
    "/imports/:path*",
    "/more/:path*",
    "/overview/:path*",
    "/people/:path*",
    "/registration-builder/:path*",
    "/staff/:path*",
    "/event-setup/:path*",
    "/no-access",
    "/select-event",
  ],
};
