/**
 * Pure helpers for the check-in scanner (#690): choosing between the native
 * BarcodeDetector and the lazily loaded jsQR fallback, downscaling frames,
 * and a throttled, non-overlapping scan loop. No React, no DOM access beyond
 * what callers pass in, so everything here is unit-testable.
 */

export type DecoderChoice = "native" | "fallback";

export type BarcodeDetectorLike = {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
};
export type BarcodeDetectorConstructorLike = {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

/** Use the native detector only when it exists and supports qr_code. */
export async function chooseQrDecoder(
  Detector: BarcodeDetectorConstructorLike | undefined | null,
): Promise<DecoderChoice> {
  if (!Detector) return "fallback";
  if (typeof Detector.getSupportedFormats === "function") {
    try {
      const formats = await Detector.getSupportedFormats();
      return formats.includes("qr_code") ? "native" : "fallback";
    } catch {
      return "fallback";
    }
  }
  // Older implementations lack getSupportedFormats; constructing with
  // qr_code throws when it is unsupported.
  try {
    new Detector({ formats: ["qr_code"] });
    return "native";
  } catch {
    return "fallback";
  }
}

export const FALLBACK_MAX_SIDE = 640;
export const SCAN_INTERVAL_MS = 110; // about 9 frames per second

/** Scale so the longest side is at most maxSide; never upscale. */
export function downscaledSize(
  width: number,
  height: number,
  maxSide = FALLBACK_MAX_SIDE,
) {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= maxSide) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type JsQrFunction = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: {
    inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst";
  },
) => { data: string } | null;

/** Decode one RGBA frame; returns the raw QR text or null. */
export function decodeQrFromPixels(
  jsQR: JsQrFunction,
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  const result = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
  return result?.data ?? null;
}

export type ScanLoop = { stop(): void };

/**
 * Runs `tick` repeatedly, never starting a tick until the previous one has
 * finished, and never more often than once per `intervalMs`. A tick that
 * returns true ends the loop; a thrown error ends it and calls `onError`.
 */
export function createScanLoop(options: {
  tick: () => Promise<boolean | void> | boolean | void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): ScanLoop {
  const intervalMs = options.intervalMs ?? SCAN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer
    ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let stopped = false;
  let running = false;
  let handle: unknown = null;

  async function run() {
    handle = null;
    if (stopped || running) return;
    running = true;
    const startedAt = now();
    let finished = false;
    try {
      finished = Boolean(await options.tick());
    } catch (error) {
      stopped = true;
      running = false;
      options.onError?.(error);
      return;
    }
    running = false;
    if (finished || stopped) {
      stopped = true;
      return;
    }
    const elapsed = now() - startedAt;
    handle = setTimer(() => void run(), Math.max(0, intervalMs - elapsed));
  }

  handle = setTimer(() => void run(), 0);
  return {
    stop() {
      stopped = true;
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
  };
}

export type ScannerCameraFailure = "denied" | "no-camera" | "error";

export function classifyCameraError(error: unknown): ScannerCameraFailure {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
  if (
    name === "NotAllowedError"
    || name === "SecurityError"
    || name === "PermissionDeniedError"
  ) {
    return "denied";
  }
  if (
    name === "NotFoundError"
    || name === "OverconstrainedError"
    || name === "DevicesNotFoundError"
  ) {
    return "no-camera";
  }
  return "error";
}
