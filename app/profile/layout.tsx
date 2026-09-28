import type { Metadata } from "next";

/**
 * `/profile` sits outside both the staff `(workspace)` group and the attendee
 * `(portal)` group (#543), so neither layout's redirects apply. It resolves
 * each session itself; the two stay separate (ADR 0003). Never indexable.
 */
export const metadata: Metadata = {
  title: "Edit profile",
  robots: { index: false, follow: false, nocache: true },
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
