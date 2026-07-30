"use client";

import Script from "next/script";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { CreditCard, LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  paymentChoiceOptionPresentations,
} from "@/modules/payments/payment-choice-presentation";

type SquareCheckout = {
  state:
    | "READY"
    | "CHOICE_REQUIRED"
    | "PAY_LATER"
    | "NOT_CONFIGURED"
    | "NOT_ELIGIBLE"
    | "NO_BALANCE"
    | "FORM_UNAVAILABLE";
  message: string;
  amountCents: number;
  currency: "USD";
  cardSelected: boolean;
  paymentChoice: {
    available: boolean;
    locked: boolean;
    selected: "CARD" | "PAY_LATER" | null;
    currentOperationId: string | null;
    baseSubtotalCents: number;
    cardProcessingFeeCents: number;
    cardTotalCents: number;
    payLaterTotalCents: number;
  } | null;
  square: {
    environment: "sandbox" | "production";
    applicationId: string;
    locationId: string;
    scriptUrl: string;
  } | null;
  billingContact: {
    givenName: string;
    familyName: string;
    email: string;
    phone: string;
  } | null;
};

type SquareTokenResult = {
  status: string;
  token?: string;
  errors?: Array<{ message?: string; detail?: string }>;
};

type SquarePaymentMethod = {
  destroy?(): Promise<void>;
};

type SquareCard = SquarePaymentMethod & {
  attach(selector: string): Promise<void>;
  tokenize(details: {
    amount: string;
    billingContact?: {
      givenName?: string;
      familyName?: string;
      email?: string;
      phone?: string;
    };
    currencyCode: "USD";
    intent: "CHARGE";
    customerInitiated: true;
    sellerKeyedIn: false;
  }): Promise<SquareTokenResult>;
};

type SquareWallet = SquarePaymentMethod & {
  tokenize(): Promise<SquareTokenResult>;
};

type SquareGooglePay = SquareWallet & {
  attach(selector: string): Promise<void>;
};

type SquarePaymentRequest = object;

type SquarePayments = {
  card(): Promise<SquareCard>;
  paymentRequest(input: {
    countryCode: "US";
    currencyCode: "USD";
    total: {
      amount: string;
      label: string;
    };
  }): SquarePaymentRequest;
  applePay(request: SquarePaymentRequest): Promise<SquareWallet>;
  googlePay(request: SquarePaymentRequest): Promise<SquareGooglePay>;
};

declare global {
  interface Window {
    Square?: {
      payments(
        applicationId: string,
        locationId: string,
      ): SquarePayments | Promise<SquarePayments>;
    };
  }
}

type PaymentMethodKind = "CARD" | "APPLE_PAY" | "GOOGLE_PAY";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function firstTokenizationError(
  errors: Array<{ message?: string; detail?: string }> | undefined,
  fallback = "Review the card details and try again.",
) {
  return errors?.find((error) => error.message || error.detail)?.message
    ?? errors?.find((error) => error.detail)?.detail
    ?? fallback;
}

function methodLabel(method: PaymentMethodKind) {
  if (method === "APPLE_PAY") return "Apple Pay";
  if (method === "GOOGLE_PAY") return "Google Pay";
  return "card";
}

function destroyPaymentMethod(method: SquarePaymentMethod | null) {
  if (method?.destroy) void method.destroy();
}

async function fetchCheckout(endpoint: string) {
  const response = await fetch(endpoint, {
    method: "GET",
    cache: "no-store",
  });
  const body = await response.json() as {
    checkout?: SquareCheckout;
    message?: string;
  };
  if (!response.ok || !body.checkout) {
    throw new Error(
      body.message ?? "Online payment details are unavailable.",
    );
  }
  return body.checkout;
}

function unavailableCheckout(error: unknown): SquareCheckout {
  return {
    state: "NOT_CONFIGURED",
    message: error instanceof Error
      ? error.message
      : "Online payment is unavailable. Your registration is still saved.",
    amountCents: 0,
    currency: "USD",
    cardSelected: false,
    paymentChoice: null,
    square: null,
    billingContact: null,
  };
}

