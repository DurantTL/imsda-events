import "server-only";

import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import {
  buildOperationalReport,
  type OperationalReport,
} from "@/modules/reporting/operational-reports";
import { listRegistrations } from "@/modules/registrations/repository";

export async function getOperationalReport(eventId: string): Promise<OperationalReport> {
  const registrations = await listRegistrations(eventId, {
    statuses: activeRegistrationStatuses,
  });
  return buildOperationalReport(registrations);
}
