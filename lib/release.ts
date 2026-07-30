import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

function cleanReleaseSha(value: string | undefined) {
  const candidate = value?.trim().split(/\s+/, 1)[0];
  return candidate && /^[a-f0-9]{7,64}$/i.test(candidate) ? candidate : null;
}

function nextBuildId() {
  try {
    const value = readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function getReleaseIdentity(environment = process.env) {
  return {
    sha: cleanReleaseSha(
      environment.APP_RELEASE_SHA ?? environment.XCLOUD_DEPLOYED_COMMIT,
    ),
    buildId: nextBuildId(),
  };
}