export function PublicSquarePayment({
  token,
  manageEndpoint: explicitManageEndpoint,
}: {
  token?: string;
  manageEndpoint?: string;
}) {
  const manageEndpoint = explicitManageEndpoint
    ?? `/api/public/manage/${encodeURIComponent(token ?? "")}`;
  const paymentEndpoint = `${manageEndpoint}/payment`;
  const choiceEndpoint = `${manageEndpoint}/payment-choice`;
  const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const cardContainerId = `square-card-${instanceId}`;
  const googlePayContainerId = `square-google-pay-${instanceId}`;
  const cardRef = useRef<SquareCard | null>(null);
  const applePayRef = useRef<SquareWallet | null>(null);
  const googlePayRef = useRef<SquareGooglePay | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const sourceIdRef = useRef<string | null>(null);
  const sourceMethodRef = useRef<PaymentMethodKind | null>(null);
  const choiceRequestRef = useRef<{
    choice: "CARD" | "PAY_LATER";
    clientRequestId: string;
    expectedPriorOperationId: string | null;
  } | null>(null);
  const [checkout, setCheckout] = useState<SquareCheckout | null>(null);
  const [loading, setLoading] = useState(true);
  const [sdkReady, setSdkReady] = useState(false);
  const [cardReady, setCardReady] = useState(false);
  const [applePayReady, setApplePayReady] = useState(false);
  const [googlePayReady, setGooglePayReady] = useState(false);
  const [submittingMethod, setSubmittingMethod] = useState<
    PaymentMethodKind | null
  >(null);
  const [choiceSubmitting, setChoiceSubmitting] = useState<
    "CARD" | "PAY_LATER" | null
  >(null);
  const [pendingChoice, setPendingChoice] = useState<
    "CARD" | "PAY_LATER" | null
  >(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "pending";
    message: string;
  } | null>(null);

  const loadCheckout = useCallback(async () => {
    try {
      setCheckout(await fetchCheckout(paymentEndpoint));
    } catch (error) {
      setCheckout(unavailableCheckout(error));
    } finally {
      setLoading(false);
    }
  }, [paymentEndpoint]);

  useEffect(() => {
    let active = true;
    void fetchCheckout(paymentEndpoint).then(
      (nextCheckout) => {
        if (!active) return;
        setCheckout(nextCheckout);
        setLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setCheckout(unavailableCheckout(error));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [paymentEndpoint]);

  useEffect(() => {
    if (
      !sdkReady
      || checkout?.state !== "READY"
      || !checkout.square
      || !window.Square
      || cardRef.current
      || applePayRef.current
      || googlePayRef.current
    ) {
      return;
    }
    let active = true;
    void (async () => {
      let card: SquareCard | null = null;
      let applePay: SquareWallet | null = null;
      let googlePay: SquareGooglePay | null = null;
      try {
        const payments = await window.Square!.payments(
          checkout.square!.applicationId,
          checkout.square!.locationId,
        );
        const request = payments.paymentRequest({
          countryCode: "US",
          currencyCode: "USD",
          total: {
            amount: (checkout.amountCents / 100).toFixed(2),
            label: "IMSDA Events registration",
          },
        });

        const [cardResult, applePayResult, googlePayResult] =
          await Promise.allSettled([
            payments.card().then(async (nextCard) => {
              await nextCard.attach(`#${cardContainerId}`);
              return nextCard;
            }),
            payments.applePay(request),
            payments.googlePay(request).then(async (nextGooglePay) => {
              await nextGooglePay.attach(`#${googlePayContainerId}`);
              return nextGooglePay;
            }),
          ]);
        card = cardResult.status === "fulfilled" ? cardResult.value : null;
        applePay = applePayResult.status === "fulfilled"
          ? applePayResult.value
          : null;
        googlePay = googlePayResult.status === "fulfilled"
          ? googlePayResult.value
          : null;

        if (!active) {
          destroyPaymentMethod(card);
          destroyPaymentMethod(applePay);
          destroyPaymentMethod(googlePay);
          return;
        }
        cardRef.current = card;
        applePayRef.current = applePay;
        googlePayRef.current = googlePay;
        setCardReady(Boolean(card));
        setApplePayReady(Boolean(applePay));
        setGooglePayReady(Boolean(googlePay));
        if (!card && !applePay && !googlePay) {
          setNotice({
            tone: "error",
            message: "No secure Square payment method is available in this browser. Try another browser or contact the event team.",
          });
        } else if (!card) {
          setNotice({
            tone: "pending",
            message: "Card entry is unavailable in this browser, but an available wallet can still be used.",
          });
        }
      } catch {
        destroyPaymentMethod(card);
        destroyPaymentMethod(applePay);
        destroyPaymentMethod(googlePay);
        setNotice({
          tone: "error",
          message: "The secure Square payment options could not be loaded. Try again or contact the event team.",
        });
      }
    })();
    return () => {
      active = false;
      const card = cardRef.current;
      const applePay = applePayRef.current;
      const googlePay = googlePayRef.current;
      cardRef.current = null;
      applePayRef.current = null;
      googlePayRef.current = null;
      setCardReady(false);
      setApplePayReady(false);
      setGooglePayReady(false);
      destroyPaymentMethod(card);
      destroyPaymentMethod(applePay);
      destroyPaymentMethod(googlePay);
    };
  }, [cardContainerId, checkout, googlePayContainerId, sdkReady]);

  function clearPaymentAttempt() {
    idempotencyKeyRef.current = null;
    sourceIdRef.current = null;
    sourceMethodRef.current = null;
  }

  function beginPayment(
    method: PaymentMethodKind,
    tokenize: () => Promise<SquareTokenResult>,
  ) {
    if (!checkout || checkout.state !== "READY" || submittingMethod) return;
    if (
      sourceIdRef.current
      && sourceMethodRef.current
      && sourceMethodRef.current !== method
    ) {
      setNotice({
        tone: "pending",
        message: `First retry the ${methodLabel(sourceMethodRef.current)} payment so Square can confirm its result.`,
      });
      return;
    }

    // Apple requires tokenize() to be invoked directly from its click handler,
    // with no awaited work in between. Start every payment method synchronously
    // here, then hand the promise to the shared server-submission flow.
    let tokenization: Promise<SquareTokenResult> | null = null;
    try {
      if (!sourceIdRef.current) tokenization = tokenize();
    } catch {
      setNotice({
        tone: "error",
        message: `${methodLabel(method)} could not be opened. Try again or choose another payment method.`,
      });
      return;
    }
    setSubmittingMethod(method);
    setNotice(null);
    void completePayment(method, tokenization);
  }

  async function completePayment(
    method: PaymentMethodKind,
    tokenization: Promise<SquareTokenResult> | null,
  ) {
    try {
      let sourceId = sourceIdRef.current;
      if (!sourceId) {
        const tokenized = await tokenization!;
        if (tokenized.status !== "OK" || !tokenized.token) {
          clearPaymentAttempt();
          setNotice({
            tone: "error",
            message: firstTokenizationError(
              tokenized.errors,
              `${methodLabel(method)} was not authorized. Try again or choose another payment method.`,
            ),
          });
          return;
        }
        sourceId = tokenized.token;
        sourceIdRef.current = sourceId;
        sourceMethodRef.current = method;
      }

      idempotencyKeyRef.current ??= crypto.randomUUID();
      const response = await fetch(paymentEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId,
          idempotencyKey: idempotencyKeyRef.current,
        }),
      });
      const body = await response.json() as {
        payment?: { status: string; message: string };
        message?: string;
        retryable?: boolean;
      };
      if (!response.ok || !body.payment) {
        if (!body.retryable) clearPaymentAttempt();
        setNotice({
          tone: body.retryable ? "pending" : "error",
          message: body.message
            ?? "Square could not complete the payment. Try again.",
        });
        return;
      }

      if (body.payment.status === "SUCCEEDED") {
        clearPaymentAttempt();
      }
      setNotice({
        tone: body.payment.status === "SUCCEEDED" ? "success" : "pending",
        message: body.payment.message,
      });
      await loadCheckout();
    } catch {
      setNotice({
        tone: "pending",
        message: "The payment result was not confirmed. It is safe to use the button again; the same request will not be charged twice.",
      });
    } finally {
      setSubmittingMethod(null);
    }
  }

  function submitCardPayment() {
    if (!checkout || !cardRef.current) return;
    beginPayment("CARD", () => cardRef.current!.tokenize({
      amount: (checkout.amountCents / 100).toFixed(2),
      billingContact: checkout.billingContact ?? undefined,
      currencyCode: "USD",
      intent: "CHARGE",
      customerInitiated: true,
      sellerKeyedIn: false,
    }));
  }

  function submitApplePay() {
    if (!applePayRef.current) return;
    beginPayment("APPLE_PAY", () => applePayRef.current!.tokenize());
  }

  function submitGooglePay() {
    if (!googlePayRef.current) return;
    beginPayment("GOOGLE_PAY", () => googlePayRef.current!.tokenize());
  }

  async function savePaymentChoice(choice: "CARD" | "PAY_LATER") {
    if (
      !checkout?.paymentChoice
      || !checkout.paymentChoice.available
      || checkout.paymentChoice.locked
      || choiceSubmitting
    ) {
      return;
    }
    if (
      choiceRequestRef.current
      && choiceRequestRef.current.choice !== choice
    ) {
      setNotice({
        tone: "pending",
        message: `First retry the ${choiceRequestRef.current.choice === "CARD" ? "card" : "pay-later"} choice so we can confirm whether it was saved.`,
      });
      return;
    }

    const request = choiceRequestRef.current ?? {
      choice,
      clientRequestId: crypto.randomUUID(),
      expectedPriorOperationId:
        checkout.paymentChoice.currentOperationId,
    };
    choiceRequestRef.current = request;
    setPendingChoice(choice);
    setChoiceSubmitting(choice);
    setNotice(null);
    try {
      const response = await fetch(choiceEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = await response.json() as {
        paymentChoice?: {
          choice: "CARD" | "PAY_LATER";
          totalCents: number;
        };
        message?: string;
        retryable?: boolean;
      };
      if (!response.ok || !body.paymentChoice) {
        if (!body.retryable) {
          choiceRequestRef.current = null;
          setPendingChoice(null);
        }
        setNotice({
          tone: body.retryable ? "pending" : "error",
          message: body.message
            ?? "The payment choice could not be saved. Try again.",
        });
        if (
          response.status === 409
          || response.status === 422
        ) {
          await loadCheckout();
        }
        return;
      }

      choiceRequestRef.current = null;
      setPendingChoice(null);
      clearPaymentAttempt();
      setNotice({
        tone: "success",
        message: body.paymentChoice.choice === "CARD"
          ? `Card payment selected. Your secure amount is ${money(body.paymentChoice.totalCents)}.`
          : "Pay later selected. No card payment will be requested online.",
      });
      await loadCheckout();
    } catch {
      setNotice({
        tone: "pending",
        message: "We could not confirm the saved choice. Use the same choice button again; the request will be replayed without adding the card fee twice.",
      });
    } finally {
      setChoiceSubmitting(null);
    }
  }

  if (loading) {
    return (
      <div className="public-square-state is-loading" aria-live="polite">
        <LoaderCircle size={18} className="is-spinning" aria-hidden="true" />
        Checking online payment availability…
      </div>
    );
  }
  if (!checkout) return null;

  const paymentChoice = checkout.paymentChoice;
  const paymentChoiceOptions = paymentChoice
    ? paymentChoiceOptionPresentations(paymentChoice, money)
    : [];
  const cardChoice = paymentChoiceOptions.find(
    (option) => option.choice === "CARD",
  );
  const payLaterChoice = paymentChoiceOptions.find(
    (option) => option.choice === "PAY_LATER",
  );
  const noticeElement = notice && (
    <div
      className={`public-square-notice is-${notice.tone}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      {notice.tone === "success"
        ? <ShieldCheck size={18} aria-hidden="true" />
        : <TriangleAlert size={18} aria-hidden="true" />}
      <span>{notice.message}</span>
    </div>
  );
  const paymentChoicePanel = paymentChoice && (
    <section className="public-payment-choice" aria-labelledby="public-payment-choice-heading">
      <div className="public-payment-choice-heading">
        <span><CreditCard size={20} aria-hidden="true" /></span>
        <div>
          <strong id="public-payment-choice-heading">
            {paymentChoice.selected
              ? "Your payment choice"
              : "Choose how you want to pay"}
          </strong>
          <p>
            Your place is now available. Nothing is charged until you enter
            and submit payment details through Square.
          </p>
        </div>
      </div>
      <div className="public-payment-choice-options">
        <button
          type="button"
          className={cardChoice?.selected ? "is-selected" : ""}
          aria-pressed={cardChoice?.selected}
          disabled={
            !paymentChoice.available
            || paymentChoice.locked
            || Boolean(choiceSubmitting)
          }
          onClick={() => void savePaymentChoice("CARD")}
        >
          <span>
            <strong>
              {choiceSubmitting === "CARD"
                ? "Saving card choice…"
                : pendingChoice === "CARD"
                  ? "Retry card choice"
                  : cardChoice?.title}
            </strong>
            <small>{cardChoice?.detail}</small>
          </span>
          <b>{money(cardChoice?.totalCents ?? 0)}</b>
        </button>
        <button
          type="button"
          className={payLaterChoice?.selected ? "is-selected" : ""}
          aria-pressed={payLaterChoice?.selected}
          disabled={
            !paymentChoice.available
            || paymentChoice.locked
            || Boolean(choiceSubmitting)
          }
          onClick={() => void savePaymentChoice("PAY_LATER")}
        >
          <span>
            <strong>
              {choiceSubmitting === "PAY_LATER"
                ? "Saving pay-later choice…"
                : pendingChoice === "PAY_LATER"
                  ? "Retry pay-later choice"
                  : payLaterChoice?.title}
            </strong>
            <small>{payLaterChoice?.detail}</small>
          </span>
          <b>{money(payLaterChoice?.totalCents ?? 0)}</b>
        </button>
      </div>
      {paymentChoice.locked && (
        <p className="public-payment-choice-locked">
          This choice is locked because a payment has started or been
          recorded. Contact the event team if it needs to change.
        </p>
      )}
      {!paymentChoice.available && !paymentChoice.locked && (
        <p className="public-payment-choice-locked">
          The event team needs to review this payment total before it can be
          changed.
        </p>
      )}
      {noticeElement}
    </section>
  );

  if (checkout.state !== "READY" || !checkout.square) {
    return (
      <div className="public-payment-stack">
        {paymentChoicePanel}
        <div className={`public-square-state is-${checkout.state.toLowerCase().replaceAll("_", "-")}`}>
          {checkout.state === "NO_BALANCE" ? (
            <ShieldCheck size={19} aria-hidden="true" />
          ) : (
            <CreditCard size={19} aria-hidden="true" />
          )}
          <div>
            <strong>
              {checkout.state === "CHOICE_REQUIRED"
                ? "Choose one option above"
                : checkout.state === "PAY_LATER"
                  ? "Pay later is selected"
                  : checkout.state === "NOT_CONFIGURED"
                    ? "Online payment is not available yet"
                    : checkout.state === "NO_BALANCE"
                      ? "No online payment is due"
                      : "Online payment is unavailable"}
            </strong>
            <p>{checkout.message}</p>
          </div>
        </div>
        {!paymentChoice && noticeElement}
      </div>
    );
  }

  return (
    <div className="public-payment-stack">
      {paymentChoicePanel}
      <div className="public-square-checkout">
      <Script
        id={`square-web-payments-${checkout.square.environment}`}
        src={checkout.square.scriptUrl}
        strategy="afterInteractive"
        onReady={() => setSdkReady(true)}
        onError={() => setNotice({
          tone: "error",
          message: "The secure Square payment service could not be loaded.",
        })}
      />
      <div className="public-square-heading">
        <span><CreditCard size={20} aria-hidden="true" /></span>
        <div>
          <strong>Pay {money(checkout.amountCents)} securely with Square</strong>
          <p>
            Use an available digital wallet or enter a card. Payment details go
            directly to Square and are never stored by IMSDA Events.
          </p>
        </div>
      </div>
      {checkout.square.environment === "sandbox" && (
        <p className="public-square-sandbox">
          Sandbox mode · no real charge will be made
        </p>
      )}
      <div className="public-square-wallets" aria-label="Digital wallet payment methods">
        <button
          type="button"
          aria-label={`Pay ${money(checkout.amountCents)} with Apple Pay`}
          className={`public-square-apple-pay${applePayReady ? "" : " is-unavailable"}`}
          disabled={!applePayReady || Boolean(submittingMethod)}
          onClick={submitApplePay}
        />
        <div
          id={googlePayContainerId}
          className={`public-square-google-pay${googlePayReady ? "" : " is-unavailable"}`}
          onClick={submitGooglePay}
        />
      </div>
      {(applePayReady || googlePayReady) && (
        <div className="public-square-divider"><span>or enter a card</span></div>
      )}
      <div id={cardContainerId} className="public-square-card-frame" />
      <button
        type="button"
        className="public-square-pay-button"
        disabled={!cardReady || Boolean(submittingMethod)}
        onClick={submitCardPayment}
      >
        {submittingMethod === "CARD" ? (
          <><LoaderCircle size={17} className="is-spinning" /> Confirming with Square…</>
        ) : (
          <><ShieldCheck size={17} /> Pay {money(checkout.amountCents)}</>
        )}
      </button>
      {!paymentChoice && noticeElement}
      </div>
    </div>
  );
}
