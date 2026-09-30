import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { PrintReportButton } from "@/components/print-report-button";
import styles from "@/components/club-orders.module.css";
import { ORDER_LIST_SECTIONS, activeHelperLines, orderListSectionLabels } from "@/modules/club-orders/domain";
import { listHelperLines, loadOrderExportHeader } from "@/modules/club-orders/repository";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";

export const metadata: Metadata = { title: "Printable order list" };
export const dynamic = "force-dynamic";

/**
 * The order helper list, laid out to print (#654): club, church, director
 * contact and date, then every line grouped by section with item name, size,
 * item number and quantity. Same gate as Orders; reads what's saved.
 */
export default async function ClubOrderListPrintPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const [header, allLines] = await Promise.all([loadOrderExportHeader(organizationId), listHelperLines(organizationId)]);
  const lines = activeHelperLines(allLines);
  return (
    <>
      <div className={styles.noPrint}>
        <BackLink href={`/account/clubs/${organizationId}/orders`}>Back to Orders</BackLink>
        <PrintReportButton label="Print this list" />
      </div>
      <section className="panel">
        <h2>Order list</h2>
        <p className="field-help">A helper list, not an official order form. Order the items from AdventSource.</p>
        <dl className={styles.printHeader}>
          <div><dt>Club</dt><dd translate="no">{header.clubName}</dd></div>
          <div><dt>Church</dt><dd translate="no">{header.church || "—"}</dd></div>
          <div><dt>Director</dt><dd translate="no">{header.directorName || "—"}</dd></div>
          <div><dt>Director email</dt><dd translate="no">{header.directorEmail || "—"}</dd></div>
          <div><dt>Director phone</dt><dd translate="no">{header.directorPhone || "—"}</dd></div>
          <div><dt>Date</dt><dd>{header.date}</dd></div>
        </dl>
        {lines.length === 0 && <p className="quiet-copy">Nothing on the list.</p>}
        {ORDER_LIST_SECTIONS.map((section) => {
          const rows = lines.filter((line) => line.section === section);
          if (rows.length === 0) return null;
          return (
            <section className={styles.printSection} key={section}>
              <h3>{orderListSectionLabels[section]}</h3>
              <table className={styles.printTable}>
                <thead>
                  <tr><th>Item name</th><th>Size</th><th>Item number</th><th>Quantity</th><th>On hand</th><th>To order</th></tr>
                </thead>
                <tbody>
                  {rows.map((line) => (
                    <tr key={line.itemId}>
                      <td translate="no">{line.name}</td>
                      <td>{line.size}</td>
                      <td>{line.catalogNumber ?? ""}</td>
                      <td>{line.needed}</td>
                      <td>{line.onHand}</td>
                      <td>{line.toOrder}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
      </section>
    </>
  );
}
