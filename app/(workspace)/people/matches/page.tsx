import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DuplicateMatchReviewWorkspace } from "@/components/duplicate-match-review-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { listOpenMatchCandidates } from "@/modules/people/duplicate-match-repository";

export const metadata: Metadata = { title: "Possible duplicate people" };

/**
 * Identity slice 2 (#126). Gated on `globalRole === "SYSTEM_ADMIN"` rather
 * than any single event's `EventPermission`: `Person` is a global,
 * cross-event entity, and this queue must not become a route to identity
 * data a reviewer could not otherwise see through their event roles. See
 * `modules/people/duplicate-match-access.ts`.
 */
export default async function DuplicateMatchQueuePage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const candidates = await listOpenMatchCandidates();
  return <DuplicateMatchReviewWorkspace initialCandidates={candidates} />;
}
