/**
 * What the Pay on Square return page and its status poll may say (#327). Pure and free of server
 * imports, so the browser components and the server share one set of words.
 *
 * Square sends the payer back to `/pay/square/return/<returnId>`. That id opens a status view and
 * nothing else: a state and a masked confirmation code, never a name, amount, balance, link into
 * the registration, or any other registration data.
 */
export type HostedReturnState = "CONFIRMING" | "CONFIRMED" | "HELD";

export type HostedReturnStatus = {
  state: HostedReturnState;
  maskedConfirmationCode: string;
};

/** Where the browser remembers, per return id, the page the payer started from. */
export const hostedReturnStorageKey = (returnId: string) => `imsda-square-return:${returnId}`;

export function isHostedReturnId(value: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function maskConfirmationCode(code: string) {
  return `••••${code.length > 4 ? code.slice(-4) : ""}`;
}

export function hostedReturnMessage(state: HostedReturnState) {
  if (state === "CONFIRMED") return "Square has confirmed your payment. Thank you.";
  if (state === "HELD") {
    return "Square took your payment, but it could not be counted toward this registration (for example, the balance had already been paid). The event team has been alerted and will review it and refund anything that is not owed.";
  }
  return "Welcome back from Square. We count a payment only after Square confirms it to us, which usually takes under a minute. This page checks automatically; there is no need to pay again.";
}
