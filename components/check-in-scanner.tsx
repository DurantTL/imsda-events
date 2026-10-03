"use client";

import {
  AlertTriangle,
  Camera,
  CameraOff,
  CheckCircle2,
  Keyboard,
  LoaderCircle,
  QrCode,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { CheckInPaymentDue } from "@/components/check-in-payment-due";
import { BackgroundCheckBadge } from "@/components/background-check-flags";
import {
  ClubCheckInPanel,
  type ClubCheckInProgress,
} from "@/components/club-check-in-panel";
import {
  chooseQrDecoder,
  classifyCameraError,
  createScanLoop,
  decodeQrFromPixels,
  downscaledSize,
  type BarcodeDetectorConstructorLike,
  type JsQrFunction,
  type ScanLoop,
} from "@/components/check-in-qr-decoding";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { CheckInActionResult } from "@/components/use-offline-check-in-queue";
import type { ClubCheckInInfo } from "@/modules/club-registrations/repository";
import {
  checkInSequentially,
  sequentialCheckInSummary,
} from "@/modules/checkin/bulk-check-in";

type ResolvedAttendee = {
  id: string;
  firstName: string;
  lastName: string;
  attendeeType: string;
  checkedIn: boolean;
  checkedInAt: string | null;
};

type PassResolution = {
  source: "QR_PASS" | "CONFIRMATION_CODE";
  confirmationCode: string;
  attendees: ResolvedAttendee[];
  /** Q1 (#412): set when a club member's own QR pass was scanned. */
  scannedAttendeeId?: string;
};

type CameraState =
  | "idle"
  | "starting"
  | "active"
  | "unsupported"
  | "denied"
  | "no-camera"
  | "decoder-failed"
  | "error";

/**
 * Q1 (#412): a club's own QR ("imsda-club-pass.v1…") is a distinct token
 * type from an attendee's ("imsda-pass.v1…"), but the scanner reads either
 * the same way — it just forwards whatever it found to the resolve route,
 * which tells the two apart.
 */
function isRecognizedPassToken(value: string) {
  return value.startsWith("imsda-pass.v1.") || value.startsWith("imsda-club-pass.v1.");
}

export function extractAttendeePassToken(value: string) {
  const candidate = value.trim();
  if (isRecognizedPassToken(candidate)) return candidate;
  try {
    const parsed = new URL(candidate);
    const pass = parsed.searchParams.get("pass")?.trim() ?? "";
    return isRecognizedPassToken(pass) ? pass : null;
  } catch {
    return null;
  }
}

function attendeeTypeLabel(value: string) {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function cameraMessage(state: CameraState) {
  if (state === "unsupported") {
    return "This browser cannot scan QR codes here. Enter the registration confirmation code below.";
  }
  if (state === "denied") {
    return "Camera access was denied. You can allow it in browser settings or use the confirmation code below.";
  }
  if (state === "no-camera") {
    return "No camera was found on this device. Use the confirmation code below.";
  }
  if (state === "decoder-failed") {
    return "The QR scanning component could not load. Check the connection and try again, or use the confirmation code below.";
  }
  if (state === "error") {
    return "The camera could not start. Close other camera apps or use the confirmation code below.";
  }
  return "";
}

export function CheckInScanner({
  eventId,
  onConfirmCheckIn,
  queuedAttendeeIds,
  conflictAttendeeIds,
  paymentDueByConfirmationCode = {},
  backgroundFlaggedAttendeeIds = [],
  clubsByConfirmationCode = {},
  savedQueueUnreadable = false,
}: {
  eventId: string;
  onConfirmCheckIn: (
    attendee: ResolvedAttendee,
  ) => Promise<CheckInActionResult>;
  queuedAttendeeIds: string[];
  conflictAttendeeIds: string[];
  paymentDueByConfirmationCode?: Record<string, { balanceCents: number; partySize: number }>;
  /** Adults at a youth or children's event without a current check (#388). Shown, never blocking. */
  backgroundFlaggedAttendeeIds?: string[];
  /** Q1 (#412): scanning a club's code opens the same club view a name search finds. */
  clubsByConfirmationCode?: Record<string, ClubCheckInInfo>;
  /** Unreadable saved-queue data blocks new club check-ins, as on the roster. */
  savedQueueUnreadable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [manualCode, setManualCode] = useState("");
  const [resolution, setResolution] = useState<PassResolution | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [checkingInId, setCheckingInId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionStateById, setActionStateById] = useState<
    Record<string, CheckInActionResult["status"]>
  >({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<ClubCheckInProgress | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanLoopRef = useRef<ScanLoop | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Bumped by every stop so a start that is still awaiting the camera or the
  // decoder can tell it was cancelled and release what it acquired.
  const startIdRef = useRef(0);
  const startPendingRef = useRef(false);
  // Escape closes through this same function (see useAccessibleDialog), so a
  // plain `bulkBusy || checkingInId` check in closeScanner would need those
  // state values fresh at keydown time. The ref keeps that guard correct
  // regardless of when the key fires mid bulk run.
  const bulkGuardRef = useRef({ bulkBusy: false, checkingInId: null as string | null });
  useEffect(() => {
    bulkGuardRef.current = { bulkBusy, checkingInId };
  }, [bulkBusy, checkingInId]);
  const dialogRef = useAccessibleDialog<HTMLElement>(open, closeScanner);

  function stopCamera(updateState = true) {
    startIdRef.current += 1;
    startPendingRef.current = false;
    scanLoopRef.current?.stop();
    scanLoopRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (updateState) setCameraState("idle");
  }

  function closeScanner() {
    // A bulk club run is in flight in the background even once the camera
    // and lookup are idle; closing mid-run would hide its progress and
    // summary. Escape reaches this through useAccessibleDialog's keydown
    // handler, so the check must read live state via the ref, not a stale
    // closure.
    if (bulkGuardRef.current.bulkBusy || bulkGuardRef.current.checkingInId) return;
    stopCamera(false);
    setOpen(false);
    setCameraState("idle");
    setResolution(null);
    setError("");
    setNotice("");
    setActionStateById({});
    setLookupBusy(false);
    setCheckingInId(null);
  }

  useEffect(() => () => {
    startIdRef.current += 1;
    scanLoopRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  // Phones keep the camera lit in the background; release it when the page
  // is hidden. Staff press "Start camera" again on return (a user gesture,
  // which iOS requires anyway).
  useEffect(() => {
    function onVisibilityChange() {
      if (
        document.visibilityState === "hidden"
        && (streamRef.current || startPendingRef.current)
      ) {
        stopCamera();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    // stopCamera only touches refs and a state setter.
  }, []);

  // Warm the jsQR chunk while the dialog is open so it is cached before the
  // camera starts. Failures are ignored here; only a real start reports
  // "decoder-failed", and a later start retries the import.
  useEffect(() => {
    if (!open) return;
    const Detector = (
      window as typeof window & { BarcodeDetector?: BarcodeDetectorConstructorLike }
    ).BarcodeDetector;
    void chooseQrDecoder(Detector)
      .then((choice) => (choice === "fallback" ? import("jsqr") : null))
      .catch(() => undefined);
  }, [open]);

  async function resolveLookup(
    kind: "pass" | "confirmation",
    value: string,
  ) {
    setLookupBusy(true);
    setResolution(null);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/attendee-passes/resolve`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind, value }),
        },
      );
      const payload = await response.json().catch(() => null) as {
        message?: string;
        resolution?: PassResolution;
      } | null;
      if (!response.ok || !payload?.resolution) {
        throw new Error(
          payload?.message ?? "The attendee pass could not be found.",
        );
      }
      setResolution(payload.resolution);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The attendee pass could not be found.",
      );
    } finally {
      setLookupBusy(false);
    }
  }

  async function handleScannedText(rawValue: string) {
    const token = extractAttendeePassToken(rawValue);
    if (!token) return false;
    stopCamera(false);
    setCameraState("idle");
    await resolveLookup("pass", token);
    return true;
  }

  async function startCamera() {
    stopCamera(false);
    setResolution(null);
    setError("");
    setCameraState("starting");
    const startId = startIdRef.current;
    startPendingRef.current = true;

    if (!navigator.mediaDevices?.getUserMedia) {
      startPendingRef.current = false;
      setCameraState("unsupported");
      return;
    }

    try {
      // getUserMedia is requested first, straight from the click handler, so
      // iOS Safari still sees the user gesture.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (startId !== startIdRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stopCamera(false);
        setCameraState("error");
        return;
      }
      video.muted = true;
      video.setAttribute("playsinline", "");
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Not a permission problem: show the generic camera error.
        if (startId === startIdRef.current) {
          stopCamera(false);
          setCameraState("error");
        }
        return;
      }
      if (startId !== startIdRef.current) return;

      const Detector = (
        window as typeof window & {
          BarcodeDetector?: BarcodeDetectorConstructorLike;
        }
      ).BarcodeDetector;
      const choice = await chooseQrDecoder(Detector);
      if (startId !== startIdRef.current) return;

      let decodeFrame: () => Promise<string | null>;
      if (choice === "native" && Detector) {
        const detector = new Detector({ formats: ["qr_code"] });
        decodeFrame = async () => {
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
          const codes = await detector.detect(video);
          return codes
            .map((code) => code.rawValue ?? "")
            .find((value) => extractAttendeePassToken(value)) ?? null;
        };
      } else {
        let jsQR: JsQrFunction;
        try {
          // Loaded only when the browser has no usable BarcodeDetector.
          jsQR = (await import("jsqr")).default as JsQrFunction;
        } catch {
          if (startId === startIdRef.current) {
            stopCamera(false);
            setCameraState("decoder-failed");
          }
          return;
        }
        if (startId !== startIdRef.current) return;
        decodeFrame = async () => {
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
          const size = downscaledSize(video.videoWidth, video.videoHeight);
          if (size.width === 0) return null;
          const canvas = canvasRef.current ?? document.createElement("canvas");
          canvasRef.current = canvas;
          if (canvas.width !== size.width) canvas.width = size.width;
          if (canvas.height !== size.height) canvas.height = size.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("Canvas is unavailable.");
          context.drawImage(video, 0, 0, size.width, size.height);
          const image = context.getImageData(0, 0, size.width, size.height);
          return decodeQrFromPixels(jsQR, image.data, size.width, size.height);
        };
      }

      startPendingRef.current = false;
      setCameraState("active");
      scanLoopRef.current = createScanLoop({
        tick: async () => {
          const rawValue = await decodeFrame();
          if (!rawValue || startId !== startIdRef.current) return false;
          return handleScannedText(rawValue);
        },
        onError: () => {
          if (startId !== startIdRef.current) return;
          stopCamera(false);
          setCameraState("error");
        },
      });
    } catch (caught) {
      if (startId !== startIdRef.current) return;
      stopCamera(false);
      const failure = classifyCameraError(caught);
      setCameraState(failure === "no-camera" ? "no-camera" : failure === "denied" ? "denied" : "error");
    }
  }

  function submitConfirmationCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    stopCamera();
    void resolveLookup("confirmation", manualCode);
  }

  async function confirmCheckIn(attendee: ResolvedAttendee) {
    if (attendee.checkedIn || bulkBusy) return;
    setCheckingInId(attendee.id);
    setError("");
    setNotice("");
    try {
      const result = await onConfirmCheckIn(attendee);
      setActionStateById((current) => ({
        ...current,
        [attendee.id]: result.status,
      }));
      if (result.status === "CONFIRMED") {
        const checkedInAt = result.checkedInAt ?? new Date().toISOString();
        setResolution((current) => current ? {
          ...current,
          attendees: current.attendees.map((entry) => (
            entry.id === attendee.id
              ? { ...entry, checkedIn: true, checkedInAt }
              : entry
          )),
        } : current);
        setNotice(result.message);
      } else if (result.status === "QUEUED") {
        setNotice(result.message);
      } else {
        setError(result.message);
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The attendee could not be checked in.",
      );
    } finally {
      setCheckingInId(null);
    }
  }

  async function confirmCheckInMany(attendeeIds: string[]) {
    if (bulkBusy || checkingInId) return;
    const attendeesById = new Map(
      (resolution?.attendees ?? []).map((attendee) => [attendee.id, attendee]),
    );
    const ids = attendeeIds.filter((attendeeId) => {
      const attendee = attendeesById.get(attendeeId);
      return attendee && !attendee.checkedIn;
    });
    if (ids.length === 0) return;
    setBulkBusy(true);
    setBulkProgress({ current: 0, total: ids.length });
    setError("");
    setNotice("");
    try {
      const outcome = await checkInSequentially(
        ids,
        (attendeeId) => onConfirmCheckIn(attendeesById.get(attendeeId)!),
        ({ current, total }) => setBulkProgress({ current, total }),
      );
      setActionStateById((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(outcome.perAttendee).map(
          ([attendeeId, result]) => [attendeeId, result.status],
        )),
      }));
      const confirmedAt = new Map(
        Object.entries(outcome.perAttendee)
          .filter(([, result]) => result.status === "CONFIRMED")
          .map(([attendeeId, result]) => [
            attendeeId,
            result.checkedInAt ?? new Date().toISOString(),
          ]),
      );
      setResolution((current) => current ? {
        ...current,
        attendees: current.attendees.map((entry) => (
          confirmedAt.has(entry.id)
            ? { ...entry, checkedIn: true, checkedInAt: confirmedAt.get(entry.id)! }
            : entry
        )),
      } : current);
      const summary = sequentialCheckInSummary(ids, outcome, (attendeeId) => {
        const attendee = attendeesById.get(attendeeId);
        return attendee ? `${attendee.firstName} ${attendee.lastName}` : "Unknown attendee";
      });
      if (outcome.needsReview > 0) setError(summary);
      else setNotice(summary);
    } finally {
      setBulkBusy(false);
      setBulkProgress(null);
    }
  }

  return (
    <>
      <button
        className="scan-card"
        type="button"
        onClick={() => {
          setManualCode("");
          setResolution(null);
          setError("");
          setNotice("");
          setActionStateById({});
          setOpen(true);
        }}
      >
        <QrCode aria-hidden="true" size={30} />
        <span>
          <strong>Scan or enter an event pass</strong>
          <small>Review first; offline actions stay visibly queued</small>
        </span>
      </button>

      {open && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget
              && !lookupBusy
              && !checkingInId
              && !bulkBusy
            ) {
              closeScanner();
            }
          }}
        >
          <section
            aria-describedby="check-in-scanner-description"
            aria-labelledby="check-in-scanner-title"
            aria-modal="true"
            className="modal-card check-in-scanner-modal"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">Staff check-in</p>
                <h2 id="check-in-scanner-title">Scan an attendee pass</h2>
              </div>
              <button
                aria-label="Close attendee pass scanner"
                className="icon-button"
                disabled={Boolean(checkingInId) || bulkBusy}
                onClick={closeScanner}
                type="button"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </div>
            <p className="check-in-scanner-description" id="check-in-scanner-description">
              Scanning only finds the attendee. Nothing is checked in until a
              staff member reviews the result and selects “Confirm check-in.”
            </p>

            <section className="check-in-camera-panel" aria-label="Camera scanner">
              <div className={`check-in-video-frame is-${cameraState}`}>
                <video
                  aria-label="Live camera preview for attendee QR codes"
                  muted
                  playsInline
                  ref={videoRef}
                />
                {cameraState !== "active" && (
                  <div className="check-in-video-placeholder">
                    {cameraState === "starting"
                      ? <LoaderCircle className="is-spinning" size={31} aria-hidden="true" />
                      : cameraState === "denied"
                        || cameraState === "unsupported"
                        || cameraState === "no-camera"
                        || cameraState === "decoder-failed"
                        || cameraState === "error"
                        ? <CameraOff size={31} aria-hidden="true" />
                        : <Camera size={31} aria-hidden="true" />}
                    <strong>
                      {cameraState === "starting"
                        ? "Starting camera…"
                        : cameraMessage(cameraState) || "Camera is off"}
                    </strong>
                  </div>
                )}
                {cameraState === "active" && (
                  <span className="check-in-scan-guide" aria-hidden="true" />
                )}
              </div>
              <div className="check-in-camera-actions">
                {cameraState === "active" ? (
                  <button
                    className="secondary-button"
                    onClick={() => stopCamera()}
                    type="button"
                  >
                    <CameraOff size={17} aria-hidden="true" />
                    Stop camera
                  </button>
                ) : (
                  <button
                    className={resolution ? "secondary-button" : "primary-button"}
                    disabled={cameraState === "starting" || lookupBusy}
                    onClick={() => void startCamera()}
                    type="button"
                  >
                    <Camera size={17} aria-hidden="true" />
                    {cameraState === "starting" ? "Starting…" : "Start camera"}
                  </button>
                )}
                {cameraState === "active" && (
                  <span role="status">Point the camera at one IMSDA attendee QR pass.</span>
                )}
              </div>
              {cameraMessage(cameraState) && (
                <p className="check-in-camera-warning" role="status">
                  <AlertTriangle size={16} aria-hidden="true" />
                  {cameraMessage(cameraState)}
                </p>
              )}
            </section>

            <div className="check-in-scanner-divider">
              <span>or use a confirmation code</span>
            </div>

            <form
              className="check-in-manual-form"
              onSubmit={submitConfirmationCode}
            >
              <label>
                <span>
                  <Keyboard size={16} aria-hidden="true" />
                  Registration confirmation code
                </span>
                <input
                  autoCapitalize="characters"
                  autoComplete="off"
                  maxLength={80}
                  onChange={(event) => setManualCode(event.target.value)}
                  placeholder="REG-1234ABCD"
                  required
                  spellCheck={false}
                  value={manualCode}
                />
              </label>
              <button
                className="secondary-button"
                disabled={lookupBusy || !manualCode.trim()}
                type="submit"
              >
                {lookupBusy
                  ? <LoaderCircle className="is-spinning" size={16} aria-hidden="true" />
                  : <QrCode size={16} aria-hidden="true" />}
                {lookupBusy ? "Looking up…" : "Find registration"}
              </button>
            </form>

            {error && (
              <div className="inline-notice error check-in-scanner-error" role="alert">
                <AlertTriangle size={17} aria-hidden="true" />
                {error}
              </div>
            )}

            {notice && (
              <div className="inline-notice check-in-scanner-error" role="status">
                {notice}
              </div>
            )}

            {resolution && clubsByConfirmationCode[resolution.confirmationCode] && (
              // Q1 (#412): a club's confirmation code opens the same club view
              // a name search finds. A member's own QR pass opens it too, but
              // with that person highlighted and their single check-in as the
              // primary action; the whole club is an explicit extra choice.
              <ClubCheckInPanel
                amountOwedCents={clubsByConfirmationCode[resolution.confirmationCode].amountOwedCents}
                attendees={resolution.attendees.map((attendee) => ({
                  id: attendee.id,
                  firstName: attendee.firstName,
                  lastName: attendee.lastName,
                  attendeeType: attendee.attendeeType,
                  checkedIn: attendee.checkedIn || actionStateById[attendee.id] === "CONFIRMED",
                  backgroundFlagged: backgroundFlaggedAttendeeIds.includes(attendee.id),
                  savedState: conflictAttendeeIds.includes(attendee.id)
                    ? "CONFLICT"
                    : queuedAttendeeIds.includes(attendee.id)
                      ? "QUEUED"
                      : undefined,
                  lastResult: actionStateById[attendee.id],
                }))}
                busy={bulkBusy || Boolean(checkingInId)}
                canCheckIn
                confirmationCode={resolution.confirmationCode}
                headingLevel={3}
                onCheckInMany={confirmCheckInMany}
                onCheckInScanned={(attendeeId) => {
                  const attendee = resolution.attendees.find((entry) => entry.id === attendeeId);
                  if (attendee) return confirmCheckIn(attendee);
                }}
                organizationName={clubsByConfirmationCode[resolution.confirmationCode].organizationName}
                progress={bulkProgress}
                savedQueueUnreadable={savedQueueUnreadable}
                scannedAttendeeId={resolution.source === "QR_PASS" ? resolution.scannedAttendeeId : undefined}
              />
            )}

            {resolution && !clubsByConfirmationCode[resolution.confirmationCode] && (
              <section
                aria-labelledby="check-in-review-title"
                className="check-in-review"
              >
                <div className="check-in-review-heading">
                  <span><ShieldCheck size={20} aria-hidden="true" /></span>
                  <div>
                    <p className="eyebrow">Visible staff confirmation</p>
                    <h3 id="check-in-review-title">Review before check-in</h3>
                    <p>
                      <span translate="no">{resolution.confirmationCode}</span> ·{" "}
                      {resolution.source === "QR_PASS"
                        ? "signed QR pass"
                        : "confirmation-code lookup"}
                    </p>
                    {paymentDueByConfirmationCode[resolution.confirmationCode] && (
                      <CheckInPaymentDue
                        balanceCents={paymentDueByConfirmationCode[resolution.confirmationCode].balanceCents}
                        confirmationCode={resolution.confirmationCode}
                        partySize={paymentDueByConfirmationCode[resolution.confirmationCode].partySize}
                      />
                    )}
                  </div>
                </div>
                <div className="check-in-review-list">
                  {resolution.attendees.map((attendee) => {
                    const savedState = actionStateById[attendee.id]
                      ?? (conflictAttendeeIds.includes(attendee.id)
                        ? "CONFLICT"
                        : queuedAttendeeIds.includes(attendee.id)
                          ? "QUEUED"
                          : undefined);
                    return (
                      <article key={attendee.id}>
                        <span className={`person-avatar ${attendee.checkedIn ? "green" : "purple"}`}>
                          {attendee.firstName[0]}{attendee.lastName[0]}
                        </span>
                        <div>
                          <strong translate="no">{attendee.firstName} {attendee.lastName}</strong>
                          <small>{attendeeTypeLabel(attendee.attendeeType)}</small>
                          {backgroundFlaggedAttendeeIds.includes(attendee.id) && <BackgroundCheckBadge />}
                        </div>
                        {attendee.checkedIn || savedState === "CONFIRMED" ? (
                          <span className="check-in-already">
                            <CheckCircle2 size={16} aria-hidden="true" />
                            Checked in
                          </span>
                        ) : savedState === "QUEUED" ? (
                          <span className="check-in-queued">
                            <RefreshCw size={16} aria-hidden="true" />
                            Queued — not confirmed
                          </span>
                        ) : (
                          <button
                            className="primary-button"
                            disabled={Boolean(checkingInId)}
                            onClick={() => void confirmCheckIn(attendee)}
                            type="button"
                          >
                            <CheckCircle2 size={16} aria-hidden="true" />
                            {checkingInId === attendee.id
                              ? "Checking in…"
                              : savedState === "CONFLICT"
                                ? "Retry check-in"
                                : "Confirm check-in"}
                          </button>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </section>
        </div>
      )}
    </>
  );
}
