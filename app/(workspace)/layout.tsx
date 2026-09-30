import type { Metadata } from "next";
import { WorkspaceShell } from "@/components/workspace-shell";

export const dynamic = "force-dynamic";

/**
 * Every page under the staff/admin workspace is authenticated (#108): noindex
 * here so a page that doesn't set its own `robots` still isn't indexable.
 * Child pages inherit it unless they set `robots` themselves. Paths that
 * `robots.ts` disallows are never fetched by obeying crawlers, so the tag
 * matters mainly for workspace paths it does not list (for example /admin).
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
