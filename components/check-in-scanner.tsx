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
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import type { CheckInActionResult } from "@/components/use-offline-check-in-queue";

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
};

type CameraState =
  | "idle"
  | "starting"
  | "active"
  | "unsupported"
  | "denied"
  | "error";

type DetectedBarcode = { rawValue?: string };
type BarcodeDetectorInstance = {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
};
type BarcodeDetectorConstructor = new (
  options: { formats: string[] },
) => BarcodeDetectorInstance;

export function extractAttendeePassToken(value: string) {
  const candidate = value.trim();
  if (candidate.startsWith("imsda-pass.v1.")) return candidate;
  try {
    const parsed = new URL(candidate);
    const pass = parsed.searchParams.get("pass")?.trim() ?? "";
    return pass.startsWith("imsda-pass.v1.") ? pass : null;
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
}: {
  eventId: string;
  onConfirmCheckIn: (
    attendee: ResolvedAttendee,
  ) => Promise<CheckInActionResult>;
  queuedAttendeeIds: string[];
  conflictAttendeeIds: string[];
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const scanLoopActiveRef = useRef(false);
  const detectingRef = useRef(false);
  const dialogRef = useAccessibleDialog<HTMLElement>(open, closeScanner);

  function stopCamera(updateState = true) {
    scanLoopActiveRef.current = false;
    detectingRef.current = false;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (updateState) setCameraState("idle");
  }

  function closeScanner() {
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
    scanLoopActiveRef.current = false;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

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

  async function scanFrames(detector: BarcodeDetectorInstance) {
    if (!scanLoopActiveRef.current) return;
    const video = videoRef.current;
    if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      detectingRef.current = true;
      try {
        const codes = await detector.detect(video);
        const token = codes
          .map((code) => extractAttendeePassToken(code.rawValue ?? ""))
          .find((value): value is string => Boolean(value));
        if (token) {
          stopCamera(false);
          setCameraState("idle");
          await resolveLookup("pass", token);
          return;
        }
      } catch {
        stopCamera(false);
        setCameraState("error");
        return;
      } finally {
        detectingRef.current = false;
      }
    }
    if (scanLoopActiveRef.current) {
      animationFrameRef.current = requestAnimationFrame(
        () => void scanFrames(detector),
      );
    }
  }

  async function startCamera() {
    stopCamera(false);
    setResolution(null);
    setError("");
    setCameraState("starting");

    const Detector = (
      window as typeof window & {
        BarcodeDetector?: BarcodeDetectorConstructor;
      }
    ).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setCameraState("unsupported");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      if (!videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        setCameraState("error");
        return;
      }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      const detector = new Detector({ formats: ["qr_code"] });
      scanLoopActiveRef.current = true;
      setCameraState("active");
      void scanFrames(detector);
    } catch (caught) {
      stopCamera(false);
      const denied = caught instanceof DOMException
        && (caught.name === "NotAllowedError" || caught.name === "SecurityError");
      setCameraState(denied ? "denied" : "error");
    }
  }

  function submitConfirmationCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    stopCamera();
    void resolveLookup("confirmation", manualCode);
  }

  async function confirmCheckIn(attendee: ResolvedAttendee) {
    if (attendee.checkedIn) return;
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
                disabled={Boolean(checkingInId)}
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
                    className="primary-button"
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

            {resolution && (
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
                      {resolution.confirmationCode} ·{" "}
                      {resolution.source === "QR_PASS"
                        ? "signed QR pass"
                        : "confirmation-code lookup"}
                    </p>
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
                          <strong>{attendee.firstName} {attendee.lastName}</strong>
                          <small>{attendeeTypeLabel(attendee.attendeeType)}</small>
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
