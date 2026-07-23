import { createHash, randomBytes } from "node:crypto";

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function hashUserAgent(userAgent: string | null) {
  return userAgent ? createHash("sha256").update(userAgent).digest("hex") : null;
}
