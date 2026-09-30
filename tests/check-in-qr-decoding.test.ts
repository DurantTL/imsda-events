import jsQR from "jsqr";
import QRCode from "qrcode";
import { describe, expect, it, vi } from "vitest";
import { extractAttendeePassToken } from "@/components/check-in-scanner";
import {
  chooseQrDecoder,
  classifyCameraError,
  createScanLoop,
  decodeQrFromPixels,
  downscaledSize,
  type JsQrFunction,
} from "@/components/check-in-qr-decoding";

const SYNTHETIC_TOKEN = "imsda-pass.v1.synthetic-payload.synthetic-signature";

/** Render a QR into an RGBA pixel array from qrcode's module matrix. */
function qrPixels(text: string, scale = 6, quiet = 4) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const modules = qr.modules.size;
  const side = (modules + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!qr.modules.get(row, col)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const px = ((row + quiet) * scale + y) * side + (col + quiet) * scale + x;
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

class FakeDetector {
  static formats: string[] = ["qr_code"];
  static getSupportedFormats() {
    return Promise.resolve(FakeDetector.formats);
  }
  detect() {
    return Promise.resolve([]);
  }
}

describe("decoder choice", () => {
  it("falls back when BarcodeDetector is missing", async () => {
    expect(await chooseQrDecoder(undefined)).toBe("fallback");
  });

  it("uses the native detector when it supports qr_code", async () => {
    FakeDetector.formats = ["ean_13", "qr_code"];
    expect(await chooseQrDecoder(FakeDetector)).toBe("native");
  });

  it("falls back when qr_code is not a supported format", async () => {
    FakeDetector.formats = ["ean_13"];
    expect(await chooseQrDecoder(FakeDetector)).toBe("fallback");
  });

  it("falls back when getSupportedFormats rejects", async () => {
    const Broken = Object.assign(class {
      detect() { return Promise.resolve([]); }
    }, { getSupportedFormats: () => Promise.reject(new Error("nope")) });
    expect(await chooseQrDecoder(Broken)).toBe("fallback");
  });

  it("probes by construction when getSupportedFormats is absent", async () => {
    const Legacy = class { detect() { return Promise.resolve([]); } };
    const Throwing = class {
      constructor() { throw new TypeError("unsupported"); }
      detect() { return Promise.resolve([]); }
    };
    expect(await chooseQrDecoder(Legacy)).toBe("native");
    expect(await chooseQrDecoder(Throwing)).toBe("fallback");
  });
});

describe("fallback decoding", () => {
  it("decodes a synthetic QR image into an attendee pass token", () => {
    const { data, width, height } = qrPixels(SYNTHETIC_TOKEN);
    const text = decodeQrFromPixels(jsQR as JsQrFunction, data, width, height);
    expect(text).toBe(SYNTHETIC_TOKEN);
    expect(extractAttendeePassToken(text ?? "")).toBe(SYNTHETIC_TOKEN);
  });

  it("decodes a check-in URL QR and still extracts only the pass token", () => {
    const url = `https://events.example.test/check-in?event=evt_1&pass=${SYNTHETIC_TOKEN}`;
    const { data, width, height } = qrPixels(url);
    const text = decodeQrFromPixels(jsQR as JsQrFunction, data, width, height);
    expect(extractAttendeePassToken(text ?? "")).toBe(SYNTHETIC_TOKEN);
  });

  it("does not turn a confirmation code or unrelated QR into a token", () => {
    for (const content of ["REG-1234ABCD", "https://untrusted.example/x"]) {
      const { data, width, height } = qrPixels(content);
      const text = decodeQrFromPixels(jsQR as JsQrFunction, data, width, height);
      expect(text).toBe(content);
      expect(extractAttendeePassToken(text ?? "")).toBeNull();
    }
  });

  it("returns null for a blank frame", () => {
    const data = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    expect(decodeQrFromPixels(jsQR as JsQrFunction, data, 64, 64)).toBeNull();
  });
});

describe("frame downscaling", () => {
  it("limits the longest side to about 640px and keeps aspect ratio", () => {
    expect(downscaledSize(1280, 720)).toEqual({ width: 640, height: 360 });
    expect(downscaledSize(720, 1280)).toEqual({ width: 360, height: 640 });
  });
  it("never upscales and handles an empty video", () => {
    expect(downscaledSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(downscaledSize(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("scan loop", () => {
  it("never overlaps ticks and waits out the interval", async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let maxActive = 0;
      let calls = 0;
      const loop = createScanLoop({
        intervalMs: 100,
        tick: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          calls += 1;
          // Slower than the interval: the next tick must still wait.
          await new Promise((resolve) => setTimeout(resolve, 250));
          active -= 1;
        },
      });
      await vi.advanceTimersByTimeAsync(1000);
      loop.stop();
      expect(maxActive).toBe(1);
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(calls).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles fast ticks to about the configured rate", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const loop = createScanLoop({ intervalMs: 110, tick: () => { calls += 1; } });
      await vi.advanceTimersByTimeAsync(1000);
      loop.stop();
      expect(calls).toBeGreaterThanOrEqual(8);
      expect(calls).toBeLessThanOrEqual(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after a tick returns true, after stop(), and reports errors", async () => {
    vi.useFakeTimers();
    try {
      let doneCalls = 0;
      createScanLoop({ tick: () => { doneCalls += 1; return true; } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(doneCalls).toBe(1);

      let stoppedCalls = 0;
      const loop = createScanLoop({ tick: () => { stoppedCalls += 1; } });
      await vi.advanceTimersByTimeAsync(300);
      loop.stop();
      const atStop = stoppedCalls;
      await vi.advanceTimersByTimeAsync(1000);
      expect(stoppedCalls).toBe(atStop);

      const onError = vi.fn();
      let errorCalls = 0;
      createScanLoop({
        tick: () => { errorCalls += 1; throw new Error("boom"); },
        onError,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(errorCalls).toBe(1);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("camera error classification", () => {
  it("separates permission denied, no camera, and other failures", () => {
    expect(classifyCameraError({ name: "NotAllowedError" })).toBe("denied");
    expect(classifyCameraError({ name: "SecurityError" })).toBe("denied");
    expect(classifyCameraError({ name: "NotFoundError" })).toBe("no-camera");
    expect(classifyCameraError({ name: "NotReadableError" })).toBe("error");
    expect(classifyCameraError(new Error("x"))).toBe("error");
  });
});
