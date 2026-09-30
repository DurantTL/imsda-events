import type { Metadata } from "next";
import { headers } from "next/headers";
import { WorkspaceShell } from "@/components/workspace-shell";
import { REQUEST_TARGET_HEADER } from "@/modules/access/login-routing";

export const dynamic = "force-dynamic";

/**
 * Every page under the staff/admin workspace is authenticated (#108): noindex
 * here so a page that doesn't set its own `robots` still isn't indexable.
 * Child pages inherit it unless they set `robots` themselves. Paths that
 * `robots.ts` disallows are never fetched by obeying crawlers, so the tag
 * matters mainly for workspace paths it does not list (for example /admin).
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * `/profile` (#646) lives in this group so it keeps the shell. Staff with no
 * event assignment can still open their own profile (#623), so a request that
 * `proxy.ts` recorded as `/profile` lets them in instead of /no-access. On a
 * client-side navigation this layout is not re-rendered, which only happens
 * for an account that already had events.
 */
async function isProfileRequest() {
  try {
    const target = (await headers()).get(REQUEST_TARGET_HEADER) ?? "";
    const path = target.split(/[?#]/, 1)[0].replace(/\/+$/, "");
    return path === "/profile";
  } catch {
    return false;
  }
}

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceShell anyStaffWithoutEvents={await isProfileRequest()}>{children}</WorkspaceShell>;
}
