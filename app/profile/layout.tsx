import type { Metadata } from "next";

/**
 * Only `/profile/sign-in` lives here now (#543). The profile itself moved into
 * the layouts it belongs to (#646): `/profile` under `(workspace)` for staff,
 * `/account/profile` under the attendee portal. Never indexable.
 */
export const metadata: Metadata = {
  title: "Edit profile",
  robots: { index: false, follow: false, nocache: true },
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
