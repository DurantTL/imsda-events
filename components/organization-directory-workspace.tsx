"use client";

import { useMemo, useState } from "react";
import {
  BadgeCheck,
  Building2,
  Church,
  Link2,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import {
  externalSystemLabels,
  organizationTypeLabels,
} from "@/modules/organizations/domain";
import type { OrganizationRecord } from "@/modules/organizations/repository";
import styles from "./organization-directory-workspace.module.css";

type OrganizationEditor =
  | { kind: "create" }
  | { kind: "edit"; organization: OrganizationRecord }
  | {
      kind: "identity";
      organization: OrganizationRecord;
      identity?: OrganizationRecord["externalIdentities"][number];
    }
  | null;

type OrganizationResponse = {
  organizations?: OrganizationRecord[];
  message?: string;
  issues?: Array<{ message?: string }>;
};

function identityLabel(
  identity: OrganizationRecord["externalIdentities"][number],
) {
  const scope = identity.providerScope ? ` · ${identity.providerScope}` : "";
  return `${externalSystemLabels[identity.provider]}${scope}`;
}

export function OrganizationDirectoryWorkspace({
  initialOrganizations,
}: {
  initialOrganizations: OrganizationRecord[];
}) {
  const [organizations, setOrganizations] = useState(initialOrganizations);
  const [editor, setEditor] = useState<OrganizationEditor>(null);
  const [createType, setCreateType] = useState<"CHURCH" | "CLUB">("CHURCH");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialogRef = useAccessibleDialog<HTMLElement>(Boolean(editor), closeEditor);

  const activeChurches = useMemo(
    () => organizations.filter(
      (organization) => organization.type === "CHURCH" && organization.isActive,
    ),
    [organizations],
  );
  const summary = useMemo(() => ({
    churches: organizations.filter(
      (organization) => organization.type === "CHURCH" && organization.isActive,
    ).length,
    clubs: organizations.filter(
      (organization) => organization.type === "CLUB" && organization.isActive,
    ).length,
    identities: organizations.reduce(
      (total, organization) => total + organization.externalIdentities.length,
      0,
    ),
    unlinked: organizations.filter(
      (organization) => organization.isActive
        && organization.externalIdentities.length === 0,
    ).length,
  }), [organizations]);

  function closeEditor() {
    if (saving) return;
    setEditor(null);
    setError("");
  }

  function beginCreate() {
    setCreateType("CHURCH");
    setError("");
    setNotice("");
    setEditor({ kind: "create" });
  }

  function beginEdit(organization: OrganizationRecord) {
    setError("");
    setNotice("");
    setEditor({ kind: "edit", organization });
  }

  function beginIdentity(
    organization: OrganizationRecord,
    identity?: OrganizationRecord["externalIdentities"][number],
  ) {
    setError("");
    setNotice("");
    setEditor({ kind: "identity", organization, identity });
  }

  async function readResponse(response: Response) {
    const result = await response.json().catch(() => ({})) as OrganizationResponse;
    if (!response.ok || !result.organizations) {
      throw new Error(
        result.message
          ?? result.issues?.[0]?.message
          ?? "The organization directory could not be updated.",
      );
    }
    setOrganizations(result.organizations);
  }

  async function saveOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || editor.kind === "identity") return;
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const editing = editor.kind === "edit" ? editor.organization : null;
    const type = editing?.type ?? createType;
    const payload = {
      ...(editing ? {} : { type }),
      name: String(form.get("name") ?? ""),
      parentOrganizationId: type === "CLUB"
        ? String(form.get("parentOrganizationId") ?? "") || null
        : null,
      isActive: form.get("isActive") === "on",
      ...(editing ? { expectedUpdatedAt: editing.updatedAt } : {}),
    };
    try {
      const response = await fetch(
        editing
          ? `/api/admin/organizations/${encodeURIComponent(editing.id)}`
          : "/api/admin/organizations",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      await readResponse(response);
      setEditor(null);
      setNotice(editing
        ? `${payload.name.trim()} was updated.`
        : `${payload.name.trim()} was added to the shared directory.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The organization could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveIdentity(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || editor.kind !== "identity") return;
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const existing = editor.identity ?? null;
    const payload = {
      provider: String(form.get("provider") ?? ""),
      providerScope: String(form.get("providerScope") ?? ""),
      externalId: String(form.get("externalId") ?? ""),
      displayLabel: String(form.get("displayLabel") ?? "") || null,
      ...(existing ? { expectedUpdatedAt: existing.updatedAt } : {}),
    };
    try {
      const response = await fetch(
        existing
          ? `/api/admin/organizations/${encodeURIComponent(editor.organization.id)}/external-identities/${encodeURIComponent(existing.id)}`
          : `/api/admin/organizations/${encodeURIComponent(editor.organization.id)}/external-identities`,
        {
          method: existing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      await readResponse(response);
      setEditor(null);
      setNotice(
        existing
          ? `${externalSystemLabels[payload.provider as keyof typeof externalSystemLabels]} was corrected for ${editor.organization.name}.`
          : `${editor.organization.name} now has a stable ${externalSystemLabels[payload.provider as keyof typeof externalSystemLabels]} identifier.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The provider identifier could not be linked.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Shared IMSDA foundation</p>
          <h2>Churches and clubs</h2>
          <p>
            Maintain one organization directory for events, club rosters,
            treasury billing, and provider reconciliation. External identifiers
            are stored separately from names so later syncs do not guess.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={beginCreate}>
          <Plus aria-hidden="true" size={17} /> Add church or club
        </button>
      </div>

      <section className="finance-summary" aria-label="Organization summary">
        <article className="finance-stat">
          <span><Church aria-hidden="true" size={18} /></span>
          <small>Active churches</small>
          <strong>{summary.churches}</strong>
        </article>
        <article className="finance-stat">
          <span><UsersRound aria-hidden="true" size={18} /></span>
          <small>Active clubs</small>
          <strong>{summary.clubs}</strong>
        </article>
        <article className="finance-stat muted">
          <span><Link2 aria-hidden="true" size={18} /></span>
          <small>Provider identifiers</small>
          <strong>{summary.identities}</strong>
        </article>
        <article className={`finance-stat ${summary.unlinked > 0 ? "warning" : ""}`}>
          <span><ShieldCheck aria-hidden="true" size={18} /></span>
          <small>Active records without IDs</small>
          <strong>{summary.unlinked}</strong>
        </article>
      </section>

      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && !editor && <div className="inline-notice error" role="alert">{error}</div>}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Permanent directory</p>
            <h2>IMSDA organizations</h2>
          </div>
          <span className="count-badge">{organizations.length} records</span>
        </div>

        {organizations.length === 0 ? (
          <div className="empty-state">
            <Building2 aria-hidden="true" size={27} />
            <h3>No churches or clubs yet</h3>
            <p>Add the first church, then place its clubs beneath it.</p>
            <button className="primary-button" type="button" onClick={beginCreate}>
              Add first organization
            </button>
          </div>
        ) : (
          <div className={styles.directory}>
            {organizations.map((organization) => (
              <article
                className={`${styles.organizationCard} ${!organization.isActive ? styles.inactive : ""}`}
                key={organization.id}
              >
                <div className={styles.organizationHeading}>
                  <span className={styles.organizationIcon}>
                    {organization.type === "CHURCH"
                      ? <Church aria-hidden="true" size={18} />
                      : <UsersRound aria-hidden="true" size={18} />}
                  </span>
                  <span>
                    <strong>{organization.name}</strong>
                    <small>
                      {organizationTypeLabels[organization.type]}
                      {organization.parentOrganization
                        ? ` · ${organization.parentOrganization.name}`
                        : ""}
                    </small>
                  </span>
                  <em className={organization.isActive ? styles.active : styles.inactiveStatus}>
                    {organization.isActive ? "Active" : "Inactive"}
                  </em>
                </div>

                <div className={styles.identities}>
                  {organization.externalIdentities.map((identity) => (
                    <button
                      aria-label={`Edit ${identityLabel(identity)} identifier for ${organization.name}`}
                      key={identity.id}
                      onClick={() => beginIdentity(organization, identity)}
                      title={`Edit ${identity.externalId}`}
                      type="button"
                    >
                      <BadgeCheck aria-hidden="true" size={13} />
                      <span>
                        <strong>{identityLabel(identity)}</strong>
                        <small>{identity.displayLabel ?? identity.externalId}</small>
                      </span>
                      <Pencil aria-hidden="true" size={12} />
                    </button>
                  ))}
                  {organization.externalIdentities.length === 0 && (
                    <p>No provider identifier linked yet.</p>
                  )}
                </div>

                <div className={styles.actions}>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => beginIdentity(organization)}
                  >
                    <Link2 aria-hidden="true" size={14} /> Link provider
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => beginEdit(organization)}
                  >
                    <Pencil aria-hidden="true" size={14} /> Edit
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {editor && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}>
          <section
            aria-labelledby="organization-editor-title"
            aria-modal="true"
            className="modal-card"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">
                  {editor.kind === "identity" ? "Provider identity" : "Shared organization"}
                </p>
                <h2 id="organization-editor-title">
                  {editor.kind === "create"
                    ? "Add church or club"
                    : editor.kind === "edit"
                      ? `Edit ${editor.organization.name}`
                      : editor.identity
                        ? `Correct ${externalSystemLabels[editor.identity.provider]}`
                        : `Link ${editor.organization.name}`}
                </h2>
              </div>
              <button
                aria-label="Close"
                className="icon-button"
                disabled={saving}
                onClick={closeEditor}
                type="button"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </div>

            {editor.kind === "identity" ? (
              <form className="form-stack" onSubmit={saveIdentity}>
                <label>
                  Provider
                  <select
                    name="provider"
                    defaultValue={editor.identity?.provider ?? "EADVENTIST"}
                  >
                    {Object.entries(externalSystemLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <div className="form-grid two-column">
                  <label>
                    Provider scope
                    <input
                      name="providerScope"
                      maxLength={120}
                      placeholder="Optional account or conference"
                      defaultValue={editor.identity?.providerScope ?? ""}
                    />
                  </label>
                  <label>
                    Provider identifier
                    <input
                      defaultValue={editor.identity?.externalId ?? ""}
                      name="externalId"
                      required
                      maxLength={240}
                    />
                  </label>
                </div>
                <label>
                  Display label
                  <input
                    name="displayLabel"
                    maxLength={160}
                    placeholder="Optional readable provider name"
                    defaultValue={editor.identity?.displayLabel ?? ""}
                  />
                </label>
                <p className={styles.formHelp}>
                  Provider identifiers are durable reconciliation keys. Names
                  and email addresses are never used as automatic sync keys.
                </p>
                {error && <p className="form-error" role="alert">{error}</p>}
                <div className="form-actions">
                  <button className="secondary-button" disabled={saving} onClick={closeEditor} type="button">
                    Cancel
                  </button>
                  <button className="primary-button" disabled={saving} type="submit">
                    <Link2 aria-hidden="true" size={15} />
                    {saving
                      ? "Saving…"
                      : editor.identity
                        ? "Save correction"
                        : "Link identifier"}
                  </button>
                </div>
              </form>
            ) : (
              <form className="form-stack" onSubmit={saveOrganization}>
                {editor.kind === "create" && (
                  <label>
                    Organization type
                    <select
                      name="type"
                      value={createType}
                      onChange={(event) => setCreateType(
                        event.target.value as "CHURCH" | "CLUB",
                      )}
                    >
                      <option value="CHURCH">Church</option>
                      <option value="CLUB">Club</option>
                    </select>
                  </label>
                )}
                <label>
                  Name
                  <input
                    defaultValue={editor.kind === "edit" ? editor.organization.name : ""}
                    name="name"
                    required
                    maxLength={160}
                  />
                </label>
                {(editor.kind === "edit"
                  ? editor.organization.type === "CLUB"
                  : createType === "CLUB") && (
                  <label>
                    Sponsoring church
                    <select
                      defaultValue={editor.kind === "edit"
                        ? editor.organization.parentOrganizationId ?? ""
                        : ""}
                      name="parentOrganizationId"
                    >
                      <option value="">Not assigned yet</option>
                      {activeChurches.map((church) => (
                        <option key={church.id} value={church.id}>{church.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className={styles.checkbox}>
                  <input
                    defaultChecked={editor.kind === "edit"
                      ? editor.organization.isActive
                      : true}
                    name="isActive"
                    type="checkbox"
                  />
                  Active in the shared directory
                </label>
                {error && <p className="form-error" role="alert">{error}</p>}
                <div className="form-actions">
                  <button className="secondary-button" disabled={saving} onClick={closeEditor} type="button">
                    Cancel
                  </button>
                  <button className="primary-button" disabled={saving} type="submit">
                    <Save aria-hidden="true" size={15} />
                    {saving ? "Saving…" : "Save organization"}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
