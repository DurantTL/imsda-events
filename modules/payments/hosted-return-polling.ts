import type { HostedReturnStatus } from "@/modules/payments/hosted-return-presentation";

/**
 * Polls the Pay on Square return status (#327) from the browser, shared by the return page and the
 * private page's banner. It stops on a settled state or after a bounded number of tries, and it
 * treats being rate limited (429) or a failed request as "keep polling, slower": the delay doubles
 * up to a minute, and goes back to normal after any answer. Returns a function that stops it.
 */
export const hostedReturnPollIntervalMs = 5_000;
export const hostedReturnPollLimit = 24;
const maximumBackoffMs = 60_000;

export function nextHostedReturnDelay(
  current: number,
  outcome: "ANSWERED" | "THROTTLED_OR_FAILED",
) {
  return outcome === "ANSWERED"
    ? hostedReturnPollIntervalMs
    : Math.min(current * 2, maximumBackoffMs);
}

export function startHostedReturnPolling(
  returnId: string,
  onStatus: (status: HostedReturnStatus) => void | Promise<void>,
  options: { immediate?: boolean; fetcher?: typeof fetch } = {},
) {
  const doFetch = options.fetcher ?? fetch;
  let active = true;
  let polls = 0;
  let delay = hostedReturnPollIntervalMs;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    let status: HostedReturnStatus | null = null;
    try {
      const response = await doFetch(`/api/public/square-return/${encodeURIComponent(returnId)}`, {
        cache: "no-store",
      });
      if (response.ok) status = await response.json() as HostedReturnStatus;
    } catch {
      status = null;
    }
    if (!active) return;
    delay = nextHostedReturnDelay(delay, status ? "ANSWERED" : "THROTTLED_OR_FAILED");
    if (status) {
      await onStatus(status);
      if (status.state !== "CONFIRMING") return;
    }
    polls += 1;
    if (!active || polls >= hostedReturnPollLimit) return;
    timer = setTimeout(() => void tick(), delay);
  };

  if (options.immediate) void tick();
  else timer = setTimeout(() => void tick(), delay);
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
  };
}
