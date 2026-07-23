import type { MessageOutboxRecord } from "@/modules/communications/types";

export function messageRetryRequestPayload(
  message: Pick<MessageOutboxRecord, "retryRequestFingerprint">,
  clientRequestId: string,
) {
  return {
    clientRequestId,
    requestFingerprint: message.retryRequestFingerprint,
  };
}
