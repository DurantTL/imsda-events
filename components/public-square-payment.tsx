"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
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

type SquareCard = {
  attach(selector: string): Promise<void>;
  destroy(): Promise<void>;
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
  }): Promise<{
    status: string;
    token?: string;
    errors?: Array<{ message?: string; detail?: string }>;
  }>;
};

type SquarePayments = {
  card(): Promise<SquareCard>;
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

const cardContainerId = "square-card-container";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function firstTokenizationError(
  errors: Array<{ message?: string; detail?: string }> | undefined,
) {
  return errors?.find((error) => error.message || error.detail)?.message
    ?? errors?.find((error) => error.detail)?.detail
    ?? "Review the card details and try again.";
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
      : "Online card payment is unavailable. Your registration is still saved.",
    amountCents: 0,
    currency: "USD",
    cardSelected: false,
    paymentChoice: null,
    square: null,
    billingContact: null,
  };
}

export function PublicSquarePayment({ token }: { token: string }) {
  const manageEndpoint = `/api/public/manage/${encodeURIComponent(token)}`;
  const paymentEndpoint = `${manageEndpoint}/payment`;
  const choiceEndpoint = `${manageEndpoint}/payment-choice`;
  const cardRef = useRef<SquareCard | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const sourceIdRef = useRef<string | null>(null);
  const choiceRequestRef = useRef<{
    choice: "CARD" | "PAY_LATER";
    clientRequestId: string;
    expectedPriorOperationId: string | null;
  } | null>(null);
  const [checkout, setCheckout] = useState<SquareCheckout | null>(null);
  const [loading, setLoading] = useState(true);
  const [sdkReady, setSdkReady] = useState(false);
  const [cardReady, setCardReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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
    ) {
      return;
    }
    let active = true;
    void (async () => {
      try {
        const payments = await window.Square!.payments(
          checkout.square!.applicationId,
          checkout.square!.locationId,
        );
        const card = await payments.card();
        await card.attach(`#${cardContainerId}`);
        if (!active) {
          await card.destroy();
          return;
        }
        cardRef.current = card;
        setCardReady(true);
      } catch {
        setNotice({
          tone: "error",
          message: "The secure Square card form could not be loaded. Try again or contact the event team.",
        });
      }
    })();
    return () => {
      active = false;
      const card = cardRef.current;
      cardRef.current = null;
      setCardReady(false);
      if (card) void card.destroy();
    };
  }, [checkout, sdkReady]);

  async function submitPayment() {
    if (!checkout || checkout.state !== "READY" || !cardRef.current) return;
    setSubmitting(true);
    setNotice(null);
    try {
      let sourceId = sourceIdRef.current;
      if (!sourceId) {
        const tokenized = await cardRef.current.tokenize({
          amount: (checkout.amountCents / 100).toFixed(2),
          billingContact: checkout.billingContact ?? undefined,
          currencyCode: "USD",
          intent: "CHARGE",
          customerInitiated: true,
          sellerKeyedIn: false,
        });
        if (tokenized.status !== "OK" || !tokenized.token) {
          idempotencyKeyRef.current = null;
          sourceIdRef.current = null;
          setNotice({
            tone: "error",
            message: firstTokenizationError(tokenized.errors),
          });
          return;
        }
        sourceId = tokenized.token;
        sourceIdRef.current = sourceId;
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
        if (!body.retryable) {
          idempotencyKeyRef.current = null;
          sourceIdRef.current = null;
        }
        setNotice({
          tone: body.retryable ? "pending" : "error",
          message: body.message
            ?? "Square could not complete the payment. Try again.",
        });
        return;
      }

      if (body.payment.status === "SUCCEEDED") {
        idempotencyKeyRef.current = null;
        sourceIdRef.current = null;
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
      setSubmitting(false);
    }
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
      idempotencyKeyRef.current = null;
      sourceIdRef.current = null;
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
            and submit card details through Square.
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
                    ? "Online card payment is not available yet"
                    : checkout.state === "NO_BALANCE"
                      ? "No online payment is due"
                      : "Card payment is unavailable"}
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
          <strong>Pay {money(checkout.amountCents)} securely by card</strong>
          <p>
            Card details are entered directly into Square and are never stored
            by IMSDA Events.
          </p>
        </div>
      </div>
      {checkout.square.environment === "sandbox" && (
        <p className="public-square-sandbox">
          Sandbox mode · test cards only · no real charge will be made
        </p>
      )}
      <div id={cardContainerId} className="public-square-card-frame" />
      <button
        type="button"
        className="public-square-pay-button"
        disabled={!cardReady || submitting}
        onClick={() => void submitPayment()}
      >
        {submitting ? (
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
