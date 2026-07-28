import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck, ShieldAlert, UserX, UsersRound } from "lucide-react";
import { getCurrentSession } from "@/modules/access/current-session";
import { getTeamDirectory } from "@/modules/system-admin/team-directory";

export const metadata: Metadata = { title: "Team" };

function friendly(value: string) {
  return value.split("_").map((part) => (
    part.charAt(0) + part.slice(1).toLowerCase()
  )).join(" ");
}

function whenever(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : "—";
}

export default async function TeamDirectoryPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const directory = await getTeamDirectory();

  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin">
        Back to system administration
      </Link>
      <section className="page-stack">
        <div className="page-intro">
          <div>
            <p className="eyebrow">System administration</p>
            <h2>Team</h2>
            <p>
              Everyone who can sign in to IMSDA Events, and the events they work on. Access is still
              granted on each event’s own team page, so this is a directory rather than a second way
              to hand out permissions.
            </p>
          </div>
        </div>

        <div className="reminder-summary" aria-label="Team summary">
          <article>
            <span className="message-stat-icon green"><UsersRound size={18} aria-hidden="true" /></span>
            <small>Active accounts</small>
            <strong>{directory.activeCount}</strong>
          </article>
          <article>
            <span className="message-stat-icon purple"><ShieldCheck size={18} aria-hidden="true" /></span>
            <small>System administrators</small>
            <strong>{directory.systemAdminCount}</strong>
          </article>
          <article>
            <span className="message-stat-icon gold"><UserX size={18} aria-hidden="true" /></span>
            <small>Can sign in, reach nothing</small>
            <strong>{directory.withoutAccessCount}</strong>
          </article>
        </div>

        <section className="panel">
          <div className="reminder-recipient-table-wrap">
            <table className="reminder-recipient-table">
              <caption>{directory.totalCount} account{directory.totalCount === 1 ? "" : "s"}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Status</th>
                  <th scope="col">Two-factor</th>
                  <th scope="col">Last signed in</th>
                  <th scope="col">Events</th>
                </tr>
              </thead>
              <tbody>
                {directory.members.map((member) => (
                  <tr key={member.id}>
                    <td>
                      {member.displayName}
                      {member.globalRole === "SYSTEM_ADMIN" && (
                        <small>System administrator</small>
                      )}
                    </td>
                    <td>{member.email}</td>
                    <td>{friendly(member.accountStatus)}</td>
                    <td>
                      {member.mfaStatus === "ACTIVE"
                        ? <><ShieldCheck aria-hidden="true" size={13} /> On</>
                        : member.mfaStatus === "PENDING"
                          ? <><ShieldAlert aria-hidden="true" size={13} /> Started</>
                          : <><ShieldAlert aria-hidden="true" size={13} /> Off</>}
                    </td>
                    <td>{whenever(member.lastSignedInAt)}</td>
                    <td>
                      {member.memberships.length === 0
                        ? "No events"
                        : `${member.memberships.length} event${member.memberships.length === 1 ? "" : "s"}`}
                      {member.memberships.length > 0 && (
                        <small>
                          {member.memberships
                            .map((membership) => `${membership.eventName} — ${friendly(membership.role)}`)
                            .join("; ")}
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </>
  );
}
