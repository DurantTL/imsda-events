"use client";

import { EmptyState } from "@/components/empty-state";
import { staffPageTitles } from "@/components/staff-navigation";
import { useMemo, useState } from "react";
import { Check, KeyRound, Plus, Search, ShieldCheck, UserCog, X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { eventRoles, rolePermissions, type EventRole } from "@/modules/access/permissions";
import { roleDetails, roleLabel } from "@/modules/access/role-display";

type StaffMembership = {
  id: string;
  role: EventRole;
  status: "ACTIVE" | "INACTIVE";
  permissions: string[];
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    displayName: string;
    email: string;
    jobTitle: string;
    phone: string;
    bio: string;
    globalRole: string | null;
    accountStatus: "PENDING_ACTIVATION" | "ACTIVE";
    accountDisabled: boolean;
  };
};

export function StaffWorkspace({ eventId, eventName, initialMemberships, currentUserId, currentUserIsSystemAdmin, canAddStaff = false }: { eventId: string; eventName: string; initialMemberships: StaffMembership[]; currentUserId: string; currentUserIsSystemAdmin: boolean; /** Whether the viewer may add staff: the button and the empty-state action show only then (#743). The server decides again. */ canAddStaff?: boolean }) {
  const [memberships, setMemberships] = useState(initialMemberships);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<StaffMembership | null>(null);
  const [modal, setModal] = useState<"add" | "edit" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [setupUrl, setSetupUrl] = useState("");
  const [invitedEmail, setInvitedEmail] = useState("");
  const dialogRef = useAccessibleDialog<HTMLElement>(Boolean(modal), closeModal);

  const visible = useMemo(() => memberships.filter((membership) => `${membership.user.displayName} ${membership.user.email} ${membership.user.jobTitle} ${membership.user.phone} ${roleLabel(membership.role)}`.toLowerCase().includes(query.toLowerCase())), [memberships, query]);
  const activeCount = memberships.filter((membership) => membership.status === "ACTIVE" && !membership.user.accountDisabled).length;

  function openAdd() { setSelected(null); setError(""); setSetupUrl(""); setInvitedEmail(""); setModal("add"); }
  function openEdit(membership: StaffMembership) { setSelected(membership); setError(""); setSetupUrl(""); setInvitedEmail(""); setModal("edit"); }
  function closeModal() { if (!saving) { setModal(null); setError(""); } }

  async function changeGlobalRole(membership: StaffMembership, grant: boolean) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/users/${membership.user.id}/global-role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ globalRole: grant ? "SYSTEM_ADMIN" : null, eventId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to change the system role.");
      const updated = {
        ...membership,
        user: { ...membership.user, globalRole: result.user.globalRole as string | null },
      };
      setMemberships((current) => current.map((row) => row.id === updated.id ? updated : row));
      setSelected(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to change the system role.");
    } finally {
      setSaving(false);
    }
  }

  async function changeHealthAccess(membership: StaffMembership, granted: boolean) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/memberships/${encodeURIComponent(membership.id)}/health-access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granted }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to change health information access.");
      const permissions = granted
        ? [...new Set([...membership.permissions, "VIEW_HEALTH_INFORMATION"])]
        : membership.permissions.filter((permission) => permission !== "VIEW_HEALTH_INFORMATION");
      const updated = { ...membership, permissions };
      setMemberships((current) => current.map((row) => row.id === updated.id ? updated : row));
      setSelected(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to change health information access.");
    } finally {
      setSaving(false);
    }
  }

  async function changeInvoiceAccess(membership: StaffMembership, granted: boolean) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/memberships/${encodeURIComponent(membership.id)}/invoice-finalization-access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granted }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to change permission to finalize invoices.");
      const permissions = granted
        ? [...new Set([...membership.permissions, "FINALIZE_INVOICES"])]
        : membership.permissions.filter((permission) => permission !== "FINALIZE_INVOICES");
      const updated = { ...membership, permissions };
      setMemberships((current) => current.map((row) => row.id === updated.id ? updated : row));
      setSelected(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to change permission to finalize invoices.");
    } finally {
      setSaving(false);
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const editing = modal === "edit" && selected;
    const url = editing ? `/api/events/${eventId}/memberships/${selected.id}` : `/api/events/${eventId}/memberships`;
    const payload = editing
      ? { role: form.get("role"), status: form.get("status") }
      : { displayName: form.get("displayName"), email: form.get("email"), role: form.get("role") };
    try {
      const response = await fetch(url, { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Unable to save the staff assignment.");
      const membership = result.membership as StaffMembership;
      setMemberships((current) => editing ? current.map((row) => row.id === membership.id ? membership : row) : [membership, ...current.filter((row) => row.id !== membership.id)]);
      if (result.setupUrl || result.invitationEmailed) {
        setSetupUrl(result.setupUrl ?? "");
        setInvitedEmail(result.invitationEmailed ? membership.user.email : "");
        setSelected(membership);
        setModal("edit");
      } else {
        setModal(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the staff assignment.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="page-stack">
    <div className="page-intro"><div><p className="eyebrow">Event access</p><h2 className="duplicate-page-title">{staffPageTitles.team}</h2><p>Control who can work in {eventName} and which operational role each account receives.</p></div><div className="intro-actions"><span className="count-badge"><ShieldCheck size={16} /> {activeCount} active</span>{canAddStaff && <button className="primary-button" type="button" onClick={openAdd}><Plus size={17} /> Add staff</button>}</div></div>
    <div className="toolbar panel"><label className="search-field"><Search size={18} /><span className="sr-only">Search staff</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search staff name, email, or role" /></label></div>
    <div className="staff-list panel"><div className="staff-row staff-head"><span>Staff member</span><span>Event role</span><span>Status</span><span>Access</span></div>{visible.map((membership) => {
      const pendingActivation = membership.user.accountStatus === "PENDING_ACTIVATION";
      const hasAccess = membership.status === "ACTIVE" && !membership.user.accountDisabled && !pendingActivation;
      const statusLabel = membership.user.accountDisabled
        ? "account disabled"
        : pendingActivation
          ? "awaiting activation"
          : membership.status.toLowerCase();
      return <button className="staff-row staff-record" type="button" key={membership.id} onClick={() => openEdit(membership)}><span className="staff-person"><span className="person-avatar">{membership.user.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span><span><strong>{membership.user.displayName}{membership.user.id === currentUserId ? " (you)" : ""}</strong><small>{membership.user.jobTitle || membership.user.email}</small>{membership.user.jobTitle && <small>{membership.user.email}</small>}</span></span><span><strong>{roleLabel(membership.role)}</strong><small>{membership.user.globalRole === "SYSTEM_ADMIN" ? "System administrator" : roleDetails[membership.role].description}</small></span><span className={`status-chip ${hasAccess ? "green" : "purple"}`}>{statusLabel}</span><span>{hasAccess ? `${rolePermissions[membership.role].length} permissions` : "No access"}</span></button>;
    })}</div>
    {memberships.length === 0
      ? <EmptyState action={{ label: "Add the first staff member", onClick: openAdd }} actionClass="secondary-button" canCreate={canAddStaff} className="empty-state panel" hint="Ask an event administrator to add staff." icon={<UserCog size={24} />} title="No staff on this event yet">Nobody but system administrators can work in {eventName} until you add someone and choose their role.</EmptyState>
      : visible.length === 0 && <div className="empty-state panel"><UserCog size={24} /><h3>No matching staff</h3><p>Try a different name, email, or role.</p></div>}
    <section className="panel permission-matrix"><div className="section-heading"><div><p className="eyebrow">Permission matrix</p><h2>Role boundaries</h2></div></div><div className="role-grid">{eventRoles.map((role) => <article key={role}><strong>{roleLabel(role)}</strong><p>{roleDetails[role].description}</p><ul>{rolePermissions[role].map((permission) => <li key={permission}><Check size={13} /> {permission.toLowerCase().replaceAll("_", " ")}</li>)}</ul></article>)}</div></section>
    {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}><section className="modal-card" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="staff-modal-title" tabIndex={-1}><div className="modal-head"><div><p className="eyebrow">Event access</p><h2 id="staff-modal-title">{modal === "add" ? "Add a staff account" : selected?.user.displayName}</h2></div><button className="icon-button" type="button" onClick={closeModal} aria-label="Close dialog"><X size={18} /></button></div>{selected?.user.accountDisabled && <div className="inline-notice error" role="status">This person&apos;s account is disabled across all events. Changing this event assignment will not restore sign-in access.</div>}{invitedEmail && <div className="auth-success" role="status"><strong>Activation email sent</strong><p>{invitedEmail} has been emailed a one-time link to choose their own password. It expires in seven days; they can request another from &ldquo;Forgot password&rdquo; if it lapses.</p></div>}{setupUrl && <div className="auth-success"><strong>Activation link ready</strong><p>Send this one-time link to {selected?.user.email} so they can choose their own password. It is shown once and expires in seven days. This deployment has no account email configured, so pass it on yourself.</p><input className="copy-field" readOnly value={setupUrl} onFocus={(event) => event.currentTarget.select()} /><a className="primary-button" href={setupUrl}><KeyRound size={16} /> Open activation link</a></div>}{modal === "edit" && selected && <div className="inline-notice"><strong>{selected.user.jobTitle || "Team profile"}</strong><p>{selected.user.email}{selected.user.phone ? ` · ${selected.user.phone}` : ""}{selected.user.bio ? ` — ${selected.user.bio}` : ""}</p>{currentUserIsSystemAdmin && <small>Rename or edit profile details in System management → Team.</small>}</div>}{modal === "edit" && selected && selected.user.accountStatus === "PENDING_ACTIVATION" && !setupUrl && <div className="inline-notice" role="status">This account has not been activated. Its owner has never signed in and cannot until they use an activation link.</div>}{modal === "edit" && selected && currentUserIsSystemAdmin && <div className="inline-notice"><strong>System administrator</strong><p>{selected.user.globalRole === "SYSTEM_ADMIN" ? "This account can administer every event and manage system roles." : "Grant this only to accounts that must administer every event."}</p><button className="secondary-button" type="button" disabled={saving} onClick={() => changeGlobalRole(selected, selected.user.globalRole !== "SYSTEM_ADMIN")}><ShieldCheck size={16} /> {selected.user.globalRole === "SYSTEM_ADMIN" ? "Remove system administrator" : "Make system administrator"}</button></div>}{modal === "edit" && selected && currentUserIsSystemAdmin && selected.user.globalRole !== "SYSTEM_ADMIN" && <div className="inline-notice"><strong>Health information access</strong><p>{selected.permissions.includes("VIEW_HEALTH_INFORMATION") ? "This person can open the coordinator health view for this event: dietary notes as entered, the medical-need flag, and emergency contacts. Each time they look is recorded." : "Event Admins and other roles do not see health information. Grant it only to someone who needs it for this event."}</p><button className="secondary-button" type="button" disabled={saving} onClick={() => changeHealthAccess(selected, !selected.permissions.includes("VIEW_HEALTH_INFORMATION"))}><ShieldCheck size={16} /> {selected.permissions.includes("VIEW_HEALTH_INFORMATION") ? "Remove health information access" : "Give health information access"}</button></div>}{modal === "edit" && selected && currentUserIsSystemAdmin && selected.user.globalRole !== "SYSTEM_ADMIN" && selected.status === "ACTIVE" && <div className="inline-notice"><strong>Finalize invoices</strong><p>{selected.permissions.includes("FINALIZE_INVOICES") ? "This person can finalize invoices for this event, which assigns the invoice number and commits the conference to the amount. Each finalization is recorded with their name." : "Event Admins and finance managers can prepare invoice drafts but cannot finalize them. Give this permission only to the person, such as the treasurer, who approves invoices for this event. They also need finance access to the event."}</p><button className="secondary-button" type="button" disabled={saving} onClick={() => changeInvoiceAccess(selected, !selected.permissions.includes("FINALIZE_INVOICES"))}><ShieldCheck size={16} /> {selected.permissions.includes("FINALIZE_INVOICES") ? "Remove permission to finalize invoices" : "Give permission to finalize invoices"}</button></div>}<form className="form-stack staff-form" onSubmit={save}>{modal === "add" && <><label>Display name<input name="displayName" minLength={2} maxLength={100} required placeholder="Alex Staff Member" /></label><label>Email address<input name="email" type="email" required placeholder="alex@imsda.org" /></label></>}<label>Event role<select name="role" defaultValue={selected?.role ?? "READ_ONLY_STAFF"}>{eventRoles.map((role) => <option value={role} key={role}>{roleLabel(role)}</option>)}</select></label>{modal === "edit" && <label>Event access<select name="status" defaultValue={selected?.status ?? "ACTIVE"}><option value="ACTIVE">Can access this event</option><option value="INACTIVE">Remove access to this event</option></select></label>}{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button className="secondary-button" type="button" onClick={closeModal}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : modal === "add" ? "Add staff" : "Save access"}</button></div></form></section></div>}
  </section>;
}
