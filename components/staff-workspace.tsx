"use client";

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
    globalRole: string | null;
    accountStatus: "PENDING_ACTIVATION" | "ACTIVE";
    accountDisabled: boolean;
  };
};

export function StaffWorkspace({ eventId, eventName, initialMemberships, currentUserId, currentUserIsSystemAdmin }: { eventId: string; eventName: string; initialMemberships: StaffMembership[]; currentUserId: string; currentUserIsSystemAdmin: boolean }) {
  const [memberships, setMemberships] = useState(initialMemberships);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<StaffMembership | null>(null);
  const [modal, setModal] = useState<"add" | "edit" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [setupUrl, setSetupUrl] = useState("");
  const dialogRef = useAccessibleDialog<HTMLElement>(Boolean(modal), closeModal);

  const visible = useMemo(() => memberships.filter((membership) => `${membership.user.displayName} ${membership.user.email} ${roleLabel(membership.role)}`.toLowerCase().includes(query.toLowerCase())), [memberships, query]);
  const activeCount = memberships.filter((membership) => membership.status === "ACTIVE" && !membership.user.accountDisabled).length;

  function openAdd() { setSelected(null); setError(""); setSetupUrl(""); setModal("add"); }
  function openEdit(membership: StaffMembership) { setSelected(membership); setError(""); setSetupUrl(""); setModal("edit"); }
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
      if (result.setupUrl) {
        setSetupUrl(result.setupUrl);
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
    <div className="page-intro"><div><p className="eyebrow">Event access</p><h2>Staff assignments</h2><p>Control who can work in {eventName} and which operational role each account receives.</p></div><div className="intro-actions"><span className="count-badge"><ShieldCheck size={16} /> {activeCount} active</span><button className="primary-button" type="button" onClick={openAdd}><Plus size={17} /> Add staff</button></div></div>
    <div className="toolbar panel"><label className="search-field"><Search size={18} /><span className="sr-only">Search staff</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search staff name, email, or role" /></label></div>
    <div className="staff-list panel"><div className="staff-row staff-head"><span>Staff member</span><span>Event role</span><span>Status</span><span>Access</span></div>{visible.map((membership) => {
      const pendingActivation = membership.user.accountStatus === "PENDING_ACTIVATION";
      const hasAccess = membership.status === "ACTIVE" && !membership.user.accountDisabled && !pendingActivation;
      const statusLabel = membership.user.accountDisabled
        ? "account disabled"
        : pendingActivation
          ? "awaiting activation"
          : membership.status.toLowerCase();
      return <button className="staff-row staff-record" type="button" key={membership.id} onClick={() => openEdit(membership)}><span className="staff-person"><span className="person-avatar">{membership.user.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span><span><strong>{membership.user.displayName}{membership.user.id === currentUserId ? " (you)" : ""}</strong><small>{membership.user.email}</small></span></span><span><strong>{roleLabel(membership.role)}</strong><small>{membership.user.globalRole === "SYSTEM_ADMIN" ? "System administrator" : roleDetails[membership.role].description}</small></span><span className={`status-chip ${hasAccess ? "green" : "purple"}`}>{statusLabel}</span><span>{hasAccess ? `${rolePermissions[membership.role].length} permissions` : "No access"}</span></button>;
    })}</div>
    {visible.length === 0 && <div className="empty-state panel"><UserCog size={24} /><h3>No matching staff</h3><p>Try a different name, email, or role.</p></div>}
    <section className="panel permission-matrix"><div className="section-heading"><div><p className="eyebrow">Permission matrix</p><h2>Role boundaries</h2></div></div><div className="role-grid">{eventRoles.map((role) => <article key={role}><strong>{roleLabel(role)}</strong><p>{roleDetails[role].description}</p><ul>{rolePermissions[role].map((permission) => <li key={permission}><Check size={13} /> {permission.toLowerCase().replaceAll("_", " ")}</li>)}</ul></article>)}</div></section>
    {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}><section className="modal-card" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="staff-modal-title" tabIndex={-1}><div className="modal-head"><div><p className="eyebrow">Event access</p><h2 id="staff-modal-title">{modal === "add" ? "Add a staff account" : selected?.user.displayName}</h2></div><button className="icon-button" type="button" onClick={closeModal} aria-label="Close dialog"><X size={18} /></button></div>{selected?.user.accountDisabled && <div className="inline-notice error" role="status">This person&apos;s account is disabled across all events. Changing this event assignment will not restore sign-in access.</div>}{setupUrl && <div className="auth-success"><strong>Activation link ready</strong><p>Send this one-time link to {selected?.user.email} so they can choose their own password. It is shown once and expires in seven days. Email delivery is not connected yet, so pass it on yourself.</p><input className="copy-field" readOnly value={setupUrl} onFocus={(event) => event.currentTarget.select()} /><a className="primary-button" href={setupUrl}><KeyRound size={16} /> Open activation link</a></div>}{modal === "edit" && selected && selected.user.accountStatus === "PENDING_ACTIVATION" && !setupUrl && <div className="inline-notice" role="status">This account has not been activated. Its owner has never signed in and cannot until they use an activation link.</div>}{modal === "edit" && selected && currentUserIsSystemAdmin && <div className="inline-notice"><strong>System administrator</strong><p>{selected.user.globalRole === "SYSTEM_ADMIN" ? "This account can administer every event and manage system roles." : "Grant this only to accounts that must administer every event."}</p><button className="secondary-button" type="button" disabled={saving} onClick={() => changeGlobalRole(selected, selected.user.globalRole !== "SYSTEM_ADMIN")}><ShieldCheck size={16} /> {selected.user.globalRole === "SYSTEM_ADMIN" ? "Remove system administrator" : "Make system administrator"}</button></div>}<form className="form-stack staff-form" onSubmit={save}>{modal === "add" && <><label>Display name<input name="displayName" minLength={2} maxLength={100} required placeholder="Alex Staff Member" /></label><label>Email address<input name="email" type="email" required placeholder="alex@imsda.org" /></label></>}<label>Event role<select name="role" defaultValue={selected?.role ?? "READ_ONLY_STAFF"}>{eventRoles.map((role) => <option value={role} key={role}>{roleLabel(role)}</option>)}</select></label>{modal === "edit" && <label>Event access<select name="status" defaultValue={selected?.status ?? "ACTIVE"}><option value="ACTIVE">Can access this event</option><option value="INACTIVE">Remove access to this event</option></select></label>}{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button className="secondary-button" type="button" onClick={closeModal}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : modal === "add" ? "Add staff" : "Save access"}</button></div></form></section></div>}
  </section>;
}
