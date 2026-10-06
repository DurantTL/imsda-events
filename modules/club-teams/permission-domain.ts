import { z } from "zod";

/** The Area Coordinator's permission flag on a team member of 18 or older (#809). Pure wording, shared by every screen and the form. */

export type PermissionStatus = "PENDING" | "GRANTED" | "DECLINED";
export type PermissionDecision = "GRANTED" | "DECLINED";

/** What the director is told when a team is saved with someone 18 or older as a team member. */
export const permissionPendingNotice = (name: string) =>
  `${name || "Someone"} is 18 or older. Team members 18 and over need permission from the Area Coordinator. Your team is registered, and the Area Coordinator has been asked to review it.`;

export const permissionGrantedNotice = (name: string) => `${name || "Someone"}: Permission granted by the Area Coordinator.`;

export const permissionDeclinedNotice = (name: string) =>
  `${name || "Someone"}: The Area Coordinator declined permission. Change them to a coach or remove them from the team, then save it again. Nobody has been removed for you.`;

export const permissionDeclinedProblem = (name: string) =>
  `The Area Coordinator declined permission for ${name || "someone"} to be a team member. Change them to a coach or remove them from the team.`;

export function permissionNotice(status: PermissionStatus, name: string) {
  return status === "GRANTED" ? permissionGrantedNotice(name) : status === "DECLINED" ? permissionDeclinedNotice(name) : permissionPendingNotice(name);
}

/** The short wording on the printed form and in reports. */
export const permissionShortLabel = (status: PermissionStatus) =>
  status === "GRANTED" ? "AC permission: granted" : status === "DECLINED" ? "AC permission: declined" : "AC permission: pending";

export const permissionDecisionSchema = z.strictObject({ decision: z.enum(["GRANTED", "DECLINED"]) });
