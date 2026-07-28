import "server-only";

import { getPrisma } from "@/lib/prisma";

/**
 * Every person who can sign in to the platform, with the events they work on.
 *
 * The per-event team page answers "who is on this event". This answers the
 * question that page structurally cannot: who exists at all. Before this, an
 * account with no memberships — a departed staff member, a half-finished
 * invitation — appeared on no page in the system while still being able to
 * sign in.
 *
 * Read-only. Changing a person's access still happens on the event whose access
 * it is, so this does not become a second, competing way to grant permissions.
 */
export type TeamDirectoryMembership = {
  eventId: string;
  eventName: string;
  role: string;
  status: string;
};

export type TeamDirectoryMember = {
  id: string;
  email: string;
  displayName: string;
  globalRole: string | null;
  accountStatus: string;
  /** Whether sign-in is switched off platform-wide. */
  signInDisabled: boolean;
  activatedAt: string | null;
  createdAt: string;
  lastSignedInAt: string | null;
  mfaStatus: "ACTIVE" | "PENDING" | "NONE";
  memberships: TeamDirectoryMembership[];
};

export type TeamDirectory = {
  members: TeamDirectoryMember[];
  totalCount: number;
  activeCount: number;
  systemAdminCount: number;
  /**
   * Accounts that can sign in but reach nothing: no global role and no active
   * membership. Worth surfacing rather than counting, because each one is
   * either an unfinished setup or an access that outlived its purpose.
   */
  withoutAccessCount: number;
};

export async function getTeamDirectory(): Promise<TeamDirectory> {
  const prisma = getPrisma();
  const users = await prisma.user.findMany({
    orderBy: [{ accountStatus: "asc" }, { displayName: "asc" }],
    select: {
      id: true,
      email: true,
      displayName: true,
      globalRole: true,
      accountStatus: true,
      activatedAt: true,
      createdAt: true,
      credential: { select: { disabledAt: true } },
      mfaEnrollment: { select: { status: true } },
      sessions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
      memberships: {
        orderBy: { event: { startsAt: "desc" } },
        select: {
          role: true,
          status: true,
          event: { select: { id: true, name: true } },
        },
      },
    },
  });

  const members: TeamDirectoryMember[] = users.map((user) => ({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    globalRole: user.globalRole,
    accountStatus: user.accountStatus,
    signInDisabled: Boolean(user.credential?.disabledAt),
    activatedAt: user.activatedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    lastSignedInAt: user.sessions[0]?.createdAt.toISOString() ?? null,
    mfaStatus: user.mfaEnrollment?.status === "ACTIVE"
      ? "ACTIVE"
      : user.mfaEnrollment?.status === "PENDING"
        ? "PENDING"
        : "NONE",
    memberships: user.memberships.map((membership) => ({
      eventId: membership.event.id,
      eventName: membership.event.name,
      role: membership.role,
      status: membership.status,
    })),
  }));

  return {
    members,
    totalCount: members.length,
    activeCount: members.filter((member) => member.accountStatus === "ACTIVE").length,
    systemAdminCount: members.filter((member) => member.globalRole === "SYSTEM_ADMIN").length,
    withoutAccessCount: members.filter((member) => (
      member.globalRole === null
      && !member.memberships.some((membership) => membership.status === "ACTIVE")
    )).length,
  };
}
