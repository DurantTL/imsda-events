import "server-only";

import {
  AccessDeniedError,
  requireAuthenticatedUser,
} from "@/modules/access/authorization";
import { getCurrentSession } from "@/modules/access/current-session";

export async function requireSystemAdministrator() {
  const user = requireAuthenticatedUser(await getCurrentSession());
  if (user.globalRole !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError(
      "System administrator access is required to manage churches and clubs.",
      403,
      "PERMISSION_DENIED",
    );
  }
  return user;
}
