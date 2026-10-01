import type { HealthTabView } from "@/modules/health-records/repository";

/**
 * Read-only display of an opened Health Record (#611), used by the Health tab
 * and the staff view. Rendered on the server for a viewer the server has
 * already checked; it prints values as text and nowhere else.
 */

type Values = HealthTabView["values"];

function str(values: Values, key: string) {
  const value = values[key];
  return typeof value === "string" && value !== "" ? value : "—";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function HealthStatusChip({ status }: { status: HealthTabView["status"] }) {
  if (status === "NONE") return <span className="status-chip">No record yet</span>;
  if (status === "NEEDS_UPDATE") return <span className="status-chip gold">Needs update</span>;
  return <span className="status-chip green">Current for this club year</span>;
}

export function HealthRecordView({ health }: { health: HealthTabView }) {
  const { values } = health;
  const contacts = Array.isArray(values.emergencyContacts) ? (values.emergencyContacts as Array<Record<string, unknown>>) : [];
  const signature = (values.signature ?? {}) as { typedName?: string; signedOn?: string };
  const address = [str(values, "addressLine1"), values.addressLine2 ? str(values, "addressLine2") : null, str(values, "city"), str(values, "state"), str(values, "zip")]
    .filter((part) => part && part !== "—")
    .join(", ");
  if (health.status === "NONE") return <p className="public-manage-empty">No health record has been entered for this person yet.</p>;
  return (
    <div className="page-stack health-record-view">
      <section className="public-manage-card">
        <h3>Participant</h3>
        <dl className="detail-list">
          <Row label="Address" value={address || "—"} />
          <Row label="Phone" value={str(values, "phone")} />
          <Row label="Email" value={str(values, "email")} />
        </dl>
      </section>
      <section className="public-manage-card">
        <h3>Health</h3>
        <dl className="detail-list">
          <Row label="Last tetanus booster" value={str(values, "lastTetanusBooster")} />
          <Row label="Allergies" value={values.hasAllergies === "YES" ? str(values, "allergyDetails") : "None reported"} />
          <Row label="Medications or other relevant health information" value={str(values, "medications")} />
          <Row label="Medical restrictions" value={str(values, "medicalRestrictions")} />
        </dl>
      </section>
      <section className="public-manage-card">
        <h3>Insurance</h3>
        <dl className="detail-list">
          <Row label="Covered by medical insurance" value={values.hasInsurance === "YES" ? "Yes" : "No"} />
          {values.hasInsurance === "YES" && (
            <>
              <Row label="Company" value={str(values, "insuranceCompany")} />
              <Row label="Group number" value={str(values, "insuranceGroupNumber")} />
              <Row label="Policy number" value={str(values, "insurancePolicyNumber")} />
              <Row label="Phone" value={str(values, "insurancePhone")} />
            </>
          )}
        </dl>
      </section>
      <section className="public-manage-card">
        <h3>Parent or guardian</h3>
        <dl className="detail-list">
          <Row label="Name" value={`${str(values, "guardianFirstName")} ${str(values, "guardianLastName")}`.replaceAll("—", "").trim() || "—"} />
          <Row label="Address" value={str(values, "guardianAddress")} />
          <Row label="Phone" value={str(values, "guardianPhone")} />
          <Row label="Email" value={str(values, "guardianEmail")} />
        </dl>
      </section>
      <section className="public-manage-card">
        <h3>Emergency contacts and authorized persons</h3>
        <ul>
          {contacts.map((contact, index) => (
            <li key={index}>
              {String(contact.firstName ?? "")} {String(contact.lastName ?? "")}, {String(contact.relationship ?? "")}, {String(contact.phone ?? "")}
            </li>
          ))}
        </ul>
      </section>
      <section className="public-manage-card">
        <h3>Consent</h3>
        <p>Signed by {signature.typedName ?? "—"} on {signature.signedOn ?? "—"}.</p>
      </section>
    </div>
  );
}
